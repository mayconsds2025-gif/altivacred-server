// -------------- imports ------------------
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import axios from "axios";
import https from "https";
import dayjs from "dayjs";


import { authenticateV8 } from "./services/v8Auth.js";
import { iniciarSessaoPresenca } from "./services/presencaLogin.js";
import { configurarPropostaC6 } from "./services/c6Proposta.js";
import { criarOperacaoCLT } from "./services/presencaProposta.js";
import { authenticateSaque } from "./services/saqueAuth.js";
import uploadRoutes from "./services/uploads.js";


import {
  criarTermo,
  consultarVinculo,
  consultarMargem,
  simularTabelas
} from "./services/presencaTermo.js";

dotenv.config();

console.log("[INIT] Iniciando servidor...");
console.log("[ENV] PRESENCA_LOGIN:", process.env.PRESENCA_LOGIN ? "OK" : "AUSENTE");
console.log("[ENV] PRESENCA_PASSWORD:", process.env.PRESENCA_PASSWORD ? "OK" : "AUSENTE");
const httpsAgent = new https.Agent({
  checkServerIdentity: () => undefined,
  rejectUnauthorized: false,
});

const app = express();
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use(cors({


  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use("/upload", uploadRoutes);
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT"].includes(req.method)) console.log("[REQ BODY]", req.body);
  next();
});
function formatarDataISO(dt) {
  if (!dt) return "";

  const clean = dt.replace(/\D/g, "");

  // dd/mm/yyyy → yyyy-mm-dd
  if (clean.length === 8 && dt.includes("/")) {
    const dia = clean.substring(0, 2);
    const mes = clean.substring(2, 4);
    const ano = clean.substring(4, 8);
    return `${ano}-${mes}-${dia}`;
  }

  // yyyy-mm-dd permanece igual
  if (clean.length === 8 && dt.includes("-")) {
    return dt;
  }

  return dt;
}
function corrigirTelefone(phone) {
  let p = phone.replace(/\D/g, ""); // remove máscara

  // Se vier com 10 dígitos, insere o 9 depois do DDD
  if (p.length === 10) {
    return p.slice(0, 2) + "9" + p.slice(2);
  }

  // Se vier certo (11 dígitos), apenas retorna
  if (p.length === 11) {
    return p;
  }

  // Em qualquer outro caso retorna sem alterar
  return p;
}


// -------------------- MYSQL --------------------
console.log("[MYSQL] Criando pool de conexões...");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4", // <-- ESSENCIAL
});


// -------------------- TABELAS --------------------
(async () => {
  console.log("[MYSQL] Verificando tabelas...");

  await pool.query(`
CREATE TABLE IF NOT EXISTS usuarios (
  cpf VARCHAR(14),
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(120) PRIMARY KEY,
  telefone VARCHAR(20),
  data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`.trim());

  // Adicionando a tabela 'progresso_proposta' que estava faltando
  await pool.query(`
CREATE TABLE IF NOT EXISTS progresso_proposta (
  email VARCHAR(120) PRIMARY KEY,
  cpf VARCHAR(14),
  etapa INT DEFAULT 1,
  dados JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
`.trim());

  console.log("[MYSQL] Tabelas OK");
})();
// -------------------- TABELAS FGTS --------------------
(async () => {
  console.log("[MYSQL][FGTS] Verificando tabelas FGTS...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fgts_consultas (
      id VARCHAR(60) PRIMARY KEY,
      cpf VARCHAR(14),
      provider VARCHAR(20),
      status VARCHAR(20),
      amount DECIMAL(12,2),
      payload JSON,
      periods JSON,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `.trim());

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fgts_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      etapa VARCHAR(80),
      cpf VARCHAR(14),
      provider VARCHAR(20),
      payload JSON,
      response JSON,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `.trim());

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fgts_propostas (
      id VARCHAR(60) PRIMARY KEY,
      cpf VARCHAR(14),
      simulationId VARCHAR(60),
      simulationFeesId VARCHAR(60),
      availableBalance DECIMAL(12,2),
      formalizationLink VARCHAR(255),
      payload JSON,
      response JSON,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `.trim());

  console.log("[MYSQL][FGTS] Tabelas criadas.");
})();
async function salvarLogFGTS(etapa, cpf, provider, payload, response) {
  try {
    await pool.query(
      `INSERT INTO fgts_logs (etapa, cpf, provider, payload, response)
       VALUES (?, ?, ?, ?, ?)`,
      [etapa, cpf, provider, JSON.stringify(payload || {}), JSON.stringify(response || {})]
    );
  } catch (err) {
    console.log("[FGTS][LOG][ERRO]", err);
  }
}
// ============================================================================
//                                ROTAS FGTS (V8)
// ============================================================================

// ---------------- TOKEN V8 ----------------
async function getV8Token() {
  try {
    console.log("\n🔵 [V8][TOKEN] Solicitando token...");
    const resp = await authenticateV8();

    console.log("🟩 [V8][TOKEN] Token recebido (prefixo):", resp?.token?.substring(0, 15));
    return resp?.token || null;

  } catch (e) {
    console.log("🟥 [V8][TOKEN][ERRO]:", e?.response?.data || e);
    return null;
  }
}
app.post("/presenca/consultar-margem-pos-termo", async (req, res) => {
  try {
    let { cpf } = req.body;

    if (!cpf) {
      return res.status(400).json({
        sucesso: false,
        erro: "CPF obrigatório"
      });
    }

    cpf = String(cpf).replace(/\D/g, "");
    if (cpf.length !== 11) {
      return res.status(400).json({
        sucesso: false,
        erro: "CPF inválido"
      });
    }

    console.log("🔎 CPF normalizado:", cpf);

    // =========================================================
    // 1️⃣ LOGIN
    // =========================================================
    const loginResp = await axios.post(
      "https://presenca-bank-api.azurewebsites.net/login",
      {
        login: process.env.PRESENCA_LOGIN,
        senha: process.env.PRESENCA_PASSWORD
      },
      { httpsAgent }
    );

    const token = loginResp.data?.token;

    if (!token) {
      return res.status(500).json({
        sucesso: false,
        erro: "Falha ao obter token"
      });
    }

    console.log("✅ Login OK");

    // =========================================================
    // 2️⃣ AGUARDAR PROCESSAMENTO DO TERMO
    // =========================================================
    await new Promise(r => setTimeout(r, 3000));

    // =========================================================
    // 3️⃣ POLLING
    // =========================================================
    async function pollingMargem(tentativas = 7, intervalo = 3000) {

      for (let i = 1; i <= tentativas; i++) {
        console.log(`🔁 Tentativa ${i}/${tentativas}`);

        try {
          // ---------------------------------------------
          // CONSULTAR VÍNCULOS (CORRETO: resp.data.id)
          // ---------------------------------------------
          const vinculoResp = await axios.post(
            "https://presenca-bank-api.azurewebsites.net/v3/operacoes/consignado-privado/consultar-vinculos",
            { cpf },
            {
              headers: { Authorization: `Bearer ${token}` },
              httpsAgent
            }
          );

          const vinculos = vinculoResp.data?.id || [];

          if (!Array.isArray(vinculos) || !vinculos.length) {
            console.log("⚠️ Nenhum vínculo ainda");
            await new Promise(r => setTimeout(r, intervalo));
            continue;
          }

          const v =
            vinculos.find(v => v.elegivel === true) ||
            vinculos[0];

          if (!v?.matricula || !v?.numeroInscricaoEmpregador) {
            console.log("⚠️ Vínculo incompleto");
            await new Promise(r => setTimeout(r, intervalo));
            continue;
          }

          // ---------------------------------------------
          // CONSULTAR MARGEM (CORRETO: objeto direto)
          // ---------------------------------------------
          const margemResp = await axios.post(
            "https://presenca-bank-api.azurewebsites.net/v3/operacoes/consignado-privado/consultar-margem",
            {
              cpf,
              matricula: v.matricula,
              cnpj: v.numeroInscricaoEmpregador
            },
            {
              headers: { Authorization: `Bearer ${token}` },
              httpsAgent
            }
          );

          const margem = margemResp.data;

          if (!margem) {
            console.log("⚠️ Margem vazia");
            await new Promise(r => setTimeout(r, intervalo));
            continue;
          }

          const valorMargem =
            margem.valorMargemDisponivel ??
            margem.valorMargem ??
            0;

          if (valorMargem <= 0) {
            console.log("⚠️ Margem ainda zerada");
            await new Promise(r => setTimeout(r, intervalo));
            continue;
          }

          if (!margem.dataAdmissao) {
            console.log("⚠️ Sem data de admissão");
            await new Promise(r => setTimeout(r, intervalo));
            continue;
          }

          return margem;

        } catch (err) {
          console.log("❌ Erro na tentativa:", err.message);
          await new Promise(r => setTimeout(r, intervalo));
        }
      }

      return null;
    }

    const margem = await pollingMargem();

    if (!margem) {
      console.log("❌ Margem não encontrada após polling");
      return res.json({
        sucesso: true,
        margem: null,
        tempoServicoDias: null
      });
    }

    // =========================================================
    // 4️⃣ CALCULAR TEMPO DE SERVIÇO
    // =========================================================
    const tempoServicoDias = dayjs().diff(
      dayjs(margem.dataAdmissao),
      "day"
    );

    const margemDisponivel =
      margem.valorMargemDisponivel ??
      margem.valorMargem ??
      null;

    console.log("✅ Margem encontrada:", margemDisponivel);

    return res.json({
      sucesso: true,
      margem: margemDisponivel,
      tempoServicoDias
    });

  } catch (err) {
    console.error("[CONSULTAR-MARGEM-POS-TERMO]", err.response?.data || err);
    return res.status(500).json({
      sucesso: false,
      erro: err.response?.data || err.message
    });
  }
});



// ============================================================================
// 1) INICIAR CONSULTA DE SALDO (POST /fgts/iniciar)
// ============================================================================
// ============================================================================
//                                ROTAS FGTS (V8) COM LOGS PREMIUM
// ====================================================


// ============================================================================
// 1) INICIAR CONSULTA FGTS
// ============================================================================
app.post("/fgts/iniciar", async (req, res) => {
  const { cpf } = req.body;

  try {
    const token = await getV8Token();
    if (!token)
      return res
        .status(500)
        .json({ sucesso: false, erro: "Token V8 ausente" });

    const payload = {
      documentNumber: cpf.replace(/\D/g, ""),
      provider: "bms"  // ✔ obrigatório
    };

    console.log("\n🟦 [FGTS][INICIAR] Payload enviado:");
    console.log(JSON.stringify(payload, null, 2));

    const resp = await axios.post(
      "https://bff.v8sistema.com/fgts/balance",
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("🟩 [FGTS][INICIAR] RESPOSTA V8:", resp.data);

    await salvarLogFGTS("INICIAR_CONSULTA", cpf, "bms", payload, resp.data);

    return res.json({
      sucesso: true,
      mensagem: "Consulta iniciada. Aguarde retorno via webhook."
    });

  } catch (err) {
    console.log("🟥 [FGTS][INICIAR ERRO]");
    console.log(err?.response?.data || err);

    await salvarLogFGTS(
      "INICIAR_CONSULTA_ERRO",
      cpf,
      "bms",
      req.body,
      err?.response?.data || err
    );

    return res.status(400).json({
      sucesso: false,
      erro: err?.response?.data?.detail || err.message
    });
  }
});


// ============================================================================
// 2) WEBHOOK FGTS
// ============================================================================
app.post("/fgts/webhook", async (req, res) => {
  try {
    console.log("\n🟧 [FGTS][WEBHOOK] Recebido:");
    console.log(JSON.stringify(req.body, null, 2));

    const data = req.body;
    const provider = data?.provider?.toLowerCase() || "bms";

    await salvarLogFGTS("WEBHOOK", data.documentNumber, provider, data, {});

    const tipo = data?.type || "";
    const cpf = data?.documentNumber || null;

    if (tipo.includes("success")) {

      console.log("🟩 [FGTS][WEBHOOK] SUCESSO para CPF:", cpf);[
    {
        "id": 4367,
        "name": "Maycon Souza Da Silva",
        "email": "cliente.teste@email.com",
        "mobile": "11988887777",
        "mother_name": "Maria Ferreira da Silva",
        "father_name": "José Ferreira da Silva",
        "birth_date": "1997-05-14",
        "address": {
            "id": 12070,
            "zip_code": "05350000",
            "street": "Avenida Escola Politécnica",
            "number": "2200",
            "district": "Rio Pequeno",
            "complement": "",
            "active": "yes",
            "country": "BRA",
            "city": "São Paulo",
            "state": "SP",
            "lat": null,
            "tong": null,
            "created_at": "2026-01-09T09:22:50.650-03:00",
            "updated_at": "2026-01-09T09:22:50.650-03:00",
            "entity_id": 12138,
            "deleted_at": null,
            "imported_id": null
        },
        "contacts": [],
        "cpf_cnpj": "44935512830",
        "blacklist": false,
        "bank_account": null,
        "rg": "123456789",
        "emission_rg": null,
        "civil_state": null,
        "marital_status": "single",
        "gender_customer": "male",
        "reference_name": null,
        "reference_ddd": null,
        "reference_phone": null,
        "entity": {
            "id": 12138,
            "cpf_cnpj": "44935512830",
            "name": "Maycon Souza da Silva",
            "social_reason": null,
            "has_commission": null,
            "address": {
                "id": 12070,
                "zip_code": "05350000",
                "street": "Avenida Escola Politécnica",
                "number": "2200",
                "district": "Rio Pequeno",
                "complement": "",
                "active": "yes",
                "country": "BRA",
                "city": "São Paulo",
                "state": "SP",
                "lat": null,
                "tong": null,
                "created_at": "2026-01-09T09:22:50.650-03:00",
                "updated_at": "2026-01-09T09:22:50.650-03:00",
                "entity_id": 12138,
                "deleted_at": null,
                "imported_id": null
            },
            "bank_account": null,
            "contacts": [],
            "commission_bases": [],
            "commissions": [],
            "commission_bases_report": [],
            "kind": null,
            "commission_fgts": null,
            "fgts_has_commission": null,
            "fgts_commissions": [],
            "has_cdc_commission": false,
            "has_secure": true,
            "has_uy3_create": false,
            "has_fgts_create": false,
            "commission_clt": null,
            "has_clt_create": null,
            "clt_has_commission": null,
            "clt_commissions": [],
            "has_cdc_create": true,
            "has_credit_create": true,
            "product": "NSG",
            "product_cdc": "NSG",
            "product_fgts": "NSG",
            "periodicity": null,
            "periodicity_fgts": null,
            "periodicity_cdc": null,
            "blacklist": false
        }
    },
    {
        "id": 4368,
        "name": "Vinicius Souza Da Silva",
        "email": "cliente.teste@email.com",
        "mobile": "11988887777",
        "mother_name": "Maria Ferreira da Silva",
        "father_name": "José Ferreira da Silva",
        "birth_date": "1997-05-14",
        "address": {
            "id": 12099,
            "zip_code": "05350000",
            "street": "Avenida Escola Politécnica",
            "number": "2200",
            "district": "Rio Pequeno",
            "complement": "",
            "active": "yes",
            "country": "BRA",
            "city": "São Paulo",
            "state": "SP",
            "lat": null,
            "tong": null,
            "created_at": "2026-01-09T12:45:11.426-03:00",
            "updated_at": "2026-01-09T12:45:11.426-03:00",
            "entity_id": 12167,
            "deleted_at": null,
            "imported_id": null
        },
        "contacts": [],
        "cpf_cnpj": "46036533870",
        "blacklist": false,
        "bank_account": null,
        "rg": "123456789",
        "emission_rg": null,
        "civil_state": null,
        "marital_status": "single",
        "gender_customer": "masculino",
        "reference_name": null,
        "reference_ddd": null,
        "reference_phone": null,
        "entity": {
            "id": 12167,
            "cpf_cnpj": "46036533870",
            "name": "Vinicius Souza da Silva",
            "social_reason": null,
            "has_commission": null,
            "address": {
                "id": 12099,
                "zip_code": "05350000",
                "street": "Avenida Escola Politécnica",
                "number": "2200",
                "district": "Rio Pequeno",
                "complement": "",
                "active": "yes",
                "country": "BRA",
                "city": "São Paulo",
                "state": "SP",
                "lat": null,
                "tong": null,
                "created_at": "2026-01-09T12:45:11.426-03:00",
                "updated_at": "2026-01-09T12:45:11.426-03:00",
                "entity_id": 12167,
                "deleted_at": null,
                "imported_id": null
            },
            "bank_account": null,
            "contacts": [],
            "commission_bases": [],
            "commissions": [],
            "commission_bases_report": [],
            "kind": null,
            "commission_fgts": null,
            "fgts_has_commission": null,
            "fgts_commissions": [],
            "has_cdc_commission": false,
            "has_secure": true,
            "has_uy3_create": false,
            "has_fgts_create": false,
            "commission_clt": null,
            "has_clt_create": null,
            "clt_has_commission": null,
            "clt_commissions": [],
            "has_cdc_create": true,
            "has_credit_create": true,
            "product": "NSG",
            "product_cdc": "NSG",
            "product_fgts": "NSG",
            "periodicity": null,
            "periodicity_fgts": null,
            "periodicity_cdc": null,
            "blacklist": false
        }
    },
    {
        "id": 4369,
        "name": "Maycon Souza Da Silva",
        "email": "cliente.teste@email.com",
        "mobile": "11988887777",
        "mother_name": "Maria Ferreira da Silva",
        "father_name": "José Ferreira da Silva",
        "birth_date": "1997-05-14",
        "address": {
            "id": 12071,
            "zip_code": "05350000",
            "street": "Avenida Escola Politécnica",
            "number": "2200",
            "district": "Rio Pequeno",
            "complement": "",
            "active": "yes",
            "country": "BRA",
            "city": "São Paulo",
            "state": "SP",
            "lat": null,
            "tong": null,
            "created_at": "2026-01-09T09:23:39.493-03:00",
            "updated_at": "2026-01-09T09:23:39.493-03:00",
            "entity_id": 12139,
            "deleted_at": null,
            "imported_id": null
        },
        "contacts": [],
        "cpf_cnpj": "10432563776",
        "blacklist": false,
        "bank_account": null,
        "rg": "123456789",
        "emission_rg": null,
        "civil_state": null,
        "marital_status": "single",
        "gender_customer": "male",
        "reference_name": null,
        "reference_ddd": null,
        "reference_phone": null,
        "entity": {
            "id": 12139,
            "cpf_cnpj": "10432563776",
            "name": "Maycon Souza da Silva",
            "social_reason": null,
            "has_commission": null,
            "address": {
                "id": 12071,
                "zip_code": "05350000",
                "street": "Avenida Escola Politécnica",
                "number": "2200",
                "district": "Rio Pequeno",
                "complement": "",
                "active": "yes",
                "country": "BRA",
                "city": "São Paulo",
                "state": "SP",
                "lat": null,
                "tong": null,
                "created_at": "2026-01-09T09:23:39.493-03:00",
                "updated_at": "2026-01-09T09:23:39.493-03:00",
                "entity_id": 12139,
                "deleted_at": null,
                "imported_id": null
            },
            "bank_account": null,
            "contacts": [],
            "commission_bases": [],
            "commissions": [],
            "commission_bases_report": [],
            "kind": null,
            "commission_fgts": null,
            "fgts_has_commission": null,
            "fgts_commissions": [],
            "has_cdc_commission": false,
            "has_secure": true,
            "has_uy3_create": false,
            "has_fgts_create": false,
            "commission_clt": null,
            "has_clt_create": null,
            "clt_has_commission": null,
            "clt_commissions": [],
            "has_cdc_create": true,
            "has_credit_create": true,
            "product": "NSG",
            "product_cdc": "NSG",
            "product_fgts": "NSG",
            "periodicity": null,
            "periodicity_fgts": null,
            "periodicity_cdc": null,
            "blacklist": false
        }
    },
    {
        "id": 4370,
        "name": "Vinicius Souza Da Silva",
        "email": "cliente.teste@email.com",
        "mobile": "11988887777",
        "mother_name": "Maria Ferreira da Silva",
        "father_name": "José Ferreira da Silva",
        "birth_date": "1997-05-14",
        "address": {
            "id": 12090,
            "zip_code": "05350000",
            "street": "Avenida Escola Politécnica",
            "number": "2200",
            "district": "Rio Pequeno",
            "complement": "",
            "active": "yes",
            "country": "BRA",
            "city": "São Paulo",
            "state": "SP",
            "lat": null,
            "tong": null,
            "created_at": "2026-01-09T12:28:06.010-03:00",
            "updated_at": "2026-01-09T12:28:06.010-03:00",
            "entity_id": 12158,
            "deleted_at": null,
            "imported_id": null
        },
        "contacts": [],
        "cpf_cnpj": "86033253590",
        "blacklist": false,
        "bank_account": null,
        "rg": "123456789",
        "emission_rg": null,
        "civil_state": null,
        "marital_status": "single",
        "gender_customer": "masculino",
        "reference_name": null,
        "reference_ddd": null,
        "reference_phone": null,
        "entity": {
            "id": 12158,
            "cpf_cnpj": "86033253590",
            "name": "Vinicius Souza da Silva",
            "social_reason": null,
            "has_commission": null,
            "address": {
                "id": 12090,
                "zip_code": "05350000",
                "street": "Avenida Escola Politécnica",
                "number": "2200",
                "district": "Rio Pequeno",
                "complement": "",
                "active": "yes",
                "country": "BRA",
                "city": "São Paulo",
                "state": "SP",
                "lat": null,
                "tong": null,
                "created_at": "2026-01-09T12:28:06.010-03:00",
                "updated_at": "2026-01-09T12:28:06.010-03:00",
                "entity_id": 12158,
                "deleted_at": null,
                "imported_id": null
            },
            "bank_account": null,
            "contacts": [],
            "commission_bases": [],
            "commissions": [],
            "commission_bases_report": [],
            "kind": null,
            "commission_fgts": null,
            "fgts_has_commission": null,
            "fgts_commissions": [],
            "has_cdc_commission": false,
            "has_secure": true,
            "has_uy3_create": false,
            "has_fgts_create": false,
            "commission_clt": null,
            "has_clt_create": null,
            "clt_has_commission": null,
            "clt_commissions": [],
            "has_cdc_create": true,
            "has_credit_create": true,
            "product": "NSG",
            "product_cdc": "NSG",
            "product_fgts": "NSG",
            "periodicity": null,
            "periodicity_fgts": null,
            "periodicity_cdc": null,
            "blacklist": false
        }
    }
]

      await pool.query(
        `REPLACE INTO fgts_consultas 
         (id, cpf, provider, status, amount, payload, periods) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.balanceId,
          cpf,
          provider,
          "success",
          data.balance ?? 0,
          JSON.stringify(data),
          JSON.stringify(data.installments || [])
        ]
      );

      return res.json({ recebido: true });
    }

    console.log("🟥 [FGTS][WEBHOOK] FALHA para CPF:", cpf);

    await pool.query(
      `REPLACE INTO fgts_consultas 
       (id, cpf, provider, status, amount, payload, periods) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.balanceId,
        cpf,
        provider,
        "fail",
        0,
        JSON.stringify(data),
        JSON.stringify([])
      ]
    );

    return res.json({ recebido: true });

  } catch (err) {
    console.log("🟥 [FGTS][WEBHOOK ERRO]:", err);
    return res.status(500).json({ erro: err.message });
  }
});


// ============================================================================
// 3) CONSULTAR RESULTADO FINAL
// ============================================================================
app.get("/fgts/resultado/:cpf", async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/\D/g, "");
    const token = await getV8Token();

    if (!token)
      return res.status(500).json({ sucesso: false, erro: "Token ausente" });

    console.log("\n🟦 [FGTS][RESULTADO] Consultando V8 para CPF:", cpf);

    const resp = await axios.get(
      `https://bff.v8sistema.com/fgts/balance?search=${cpf}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("🟩 [FGTS][RESULTADO] RESPOSTA V8:");
    console.log(JSON.stringify(resp.data, null, 2));

    // Se não houver dados ainda
    if (!resp.data?.data?.length) {
      return res.json({ sucesso: false, mensagem: "Consulta ainda não finalizada" });
    }

    const item = resp.data.data[0];

    // Salva oficialmente no banco
    await pool.query(
      `REPLACE INTO fgts_consultas 
      (id, cpf, provider, status, amount, payload, periods) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        cpf,
        item.provider,
        item.status,
        item.amount,
        JSON.stringify(item),
        JSON.stringify(item.periods || [])
      ]
    );

    return res.json({
      sucesso: true,
      resultado: item
    });

  } catch (err) {
    console.log("🟥 [FGTS][RESULTADO ERRO]:", err?.response?.data || err);
    return res.status(500).json({
      sucesso: false,
      erro: err?.response?.data?.detail || err.message
    });
  }
});

// ============================================================================
// 4) BUSCAR TABELAS FGTS
// ============================================================================
app.get("/fgts/tabelas", async (req, res) => {
  try {
    console.log("\n==============================");
    console.log("📘 [FGTS][TABELAS] Nova requisição");
    console.log("==============================");

    const token = await getV8Token();
    if (!token) {
      console.log("🟥 [FGTS][TABELAS] Token ausente!");
      return res.status(500).json({ sucesso: false, erro: "Token ausente" });
    }

    console.log("🔑 Token prefixo:", token.substring(0, 15));

    const url = "https://bff.v8sistema.com/fgts/simulations/fees";
    console.log("📤 GET ->", url);

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log("\n📥 [FGTS][TABELAS] Resposta completa do V8:");
    console.log(JSON.stringify(resp.data, null, 2));

    const tabelas = resp.data || [];

    console.log("\n🔍 Labels recebidos:");
    tabelas.forEach(t =>
      console.log(" -", t.simulation_fees.label, "| ID:", t.simulation_fees.id_simulation_fees)
    );

    const pitstop = tabelas.find(
      t => t.simulation_fees.label.toLowerCase() === "pitstop"
    );

    if (!pitstop) {
      console.log("🟥 [FGTS][TABELAS] PITSTOP não encontrada!");
      return res.json({
        sucesso: false,
        erro: "Tabela PITSTOP não encontrada."
      });
    }

    console.log("\n🏁 [FGTS][TABELAS] Tabela PITSTOP encontrada:");
    console.log("Label:", pitstop.simulation_fees.label);
    console.log("ID:", pitstop.simulation_fees.id_simulation_fees);

    return res.json({
      sucesso: true,
      tabela: pitstop
    });

  } catch (err) {
    console.log("\n🟥 [FGTS][TABELAS ERRO]");
    console.log(err?.response?.data || err);

    return res.status(500).json({
      sucesso: false,
      erro: err?.response?.data?.detail || err.message
    });
  }
});




// ============================================================================
// 5) SIMULAR FGTS
// ============================================================================

// ============================================================================
// 5) SIMULAR FGTS — VERSÃO OTIMIZADA
// ============================================================================
app.post("/fgts/simular", async (req, res) => {
  try {
    const { balanceId, cpf, periods } = req.body;

    const token = await getV8Token();
    if (!token)
      return res.status(500).json({ sucesso: false, erro: "Token ausente" });

    // --------------------------------------------------------
    // BUSCAR TABELA PITSTOP AUTOMATICAMENTE
    // --------------------------------------------------------
    const respFees = await axios.get(
      "https://bff.v8sistema.com/fgts/simulations/fees",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const tabelas = respFees.data || [];

    const pitstop = tabelas.find(
      t => t.simulation_fees.label.toLowerCase() === "pitstop"
    );

    if (!pitstop) {
      return res.json({
        sucesso: false,
        erro: "Tabela PITSTOP não encontrada."
      });
    }

    const simulationFeesId = pitstop.simulation_fees.id_simulation_fees;

    console.log("🏁 Usando Tabela PITSTOP:", simulationFeesId);

    // --------------------------------------------------------
    // PAYLOAD DA SIMULAÇÃO
    // --------------------------------------------------------
    const payload = {
      simulationFeesId,
      balanceId,
      targetAmount: 0,
      documentNumber: cpf.replace(/\D/g, ""),
      provider: "bms",
      desiredInstallments: periods.map(p => ({
        totalAmount: p.amount,
        amount: p.amount,
        dueDate: p.dueDate
      }))
    };

    console.log("\n📦 [FGTS][SIMULAR] Payload enviado:");
    console.log(JSON.stringify(payload, null, 2));

    const respSim = await axios.post(
      "https://bff.v8sistema.com/fgts/simulations",
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("\n🟩 [FGTS][SIMULAR] RESPOSTA:");
    console.log(JSON.stringify(respSim.data, null, 2));

    return res.json({
      sucesso: true,
      simulacao: respSim.data,
      tabela: pitstop
    });

  } catch (err) {
    return res.status(500).json({
      sucesso: false,
      erro: err?.response?.data?.detail || err.message
    });
  }
});

// ============================================================================
// 6) CRIAR PROPOSTA FGTS — VERSÃO AJUSTADA E 100% COMPATÍVEL COM O V8
// ============================================================================
app.post("/fgts/proposta", async (req, res) => {
  try {
    const { dadosCliente, simulacao, periods } = req.body;

    const cpf = dadosCliente.cpf.replace(/\D/g, "");
    const token = await getV8Token();
    if (!token)
      return res.status(500).json({ sucesso: false, erro: "Token ausente" });

    // ============================================================
    // 1) BUSCAR TABELA PITSTOP DO V8
    // ============================================================
    const feesResp = await axios.get(
      "https://bff.v8sistema.com/fgts/simulations/fees",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const tabelas = feesResp.data || [];

    const pitstop = tabelas.find(
      t => t.simulation_fees.label.toLowerCase() === "pitstop"
    );

    if (!pitstop)
      return res.status(400).json({
        sucesso: false,
        erro: "Tabela PITSTOP não encontrada."
      });

    const simulationFeesId = pitstop.simulation_fees.id_simulation_fees;

    // ============================================================
    // 2) FORMATAR DADOS DO CLIENTE
    // ============================================================
    const phoneCorrigido = corrigirTelefone(dadosCliente.telefone);
    const ddd = phoneCorrigido.substring(0, 2);
    const numeroSemDDD = phoneCorrigido.substring(2);

    const documentoID =
      dadosCliente.rg?.trim() ||
      dadosCliente.cnh?.trim() ||
      "000000000";

    const estadoUF = (dadosCliente.estado || "")
      .toString()
      .trim()
      .toUpperCase()
      .substring(0, 2);

    const periodsFormatados = periods.map(p => ({
      amount: p.amount,
      dueDate: formatarDataISO(p.dueDate)
    }));

    const birthDateISO = formatarDataISO(dadosCliente.dataNasc);

    const pixChave =
      dadosCliente.chavePix?.trim() ||
      dadosCliente.email ||
      cpf;

    // ============================================================
    // 3) PAYLOAD FINAL (AGORA CORRETAMENTE PREENCHIDO)
    // ============================================================
    const payload = {
      fgtsSimulationId: simulacao.id,              // ✔ ID retornado da simulação
      simulationFeesId: simulationFeesId,         // ✔ ID da PITSTOP buscado agora

      name: dadosCliente.nome,
      individualDocumentNumber: cpf,
      documentIdentificationNumber: documentoID,
      motherName: dadosCliente.nomeMae,
      nationality: "Brasileiro(a)",
	  provider:"bms",
      isPEP: false,
      email: dadosCliente.email,
      birthDate: birthDateISO,
      maritalStatus: dadosCliente.estadoCivil,
      personType: "natural",

      phone: numeroSemDDD,
      phoneCountryCode: "55",
      phoneRegionCode: ddd,

      postalCode: dadosCliente.cep.replace(/\D/g, ""),
      state: estadoUF,
      neighborhood: dadosCliente.bairro,
      addressNumber: dadosCliente.numero,
      city: dadosCliente.cidade,
      street: dadosCliente.rua,
      complement: dadosCliente.complemento || "",

      formalizationLink: "",

      payment: {
        type: "pix",
        data: { pix: pixChave }
      },

      fgtsProposalsPeriods: periodsFormatados
    };

    console.log("\n🟦 [FGTS][PROPOSTA] Payload enviado:");
    console.log(JSON.stringify(payload, null, 2));

    // ============================================================
    // 4) CHAMADA FINAL
    // ============================================================
    const resp = await axios.post(
      "https://bff.v8sistema.com/fgts/proposal",
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log("🟩 [FGTS][PROPOSTA] RESPOSTA V8:");
    console.log(JSON.stringify(resp.data, null, 2));

    await salvarLogFGTS("CRIAR_PROPOSTA", cpf, "bms", payload, resp.data);

    return res.json({
      sucesso: true,
      proposta: resp.data
    });

  } catch (err) {
    console.log("🟥 [FGTS][PROPOSTA ERRO] RESPOSTA V8:");
    console.log(err?.response?.data || err);

    await salvarLogFGTS(
      "CRIAR_PROPOSTA_ERRO",
      req.body?.dadosCliente?.cpf,
      "bms",
      req.body,
      err
    );

    return res.status(500).json({
      sucesso: false,
      erro: err?.response?.data?.detail || err.message
    });
  }
});


// -------------------- TODAS AS ROTAS EXISTENTES (PRESENÇA + V8 + C6) --------------------
// ----------------------------------------------------------------------------------------
// TERMO
app.post("/presenca/termo", async (req, res) => {
  console.log("[TERMO] Recebido:", req.body);

  try {
    console.log("[TERMO] Iniciando login...");
    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );

    console.log("[TERMO] Login resposta:", login);

    if (!login.sucesso) {
      console.log("[TERMO] ERRO LOGIN");
      return res.json({ sucesso: false, erro: "Login falhou", login });
    }

    console.log("[TERMO] Criando termo...");
    const result = await criarTermo(login.token, req.body);

    console.log("[TERMO] Resposta criarTermo:", result);

    return res.json(result);

  } catch (error) {
    console.log("[TERMO][EXCEPTION]:", error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});


// CONSULTAR VÍNCULO
app.post("/presenca/vinculo", async (req, res) => {
  try {
    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );
    if (!login.sucesso) return res.json(login);

    const { cpf } = req.body;

    const vinculo = await consultarVinculo(login.token, cpf);

    if (!vinculo.sucesso || !vinculo.dados?.id?.length)
      return res.json({ vinculo, margem: null });

    const item = vinculo.dados.id[0];

    await esperar(2000);

    const margem = await consultarMargem(login.token, {
      cpf,
      matricula: item.matricula,
      cnpj: item.numeroInscricaoEmpregador
    });

    return res.json({ vinculo, margem });

  } catch (err) {
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// SIMULAÇÃO
// Função utilitária para tentativas múltiplas
async function tentarVariasVezes(fn, tentativas = 5, intervalo = 1200) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const resultado = await fn();
      if (resultado) return resultado;
    } catch {}

    await new Promise(r => setTimeout(r, intervalo));
  }
  return null;
}

// Obter vínculo com re-tentativas
async function obterVinculoCompleto(token, cpf) {
  return await tentarVariasVezes(async () => {
    const vinculo = await consultarVinculo(token, cpf);
    if (!vinculo?.sucesso) return null;
    if (!vinculo?.dados?.id?.length) return null;

    const info = vinculo.dados.id.find(v => v.elegivel) || vinculo.dados.id[0];

    // Campos mínimos exigidos pelo Presença
    if (!info?.matricula) return null;
    if (!info?.numeroInscricaoEmpregador) return null;

    return info;
  });
}

// Obter margem com re-tentativas
async function obterMargemCompleta(token, cpf, info) {
  return await tentarVariasVezes(async () => {
    const margem = await consultarMargem(token, {
      cpf,
      matricula: info.matricula,
      cnpj: info.numeroInscricaoEmpregador
    });

    if (!margem?.sucesso || !margem?.dados?.length) return null;

    const mg = margem.dados.find(m => m.valorMargem > 0) || margem.dados[0];

    // Campos exigidos para simular
    if (!mg?.nomeMae) return null;
    if (!mg?.dataNascimento) return null;
    if (!mg?.sexo) return null;

    return mg;
  });
}

// ------------------- ROTA /PRESENCA/SIMULAR COMPLETA -------------------

app.post("/presenca/simular", async (req, res) => {
  try {
    const { cpf, nome, telefone, email } = req.body;

    // LOGIN
    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );
    if (!login.sucesso) return res.json(login);

    // =====================================================
    // 1. OBTER VÍNCULO COMPLETO (COM TENTATIVAS)
    // =====================================================
    const info = await obterVinculoCompleto(login.token, cpf);

    if (!info) {
      return res.status(400).json({
        sucesso: false,
        erro: "Não foi possível obter vínculo completo para simulação"
      });
    }

    // =====================================================
    // 2. OBTER MARGEM COMPLETA (COM TENTATIVAS)
    // =====================================================
    const mg = await obterMargemCompleta(login.token, cpf, info);

    if (!mg) {
      return res.status(400).json({
        sucesso: false,
        erro: "Não foi possível obter margem completa (nomeMae, dataNascimento, sexo...)"
      });
    }

    // =====================================================
    // 3. MONTAR PAYLOAD FINAL COMPLETO
    // =====================================================

    const payloadFinal = {
      proposta: {
        valorSolicitado: 0,
        quantidadeParcelas: 0,
        produtoId: 28,
        valorParcela: mg.valorMargem ?? mg.valorMargemAvaliavel ?? 0,
        tabelaId: 0
      },
      tomador: {
        cpf,
        nome,
        dataNascimento: mg.dataNascimento,
        nomeMae: mg.nomeMae,
        email,
        sexo: mg.sexo,
        endereco: {
          cep: "",
          rua: "",
          numero: "",
          complemento: "",
          cidade: "",
          estado: "",
          bairro: ""
        },
        telefone: {
          ddd: telefone.substring(0, 2),
          numero: telefone.substring(2)
        },
        vinculoEmpregaticio: {
          cnpjEmpregador: mg.numeroInscricaoEmpregador || info.numeroInscricaoEmpregador,
          registroEmpregaticio: mg.matricula || info.matricula
        },
        dadosBancarios: {
          codigoBanco: "",
          agencia: "",
          conta: "",
          digitoConta: "",
          formaCredito: ""
        },
        tenantId: "bb697451-7fae-41bf-a4b7-53db7c1f8197"
      }
    };

    // =====================================================
    // 4. SIMULAR
    // =====================================================

    const resultado = await simularTabelas(login.token, payloadFinal);

    if (!resultado?.simulacoes?.length) {
      return res.status(400).json({
        sucesso: false,
        erro: "Simulação não retornou ofertas"
      });
    }

    const simulacoesEnriquecidas = resultado.simulacoes.map(sim => ({
      ...sim,
      nomeMae: mg.nomeMae,
      dataNascimento: mg.dataNascimento,
      sexo: mg.sexo,
      matricula: mg.matricula || info.matricula,
      numeroInscricaoEmpregador: mg.numeroInscricaoEmpregador || info.numeroInscricaoEmpregador
    }));

    // 🌟 AJUSTE AQUI: MUDANÇA PARA ENCONTRAR O MAIOR VALOR LIBERADO
    const maior = simulacoesEnriquecidas.reduce((m, s) =>
      s.valorLiberado > m.valorLiberado ? s : m
    );

    return res.json({
      sucesso: true,
      melhorSimulacao: maior, // <-- Agora retorna a simulação com o maior valor liberado
      payload_enviado: payloadFinal,
      resposta: resultado,
      vinculo: info,
      margem: mg
    });

  } catch (err) {
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});


// CRIAR OPERAÇÃO
app.post("/presenca/operacao", async (req, res) => {
  try {
    console.log("\n======================================");
    console.log("🔥 [PRESENÇA][OPERACAO] NOVA REQUISIÇÃO");
    console.log("Body recebido:", JSON.stringify(req.body, null, 2));
    console.log("======================================\n");

    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );
    if (!login.sucesso) return res.json(login);

    const incoming = req.body || {};
    const cpf = incoming?.tomador?.cpf?.replace(/\D/g, "");

    if (!cpf)
      return res.status(400).json({ sucesso: false, erro: "CPF do tomador é obrigatório" });

    if (!incoming.proposta)
      return res.status(400).json({ sucesso: false, erro: "Objeto proposta é obrigatório" });

    if (!incoming.tomador?.endereco)
      return res.status(400).json({ sucesso: false, erro: "Endereço é obrigatório" });

    if (!incoming.tomador?.dadosBancarios)
      return res.status(400).json({ sucesso: false, erro: "Dados bancários obrigatórios" });


    console.log("🔍 Buscando vínculo do CPF:", cpf);
    const vinculo = await consultarVinculo(login.token, cpf);
    if (!vinculo.sucesso || !vinculo.dados?.id?.length)
      return res.status(400).json({ sucesso: false, erro: "Vínculo não encontrado" });

    const info =
      vinculo.dados.id.find(v => v.elegivel === true) ||
      vinculo.dados.id[0];


    // ===============================
    // 🔧 MONTA PAYLOAD FINAL
    // ===============================
    const payloadFinal = {
      type: "credito-privado-v3",
      proposta: {
        valorSolicitado: incoming.proposta.valorSolicitado,
        quantidadeParcelas: incoming.proposta.quantidadeParcelas,
        produtoId: incoming.proposta.produtoId,
        valorParcela: incoming.proposta.valorParcela,
        tabelaId: incoming.proposta.tabelaId
      },
      tomador: {
        ...incoming.tomador,
        vinculoEmpregaticio: {
          cnpjEmpregador: info.numeroInscricaoEmpregador,
          registroEmpregaticio: info.matricula
        }
      },
      representante: {
        cpf,
        nome: incoming.tomador.nome,
        nomeMae: incoming.tomador.nomeMae || "",
        dataNascimento: incoming.tomador.dataNascimento || ""
      },
      documentos: []
    };

    console.log("\n📦 Payload enviado ao Presença:");
    console.log(JSON.stringify(payloadFinal, null, 2));


    // ===============================
    // 🔥 CRIA OPERAÇÃO
    // ===============================
    const resposta = await criarOperacaoCLT(login.token, payloadFinal);
    console.log("\n📩 Resposta criarOperacaoCLT:", resposta);

    const operacaoId = resposta?.id;

    if (!operacaoId) {
      console.log("❌ ERRO: Criar operação não retornou ID!");
      return res.json({ sucesso: false, erro: "ID da operação ausente" });
    }

    console.log(`\n🎯 OPERAÇÃO CRIADA COM ID: ${operacaoId}`);


    // ===============================
    // 🔍 POOLING: ESPERAR OPERAÇÃO APARECER
    // ===============================
    async function buscarOperacaoAteAchar(id) {
      for (let i = 1; i <= 40; i++) {
        console.log(`\n[POOLING][OPERACAO] Tentativa ${i}/40 para achar operação ${id}`);

        try {
          const resp = await axios.get(
            "https://presenca-bank-api.azurewebsites.net/operacoes",
            { headers: { Authorization: `Bearer ${login.token}` }, httpsAgent }
          );

          const lista = resp.data?.result || [];
          const op = lista.find(o => Number(o.id) === Number(id));

          if (op) {
            console.log("[POOLING][OPERACAO] 🎯 ENCONTRADA!\n", JSON.stringify(op, null, 2));
            return op;
          } else {
            console.log("[POOLING][OPERACAO] ❌ Ainda não apareceu...");
          }
        } catch (err) {
          console.log("[POOLING][OPERACAO] ERRO:", err.message);
        }

        await esperar(1500);
      }

      console.log("[POOLING][OPERACAO] ❌ NÃO ENCONTRADA APÓS 40 TENTATIVAS!");
      return null;
    }

    let operacao = await buscarOperacaoAteAchar(operacaoId);


    // ===============================
    // 🔍 POOLING: ESPERAR LINK DE FORMALIZAÇÃO
    // ===============================
    async function buscarLinkAteAchar(op) {
      for (let i = 1; i <= 30; i++) {
        const atual = op?.formalizacao?.link || null;

        console.log(`\n[POOLING][LINK] Tentativa ${i}/30`);
        console.log("[POOLING][LINK] Valor atual:", atual);

        if (atual) {
          console.log("[POOLING][LINK] 🎯 LINK ENCONTRADO!");
          return atual;
        }

        try {
          const resp = await axios.get(
            "https://presenca-bank-api.azurewebsites.net/operacoes",
            { headers: { Authorization: `Bearer ${login.token}` }, httpsAgent }
          );

          const lista = resp.data?.result || [];
          op = lista.find(o => Number(o.id) === Number(op.id));

          if (op?.formalizacao?.link) {
            console.log("[POOLING][LINK] 🎉 LINK APARECEU:", op.formalizacao.link);
            return op.formalizacao.link;
          }
        } catch {}

        await esperar(2000);
      }

      console.log("[POOLING][LINK] ❌ LINK NÃO ENCONTRADO APÓS 30 TENTATIVAS!");
      return null;
    }

    let linkFormalizacao = operacao 
      ? await buscarLinkAteAchar(operacao)
      : null;


    // ===============================
    // 🔥 LOG FINAL — O QUE VAI PARA O FRONT
    // ===============================
    const respostaFinal = {
      sucesso: true,
      id: operacaoId,
      formalizacaoLink: linkFormalizacao
    };

    console.log("\n======================================");
    console.log("🔥 RESPOSTA ENVIADA PARA O FRONT:");
    console.log(JSON.stringify(respostaFinal, null, 2));
    console.log("======================================\n");


    return res.json(respostaFinal);

  } catch (err) {
    console.error("[OPERACAO] ERRO:", err);
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});
// =====================================================================================
// ROTAS DO ADMIN (Adicione isto ao seu index.js)
// =====================================================================================

// 1. Rota de Login Admin
app.post("/admin/login", (req, res) => {
  const { login, senha } = req.body;
  
  // Credenciais solicitadas
  if (login === "adm_nitz" && senha === "H!p0tenusa") {
    return res.json({ success: true, token: "admin-token-secreto-nitz" });
  }
  
  return res.status(401).json({ success: false, error: "Credenciais inválidas" });
});

// 2. Rota de Dados do Dashboard
app.get("/admin/dashboard-data", async (req, res) => {
  try {
    const token = req.headers["authorization"];
    if (token !== "admin-token-secreto-nitz") {
      return res.status(401).json({ error: "Não autorizado" });
    }

    const { periodo } = req.query;

    let where = "";
    let params = [];

    // -----------------------------
    // FILTRO DE PERÍODO
    // -----------------------------
    if (periodo && periodo !== "tudo") {
      const dias =
        periodo === "hoje" ? 1 :
        periodo === "3dias" ? 3 :
        periodo === "7dias" ? 7 :
        30;

      where = "WHERE updated_at >= NOW() - INTERVAL ? DAY";
      params.push(dias);
    }

    // -----------------------------
    // BUSCAR TODAS AS LINHAS
    // -----------------------------
    const [rows] = await pool.query(
      `
      SELECT email, cpf, etapa, dados, updated_at 
      FROM progresso_proposta
      ${where}
      ORDER BY updated_at DESC
      `,
      params
    );

    const total = rows.length;

    // -----------------------------
    // ACUMULADORES
    // -----------------------------
    const funilEtapas = {};
    const funilBanco = {};
    const empresasTamanho = {
      "Menos de 20 funcionários": 0,
      "Mais de 20 funcionários": 0,
      "Não informado": 0
    };

    let elegiveis = 0;
    let naoElegiveis = 0;

    const tabela = [];

    // -----------------------------
    // PROCESSAMENTO
    // -----------------------------
    for (const row of rows) {
      let data = {};

      try {
        data = JSON.parse(row.dados);
      } catch {
        data = {};
      }

      // -----------------------------
      // FUNIL DE ETAPAS
      // -----------------------------
      funilEtapas[row.etapa] = (funilEtapas[row.etapa] || 0) + 1;

      // -----------------------------
      // FUNIL POR BANCO
      // -----------------------------
      if (data.bancoSelecionado) {
        funilBanco[data.bancoSelecionado] =
          (funilBanco[data.bancoSelecionado] || 0) + 1;
      }

      // -----------------------------
      // TAMANHO EMPRESA
      // -----------------------------
      const tamanho = data.tamanhoEmpresa || "Não informado";
      if (empresasTamanho[tamanho] !== undefined)
        empresasTamanho[tamanho]++;
      else
        empresasTamanho["Não informado"]++;

      // -----------------------------
      // ELEGIBILIDADE
      // -----------------------------
      const totalMeses =
        (data.anosContrato ?? 0) * 12 + (data.mesesContrato ?? 0);

      const empresaOK =
        (data.tamanhoEmpresa || "").includes("Mais de 20");

      const elegivel = totalMeses >= 6 && empresaOK;

      if (elegivel) elegiveis++;
      else naoElegiveis++;

      // -----------------------------
      // MONTAR OBJETO FINAL PARA O REACT
      // -----------------------------
      tabela.push({
        email: row.email,
        cpf: row.cpf,
        etapa: row.etapa,

        // <-- AQUI: subtrai 3 horas (3 * 60 * 60 * 1000 ms)
        updated_at: new Date(new Date(row.updated_at).getTime() + 3 * 60 * 60 * 1000).toISOString(),

        dados: {
          ...data,
          cpf: data.cpf || row.cpf,
          email: data.email || row.email,
          nome: data.nome || "",
          telefone: data.telefone || "",
          tamanhoEmpresa: data.tamanhoEmpresa || "Não informado",
          bancoSelecionado: data.bancoSelecionado || "",
          elegivel: elegivel ? "Elegível" : "Não elegível",
          anosContrato: data.anosContrato ?? 0,
          mesesContrato: data.mesesContrato ?? 0
        }
      });
    }

    // -----------------------------
    // FUNIS EM ARRAY
    // -----------------------------
    const funil = Object.entries(funilEtapas).map(
      ([etapa, quantidade]) => ({ etapa: Number(etapa), quantidade })
    );

    const funilBancoArr = Object.entries(funilBanco).map(
      ([banco, quantidade]) => ({ banco, quantidade })
    );

    // -----------------------------
    // RESPOSTA FINAL
    // -----------------------------
    res.json({
      total,
      funil,
      funilBanco: funilBancoArr,
      empresasTamanho,
      elegiveis,
      naoElegiveis,
      tabela
    });

  } catch (err) {
    console.error("[ADMIN] Erro ao buscar dados:", err);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});
// ============================================================================
// SAQUE — SIMULAR
// ============================================================================
// ============================================================================
// SAQUE — SIMULAR
// ============================================================================
app.post("/saque/simular", async (req, res) => {
  const requestId = `SAQUE-${Date.now()}`;

  console.log("\n==============================");
  console.log(`📥 [${requestId}] INÍCIO /saque/simular`);
  console.log("📥 Body recebido:");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const {
      email,
      cpf,
      nome,
      telefone,
      value,
      installments
    } = req.body;

    // =========================================================
    // 0️⃣ VALIDAÇÃO
    // =========================================================
    const parcelas = Number(installments);
    const valor = Number(value);

    if (
      !email ||
      !cpf ||
      !nome ||
      !telefone ||
      valor <= 0 ||
      ![4, 8, 12].includes(parcelas)
    ) {
      console.log(`⚠️ [${requestId}] Campos obrigatórios inválidos`);
      return res.status(400).json({
        sucesso: false,
        erro: "Campos obrigatórios inválidos"
      });
    }

    const cpfLimpo = String(cpf).replace(/\D/g, "");

    // =========================================================
    // 1️⃣ DEFINIR TAXA DE JUROS POR PARCELAS
    // =========================================================
    let INTEREST_RATE;

    switch (parcelas) {
      case 4:
        INTEREST_RATE = 22;
        break;
      case 8:
        INTEREST_RATE = 13;
        break;
      case 12:
        INTEREST_RATE = 7;
        break;
      default:
        throw new Error("Quantidade de parcelas não suportada");
    }

    console.log(`📊 [${requestId}] Taxa definida: ${INTEREST_RATE}% a.m.`);

    // =========================================================
    // 2️⃣ SALVAR PROGRESSO (SEM ALTERAR SCHEMA)
    // =========================================================
    const dadosProgresso = {
      bancoSelecionado: "saque_cartao",
      produto: "NOVO_SAQUE",
      saque: {
        value: valor,
        installments: parcelas,
        interest_rate: INTEREST_RATE
      },
      nome,
      cpf: cpfLimpo,
      telefone
    };

    console.log(`💾 [${requestId}] Salvando progresso_proposta`);
    console.log(JSON.stringify(dadosProgresso, null, 2));

    await pool.query(
      `
      INSERT INTO progresso_proposta (email, cpf, etapa, dados)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        cpf = VALUES(cpf),
        etapa = VALUES(etapa),
        dados = VALUES(dados),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        email,
        cpfLimpo,
        2,
        JSON.stringify(dadosProgresso)
      ]
    );

    // =========================================================
    // 3️⃣ AUTENTICAR NO NOVO SAQUE
    // =========================================================
    console.log(`🔐 [${requestId}] Autenticando na API do Novo Saque`);

    const auth = await authenticateSaque();

    if (!auth?.sucesso || !auth.token) {
      console.log(`❌ [${requestId}] Falha na autenticação`);
      return res.status(500).json({
        sucesso: false,
        erro: "Falha ao autenticar na API do Novo Saque"
      });
    }

    const token = auth.token;
    console.log(`✅ [${requestId}] Autenticação OK`);

    // =========================================================
    // 4️⃣ CHAMADA DE SIMULAÇÃO — NOVO SAQUE
    // =========================================================
    const payload = {
      simulation: {
        value: valor,
        interest_rate: INTEREST_RATE,
        installments: parcelas
      }
    };

    console.log(`🌐 [${requestId}] Enviando simulação para Novo Saque`);
    console.log(JSON.stringify(payload, null, 2));

    const resp = await axios.post(
      "https://homolog.novosaque.com.br/api/v1/simulations/simulation_values/credit_limit",
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    console.log(`🟩 [${requestId}] Resposta da API Novo Saque`);
    console.log(JSON.stringify(resp.data, null, 2));

    // =========================================================
    // 5️⃣ NORMALIZAR RESPOSTA (USANDO raw)
    // =========================================================
    const raw = resp.data?.raw;

    if (!raw) {
      throw new Error("Resposta da simulação sem campo raw");
    }

    const simulacaoNormalizada = {
  fornecedor: "NOVO_SAQUE",
  produto: "SAQUE_CARTAO",

  valorLiberado: Number(raw.liquid_value),
  valorSolicitado: Number(raw.released_amount),
  valorParcela: Number(raw.value_installment),
  parcelas: Number(raw.installments),
  taxaJurosMensal: Number(raw.interest_rate),

  idSimulacao: raw.id_simulation,

  raw // 🔥 ESSENCIAL
};

    // =========================================================
    // 6️⃣ ATUALIZAR PROGRESSO COM SIMULAÇÃO NORMALIZADA
    // =========================================================
    dadosProgresso.saque.simulacao = simulacaoNormalizada;

    console.log(`💾 [${requestId}] Atualizando progresso com simulação normalizada`);

    await pool.query(
      `
      UPDATE progresso_proposta
      SET dados = ?, updated_at = CURRENT_TIMESTAMP
      WHERE email = ?
      `,
      [JSON.stringify(dadosProgresso), email]
    );

    // =========================================================
    // 7️⃣ RETORNO PARA O FRONT
    // =========================================================
    console.log(`📤 [${requestId}] Retorno de sucesso`);
    console.log("==============================\n");

    return res.json({
      sucesso: true,
      simulacao: simulacaoNormalizada
    });

  } catch (err) {
    console.log(`🟥 [${requestId}] ERRO /saque/simular`);

    if (err?.response) {
      console.log("🟥 Erro da API externa:");
      console.log("Status:", err.response.status);
      console.log("Body:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.log("🟥 Erro interno:");
      console.log(err.message);
    }

    console.log("==============================\n");

    return res.status(500).json({
      sucesso: false,
      erro: err?.response?.data || err.message
    });
  }
});
// ============================================================================
// SAQUE — CRIAR PROPOSTA
// ============================================================================



// ============================================================================
// SAQUE — CADASTRAR CLIENTE
// ============================================================================
// ============================================================================
// SAQUE — CADASTRAR CLIENTE (VERSÃO 100% COMPATÍVEL COM O NOVO SAQUE)
// ============================================================================
app.post("/saque/cadastrar-cliente", async (req, res) => {
  const requestId = `SAQUE-CAD-${Date.now()}`;

  console.log("\n==============================");
  console.log(`📥 [${requestId}] INÍCIO /saque/cadastrar-cliente`);
  console.log("📥 Body recebido:");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const { customer, customer_service_id } = req.body;

    // =========================================================
    // 0️⃣ VALIDAÇÃO ESTRUTURAL
    // =========================================================
    if (
      !customer ||
      !customer.birth_date ||
      !customer.email ||
      !customer.mobile ||
      !customer.rg ||
      !customer.gender_customer ||
      !customer.marital_status ||
      !customer.mother_name ||
      !customer.entity_attributes ||
      !customer.entity_attributes.name ||
      !customer.entity_attributes.cpf_cnpj ||
      !customer.entity_attributes.address_attributes ||
      !customer.entity_attributes.bank_account_attributes ||
      !customer_service_id
    ) {
      return res.status(400).json({
        sucesso: false,
        erro: "Payload inválido ou incompleto para cadastro de cliente"
      });
    }

    const address = customer.entity_attributes.address_attributes;
    const bank = customer.entity_attributes.bank_account_attributes;

    // =========================================================
    // 1️⃣ PAYLOAD FINAL (CONTRATO OFICIAL)
    // =========================================================
    const payload = {
      customer: {
        birth_date: customer.birth_date,
        email: customer.email,
        mobile: customer.mobile.replace(/\D/g, ""),
        rg: customer.rg,
        gender_customer: customer.gender_customer,
        marital_status: customer.marital_status,
        mother_name: customer.mother_name,
        father_name: customer.father_name || null,

        entity_attributes: {
          name: customer.entity_attributes.name,
          cpf_cnpj: customer.entity_attributes.cpf_cnpj.replace(/\D/g, ""),

          address_attributes: {
            zip_code: address.zip_code,
            street: address.street,
            number: address.number,
            district: address.district,
            city: address.city,
            state: address.state,
            complement: address.complement || null
          },

          bank_account_attributes: {
            number_bank: bank.number_bank,
            name_bank: bank.name_bank,
            agency_account: bank.agency_account,
            agency_digit: bank.agency_digit ?? null,
            number_account: bank.number_account,
            account_digit: bank.account_digit,
            kind: bank.kind ?? 0,
            kind_account: bank.kind_account,
            kind_pix: bank.kind_pix,
            pix: bank.pix
          }
        }
      },

      customer_service_id: String(customer_service_id)
    };

    // =========================================================
    // 🔥 LOG DO PAYLOAD FINAL
    // =========================================================
    console.log("\n🚀 [NOVO SAQUE][CADASTRO] PAYLOAD FINAL:");
    console.log(JSON.stringify(payload, null, 2));
    console.log("=================================================\n");

    // =========================================================
    // 2️⃣ AUTENTICAR NO NOVO SAQUE
    // =========================================================
    const auth = await authenticateSaque();

    if (!auth?.sucesso || !auth.token) {
      return res.status(500).json({
        sucesso: false,
        erro: "Falha ao autenticar na API do Novo Saque"
      });
    }

    // =========================================================
    // 3️⃣ CHAMADA OFICIAL /customers
    // =========================================================
    const resp = await axios.post(
      "https://homolog.novosaque.com.br/api/v1/customers",
      payload,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    console.log(`🟩 [${requestId}] Cliente cadastrado com sucesso`);
    console.log(JSON.stringify(resp.data, null, 2));

    // =========================================================
    // 4️⃣ RETORNO
    // =========================================================
    return res.json({
      sucesso: true,
      cliente: resp.data
    });

  } catch (err) {
    console.log(`🟥 [${requestId}] ERRO /saque/cadastrar-cliente`);

    if (err?.response) {
      console.log("Status:", err.response.status);
      console.log("Body:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.log(err.message);
    }

    return res.status(500).json({
      sucesso: false,
      erro: err?.response?.data || err.message
    });
  }
});

app.post("/saque/criar-proposta", async (req, res) => {
  const requestId = `SAQUE-PROP-${Date.now()}`;

  console.log("\n==============================");
  console.log(`📥 [${requestId}] INÍCIO /saque/criar-proposta`);
  console.log("📥 Body recebido:");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const { customerId, simulacao } = req.body;

    // =========================================================
    // 0️⃣ VALIDAÇÕES OBRIGATÓRIAS
    // =========================================================
    if (!customerId) {
      return res.status(400).json({
        sucesso: false,
        erro: "customerId ausente"
      });
    }

    if (!simulacao?.raw) {
      return res.status(400).json({
        sucesso: false,
        erro: "simulacao.raw ausente"
      });
    }

    const customerIdNum = Number(customerId);
    if (!Number.isInteger(customerIdNum)) {
      return res.status(400).json({
        sucesso: false,
        erro: "customerId inválido"
      });
    }

    const raw = simulacao.raw;

    if (!raw.id_simulation) {
      return res.status(400).json({
        sucesso: false,
        erro: "id_simulation ausente na simulação"
      });
    }

    const contractValue = Number(raw.released_amount);
    const amountCharged = Number(raw.card_limit);
    const installments = Number(raw.installments);

    if (
      !Number.isFinite(contractValue) ||
      !Number.isFinite(amountCharged) ||
      !Number.isInteger(installments)
    ) {
      return res.status(400).json({
        sucesso: false,
        erro: "Valores inválidos na simulação"
      });
    }

    // =========================================================
    // 1️⃣ AUTENTICAR NO NOVO SAQUE
    // =========================================================
    console.log(`🔐 [${requestId}] Autenticando no Novo Saque`);

    const auth = await authenticateSaque();

    if (!auth?.sucesso || !auth.token) {
      return res.status(500).json({
        sucesso: false,
        erro: "Falha na autenticação Novo Saque"
      });
    }

    console.log(`✅ [${requestId}] Autenticação OK`);

    // =========================================================
    // 2️⃣ PAYLOAD OFICIAL CREATE_PROPOSAL
    // =========================================================
    if (!simulacao.idSimulationAtendimento) {
  return res.status(400).json({
    sucesso: false,
    erro: "idSimulationAtendimento ausente"
  });
}
	const payload = {
  contract: {
    contract_value: contractValue,
    amount_charged: amountCharged,
    installments: installments,
    kind_integrator: 0,
    customer_id: customerIdNum
  },
  simulation_id: simulacao.idSimulationAtendimento
};


    console.log(`📦 [${requestId}] Payload enviado para Novo Saque`);
    console.log(JSON.stringify(payload, null, 2));

    // =========================================================
    // 3️⃣ CHAMADA CREATE_PROPOSAL
    // =========================================================
    const resp = await axios.post(
      "https://homolog.novosaque.com.br/api/v1/contracts/create_proposal",
      payload,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    console.log(`🟩 [${requestId}] Proposta criada com sucesso`);
    console.log(JSON.stringify(resp.data, null, 2));

    // =========================================================
    // 4️⃣ RETORNO PARA O FRONT
    // =========================================================
    return res.json({
      sucesso: true,
      proposta: resp.data
    });

  } catch (err) {
    console.log(`🟥 [${requestId}] ERRO criar proposta`);

    if (err?.response) {
      console.log("🟥 Erro da API Novo Saque:");
      console.log("Status:", err.response.status);
      console.log("Body:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.log("🟥 Erro interno:");
      console.log(err.message);
    }

    console.log("==============================\n");

    return res.status(500).json({
      sucesso: false,
      erro: err?.response?.data || err.message
    });
  }
});
app.post("/saque/registrar-atendimento", async (req, res) => {
  const requestId = `SAQUE-ATEND-${Date.now()}`;

  console.log(`\n📥 [${requestId}] INÍCIO /saque/registrar-atendimento`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const { simulacao, nome, cpf, email, telefone } = req.body;

    if (!simulacao?.raw) {
      return res.status(400).json({
        sucesso: false,
        erro: "simulacao.raw ausente"
      });
    }

    const raw = simulacao.raw;

    // =========================================================
    // 1️⃣ AUTENTICAR
    // =========================================================
    const auth = await authenticateSaque();
    if (!auth?.sucesso || !auth.token) {
      return res.status(500).json({
        sucesso: false,
        erro: "Falha ao autenticar no Novo Saque"
      });
    }

    // =========================================================
    // 2️⃣ PAYLOAD OFICIAL DO REGISTRO DE ATENDIMENTO
    // =========================================================
    const payload = {
      kind: "card_limit",
      simulation: {
        name: nome,
        cpf_cnpj: cpf.replace(/\D/g, ""),
        email,
        phone: telefone.replace(/\D/g, ""),

        interest_rate: Number(raw.interest_rate),
        installments: Number(raw.installments),
        released_amount: Number(raw.released_amount),
        card_limit: Number(raw.card_limit),
        value_installment: Number(raw.value_installment),
        value_iof: Number(raw.value_iof)
      }
    };

    console.log(`📦 [${requestId}] Payload atendimento`);
    console.log(JSON.stringify(payload, null, 2));

    // =========================================================
    // 3️⃣ CHAMADA OFICIAL
    // =========================================================
    const resp = await axios.post(
      "https://homolog.novosaque.com.br/api/v1/simulations",
      payload,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    console.log(`🟩 [${requestId}] Atendimento registrado`);
    console.log(JSON.stringify(resp.data, null, 2));

    // 👉 NORMALMENTE VEM AQUI
    const customerServiceId =
      resp.data?.id || resp.data?.customer_service_id;

    if (!customerServiceId) {
      return res.status(500).json({
        sucesso: false,
        erro: "customer_service_id não retornado pela API"
      });
    }

    const simulationIdAtendimento =
  resp.data?.id_simulation || resp.data?.simulation?.id;

return res.json({
  sucesso: true,
  customer_service_id: customerServiceId,
  id_simulation: simulationIdAtendimento,
  atendimento: resp.data
});

  } catch (err) {
    console.log(`🟥 [${requestId}] ERRO registrar atendimento`);

    if (err?.response) {
      console.log("Status:", err.response.status);
      console.log("Body:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.log(err.message);
    }

    return res.status(500).json({
      sucesso: false,
      erro: err?.response?.data || err.message
    });
  }
});



// ================= CRM - LISTAR LEADS =================
// ================= CRM - LISTAR LEADS (AJUSTADA PARA NOVO SAQUE) =================
app.get("/admin/crm/leads", async (req, res) => {
  try {
    const token = req.headers["authorization"];
    if (token !== "admin-token-secreto-nitz") {
      return res.status(401).json({ error: "Não autorizado" });
    }

    const [rows] = await pool.query(`
      SELECT
        email,
        cpf,
        etapa,
        dados,
        updated_at,
        dataSimulacao,
        tempo_servico_clt,
        margem_consignavel
      FROM progresso_proposta
      ORDER BY updated_at DESC
    `);

    const leads = rows.map((r, idx) => {
      let dados = {};
      try {
        dados =
          typeof r.dados === "string"
            ? JSON.parse(r.dados)
            : r.dados || {};
      } catch {
        dados = {};
      }

      const email = r.email || dados?.email || `lead-${idx}`;

      // =============================
      // 🔥 NORMALIZA NOVO SAQUE
      // =============================
      const novoSaque = dados?.dadosContratacaoNovoSaque || null;
      const simulacao = novoSaque?.simulacao || {};

      const parcelas = Number(simulacao.parcelas);
      const valorParcela = Number(simulacao.valorParcela);

      return {
        id: email,
        email,
        cpf: r.cpf,
        etapa: r.etapa,

        updated_at: dados?.crm?.updatedAt || r.updated_at,

        dados: {
          // 🔒 PRESERVA TUDO QUE JÁ EXISTE
          ...dados,

          // 🔒 BASE CONSOLIDADA
          cpf: dados?.cpf || r.cpf,
          nome: dados?.nome || "",
          telefone: dados?.telefone || "",
          email: dados?.email || email,

          // 🔥 GARANTE CAMPOS DE CRÉDITO PARA O CRM
          tempo_servico_clt:
            dados?.tempo_servico_clt ?? r.tempo_servico_clt ?? null,

          margem_consignavel:
            dados?.margem_consignavel ?? r.margem_consignavel ?? null,

          // 🔥 NOVO SAQUE (SEM QUEBRAR DADOS ANTIGOS)
          novoSaque: novoSaque
            ? {
                nomeMae:
                  novoSaque?.contratacao?.mother_name || null,
                rg:
                  novoSaque?.contratacao?.rg || null,
                dataNascimento:
                  novoSaque?.contratacao?.birth_date || null,

                endereco: {
                  cep:
                    novoSaque?.contratacao?.entity_attributes
                      ?.address_attributes?.zip_code || null,
                  rua:
                    novoSaque?.contratacao?.entity_attributes
                      ?.address_attributes?.street || null,
                  bairro:
                    novoSaque?.contratacao?.entity_attributes
                      ?.address_attributes?.district || null,
                  numero:
                    novoSaque?.contratacao?.entity_attributes
                      ?.address_attributes?.number || null,
                },

                bancoCartao:
                  novoSaque?.contratacao?.bank_account_attributes
                    ?.name_bank || null,

                invoiceDueDay:
                  novoSaque?.contratacao?.invoice_due_day || null,

                parcelas,
                valorParcela,
                taxaJurosMensal: Number(simulacao.taxaJurosMensal),

                valorSimulado:
                  Number.isFinite(parcelas) &&
                  Number.isFinite(valorParcela)
                    ? Number(
                        (parcelas * valorParcela).toFixed(2)
                      )
                    : null,
              }
            : dados?.novoSaque ?? null,

          // 🔒 BLOCO CRM (SÓ CONTROLE)
          crm: {
            status: dados?.crm?.status || "NOVO",
            probability: dados?.crm?.probability || 20,
            statusAtendimento:
              dados?.crm?.statusAtendimento || "Não atendido",
            comentario: dados?.crm?.comentario || "",
            badges: dados?.crm?.badges || [],
            updatedAt: dados?.crm?.updatedAt || null,
            dataSimulacao:
              dados?.crm?.dataSimulacao ||
              r.dataSimulacao ||
              null,
          },
        },
      };
    });

    return res.json({ leads });
  } catch (err) {
    console.error("[CRM][LIST]", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});



// ================= CRM - ATUALIZAR LEAD (VERSÃO CORRIGIDA) =================
app.put("/admin/crm/lead", async (req, res) => {
  try {
    const token = req.headers["authorization"];
    if (token !== "admin-token-secreto-nitz") {
      return res.status(401).json({ error: "Não autorizado" });
    }

    // 🔑 AGORA INCLUINDO BADGES
    const { email, status, probability, comentario, badges } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email é obrigatório" });
    }

    // 1️⃣ Buscar dados atuais
    const [rows] = await pool.query(
      "SELECT dados FROM progresso_proposta WHERE email = ? LIMIT 1",
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Lead não encontrado" });
    }

    let dados = {};
    try {
      dados =
        typeof rows[0].dados === "string"
          ? JSON.parse(rows[0].dados)
          : rows[0].dados;
    } catch {
      dados = {};
    }

    // 2️⃣ Atualizar bloco CRM (MERGE SEGURO)
    dados.crm = {
      ...dados.crm,

      status: status ?? dados.crm?.status ?? "NOVO",

      probability:
        typeof probability === "number"
          ? probability
          : dados.crm?.probability ?? 20,

      comentario: comentario ?? dados.crm?.comentario ?? "",

      // ✅ PONTO CRÍTICO: BADGES
      badges: Array.isArray(badges)
        ? badges
        : dados.crm?.badges ?? [],

      statusAtendimento:
        (status ?? dados.crm?.status) === "PROPOSTA_ACEITA" ||
        (status ?? dados.crm?.status) === "PROPOSTA_RECUSADA"
          ? "Atendido"
          : "Não atendido",

      updatedAt: new Date().toISOString()
    };

    // 3️⃣ Salvar JSON (sem sobrescrever outras colunas)
    await pool.query(
      `
      UPDATE progresso_proposta
      SET dados = ?
      WHERE email = ?
      `,
      [JSON.stringify(dados), email]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[CRM][UPDATE]", err);
    return res.status(500).json({ error: "Erro interno" });
  }
});





// -------------------- LISTAR TODAS AS OPERAÇÕES --------------------
app.get("/presenca/operacoes", async (req, res) => {
  try {
    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );

    if (!login.sucesso)
      return res.status(401).json({ sucesso: false, erro: "Login falhou" });

    const resp = await axios.get(
      "https://presenca-bank-api.azurewebsites.net/operacoes",
      {
        headers: {
          Authorization: `Bearer ${login.token}`,
          accept: "application/json",
        },
        httpsAgent,
      }
    );

    return res.json({
      sucesso: true,
      result: resp.data,
    });
  } catch (err) {
    console.error("[PRESENCA][OPERACOES] ERRO:", err.response?.data || err);
    return res.status(500).json({
      sucesso: false,
      erro: err.response?.data || err.message,
    });
  }
});
// =================== PEGAR OPERAÇÃO ESPECÍFICA POR ID ===================
// PEGAR OPERAÇÃO ESPECÍFICA POR ID (BUSCA NO ARRAY GERAL)
app.get("/presenca/operacoes/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );
    if (!login.sucesso)
      return res.status(401).json({ sucesso: false, erro: "Login falhou" });

    // 1) BUSCAR TODAS AS OPERAÇÕES
    const resp = await axios.get(
      "https://presenca-bank-api.azurewebsites.net/operacoes",
      {
        headers: {
          Authorization: `Bearer ${login.token}`,
          accept: "application/json",
        },
        httpsAgent,
      }
    );

    const lista = resp.data?.result || [];

    // 2) LOCALIZAR A OPERAÇÃO PELO ID
    const operacao = lista.find(op => op.id == id);

    if (!operacao) {
      return res.status(404).json({
        sucesso: false,
        erro: `Operação ${id} não encontrada na lista`,
      });
    }

    // 3) RETORNAR EXATAMENTE O QUE O FRONT USA
    return res.json({
      sucesso: true,
      result: operacao, // <- O FRONT USA ISSO AQUI
    });

  } catch (err) {
    console.error("[OPERACAO-ID] ERRO:", err.response?.data || err);
    return res.status(500).json({
      sucesso: false,
      erro: err.response?.data || err.message,
    });
  }
});


// -------------------- LOGIN SOCIAL ORIGINAL --------------------
app.post("/auth/social", async (req, res) => {
  try {
    console.log("\n[AUTH SOCIAL] Requisição recebida:", req.body);

    const { cpf, nome, email, telefone } = req.body;

    if (!email) {
      console.log("[AUTH SOCIAL] ERRO: Email ausente");
      return res.status(400).json({ sucesso: false, erro: "Email é obrigatório" });
    }

    const cpfFinal = cpf ? cpf.replace(/\D/g, "") : null;

    console.log("[AUTH SOCIAL] CPF tratado:", cpfFinal);

    console.log("[AUTH SOCIAL] Buscando usuário por email:", email);

    const [rows] = await pool.query(
      "SELECT * FROM usuarios WHERE email = ? LIMIT 1",
      [email]
    );

    let usuario = rows[0];

    if (!usuario) {
      console.log("[AUTH SOCIAL] Usuário não existe. Criando novo...");

      try {
        await pool.query(
          "INSERT INTO usuarios (cpf, nome, email, telefone) VALUES (?, ?, ?, ?)",
          [cpfFinal, nome, email, telefone]
        );
      } catch (dbErr) {
        console.log("[AUTH SOCIAL] ERRO AO INSERIR:", dbErr);
        return res.status(500).json({ sucesso: false, erro: dbErr.message });
      }

      const [novo] = await pool.query(
        "SELECT * FROM usuarios WHERE email = ? LIMIT 1",
        [email]
      );

      usuario = novo[0];
      console.log("[AUTH SOCIAL] Usuário criado com sucesso:", usuario);

    } else {
      console.log("[AUTH SOCIAL] Usuário já existia:", usuario);
    }

    return res.json({
      sucesso: true,
      usuario
    });

  } catch (err) {
    console.error("[AUTH SOCIAL] ERRO GERAL:", err);
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});


// =====================================================================================
// =====================================================================================
//                ⬇️    ROTAS NOVAS PARA FUNCIONAR O SEU FRONTEND    ⬇️
// =====================================================================================
// =====================================================================================


// -------------------- ROTAS NECESSÁRIAS PARA O SIMULADOR / LOGIN --------------------

// 1️⃣ ROTA /cadastro (POST)
app.post("/cadastro", async (req, res) => {
  try {
    const { nome, email, cpf, telefone } = req.body;

    await pool.query(
      `INSERT INTO usuarios (cpf, nome, email, telefone)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nome=?, telefone=?`,
      [cpf, nome, email, telefone, nome, telefone]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2️⃣ ROTA /cadastro-social (POST)
app.post("/cadastro-social", async (req, res) => {
  try {
    const { nome, email, cpf, telefone } = req.body;

    await pool.query(
      `INSERT INTO usuarios (cpf, nome, email, telefone)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nome=?, telefone=?`,
      [cpf, nome, email, telefone, nome, telefone]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3️⃣ ROTA GET /usuario/:cpf
app.get("/usuario/:cpf", async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/\D/g, "");

    const [rows] = await pool.query(
      "SELECT * FROM usuarios WHERE cpf = ? LIMIT 1",
      [cpf]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// -------------------- PROGRESSO / SALVAR E RECUPERAR --------------------

// POST /progresso/salvar
app.post("/progresso/salvar", async (req, res) => {
  try {
    const { email, cpf, etapa, dados } = req.body;
    if (!email) return res.status(400).json({ success: false, error: "Email obrigatório" });

    const dadosJson = JSON.stringify(dados ?? {});

    await pool.query(
  `INSERT INTO progresso_proposta (email, cpf, etapa, dados)
   VALUES (?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE cpf = VALUES(cpf), etapa = VALUES(etapa), dados = VALUES(dados), updated_at = CURRENT_TIMESTAMP`,
  [email, cpf, etapa, JSON.stringify(dados)]
);


    res.json({ success: true });
  } catch (err) {
    console.error("[PROGRESSO/SALVAR] ERRO:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /progresso/:email
app.get("/progresso/:email", async (req, res) => {
  try {
    const email = req.params.email;
    if (!email) return res.status(400).json({ success: false, error: "Email obrigatório" });

    const [rows] = await pool.query("SELECT * FROM progresso_proposta WHERE email = ? LIMIT 1", [email]);

    if (!rows.length) return res.json({ existe: false });

    const item = rows[0];
    res.json({
      existe: true,
      email: item.email,
      cpf: item.cpf,
      etapa: item.etapa,
      dados: item.dados ? JSON.parse(item.dados) : {}
    });
  } catch (err) {
    console.error("[PROGRESSO/GET] ERRO:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// =====================================================================================


// ROTA PARA MANTER SERVIDOR ACORDADO
app.get("/ping", (req, res) => {
  res.send("pong");
});

// AUTO-PING PARA IMPEDIR O RENDER DE DORMIR
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || ""; // Render define isso automaticamente

if (RENDER_URL) {
  console.log("[KEEP-ALIVE] Mantendo servidor acordado:", RENDER_URL);

  setInterval(() => {
    axios
      .get(`${RENDER_URL}/ping`)
      .then(() => console.log("[KEEP-ALIVE] ping enviado"))
      .catch(() => console.log("[KEEP-ALIVE] ping falhou"));
  }, 4 * 60 * 1000); // a cada 4 minutos
}

// -------------------- SERVIDOR --------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () =>
  console.log(`Servidor rodando na porta ${PORT}`)
);