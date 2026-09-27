// =====================================================================================
//  BACKEND — CRÉDITO CLT (Kant Digital)
//  Focado exclusivamente no produto Crédito CLT (Presença Bank).
//  FGTS, Novo Saque e Car Equity (C6) foram removidos deste arquivo.
// =====================================================================================

// -------------- imports ------------------
import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import axios from "axios";
import https from "https";

import { iniciarSessaoPresenca } from "./services/presencaLogin.js";
import { criarOperacaoCLT } from "./services/presencaProposta.js";

import {
  criarTermo,
  consultarVinculo,
  consultarMargem,
  simularTabelas,
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
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// -------------------- LOG GLOBAL DE REQUISIÇÕES --------------------
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`\n[REQ] ${ts} ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT"].includes(req.method)) {
    console.log("[REQ BODY]", JSON.stringify(req.body));
  }
  next();
});

// -------------------- CREDENCIAIS ADMIN (via .env, com fallback) --------------------
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || "adm_nitz";
const ADMIN_SENHA = process.env.ADMIN_SENHA || "H!p0tenusa";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin-token-secreto-nitz";

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

  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS usuarios (
      cpf VARCHAR(14),
      nome VARCHAR(100) NOT NULL,
      email VARCHAR(120) PRIMARY KEY,
      telefone VARCHAR(20),
      data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `.trim()
  );

  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS progresso_proposta (
      email VARCHAR(120) PRIMARY KEY,
      cpf VARCHAR(14),
      etapa INT DEFAULT 1,
      dados JSON,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
    `.trim()
  );

  console.log("[MYSQL] Tabelas OK");
})();

// ============================================================================
//                    LOGS DE ETAPA — VISIBILIDADE DO FUNIL CLT
// ============================================================================
// Rótulos exibidos no console para cada evento do funil de Crédito CLT.
// O front-end deve chamar POST /presenca/rastreio nos seguintes momentos:
//   1) evento: "clique_simular"  -> assim que o usuário clica no botão "Simular Crédito"
//   2) evento: "etapa_1"         -> assim que a Etapa 1 (Informações Profissionais) é concluída
//   3) evento: "etapa_2"         -> assim que a Etapa 2 (Informações Pessoais) é concluída
const ROTULOS_EVENTO_CLT = {
  clique_simular: "🖱️  [CLT][CLIQUE-SIMULAR] Usuário iniciou a simulação",
  etapa_1: "📋 [CLT][ETAPA 1] Informações Profissionais preenchidas",
  etapa_2: "✅ [CLT][ETAPA 2] Informações Pessoais preenchidas (envio ao WhatsApp)",
};

const ETAPA_NUMERICA_EVENTO = {
  clique_simular: 0,
  etapa_1: 1,
  etapa_2: 2,
};

app.post("/presenca/rastreio", async (req, res) => {
  try {
    const { email, cpf, evento, dados } = req.body || {};

    if (!evento) {
      console.log("🟥 [CLT][RASTREIO] Requisição sem campo 'evento'");
      return res.status(400).json({ sucesso: false, erro: "Campo 'evento' é obrigatório" });
    }

    const rotulo = ROTULOS_EVENTO_CLT[evento] || `[CLT][EVENTO] ${evento}`;

    console.log(`\n${rotulo}`);
    console.log("  ↳ Email:", email || "(sem email ainda)");
    console.log("  ↳ CPF:", cpf || "(sem cpf ainda)");
    if (dados) console.log("  ↳ Dados:", JSON.stringify(dados, null, 2));

    // Persiste o avanço do funil (quando já houver e-mail identificado)
    if (email) {
      const etapaNumerica = ETAPA_NUMERICA_EVENTO[evento] ?? 0;

      await pool.query(
        `INSERT INTO progresso_proposta (email, cpf, etapa, dados)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           cpf = VALUES(cpf),
           etapa = VALUES(etapa),
           dados = VALUES(dados),
           updated_at = CURRENT_TIMESTAMP`,
        [
          email,
          cpf || null,
          etapaNumerica,
          JSON.stringify({ evento, bancoSelecionado: "presenca_clt", ...dados }),
        ]
      );
    }

    return res.json({ sucesso: true });
  } catch (err) {
    console.error("🟥 [CLT][RASTREIO][ERRO]:", err);
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// ============================================================================
//                    PRESENÇA — CRÉDITO CLT (fluxo principal)
// ============================================================================

// -------------------- TERMO --------------------
app.post("/presenca/termo", async (req, res) => {
  console.log("\n📥 [CLT][TERMO] Recebido:", req.body);

  try {
    console.log("🔐 [CLT][TERMO] Iniciando login na Presença...");
    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );

    console.log("🔐 [CLT][TERMO] Login resposta:", login?.sucesso);

    if (!login.sucesso) {
      console.log("🟥 [CLT][TERMO] ERRO LOGIN");
      return res.json({ sucesso: false, erro: "Login falhou", login });
    }

    console.log("📝 [CLT][TERMO] Criando termo...");
    const result = await criarTermo(login.token, req.body);

    console.log("📤 [CLT][TERMO] Resposta criarTermo:", result);

    return res.json(result);
  } catch (error) {
    console.log("🟥 [CLT][TERMO][EXCEPTION]:", error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// -------------------- CONSULTAR VÍNCULO --------------------
app.post("/presenca/vinculo", async (req, res) => {
  try {
    console.log("🔎 [CLT][VINCULO] Consultando vínculo para CPF:", req.body?.cpf);

    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );
    if (!login.sucesso) return res.json(login);

    const { cpf } = req.body;

    const vinculo = await consultarVinculo(login.token, cpf);

    if (!vinculo.sucesso || !vinculo.dados?.id?.length) {
      console.log("🟨 [CLT][VINCULO] Nenhum vínculo elegível encontrado");
      return res.json({ vinculo, margem: null });
    }

    const item = vinculo.dados.id[0];

    await esperar(2000);

    const margem = await consultarMargem(login.token, {
      cpf,
      matricula: item.matricula,
      cnpj: item.numeroInscricaoEmpregador,
    });

    console.log("🟩 [CLT][VINCULO] Consulta concluída");

    return res.json({ vinculo, margem });
  } catch (err) {
    console.error("🟥 [CLT][VINCULO][ERRO]:", err);
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// -------------------- HELPERS DE RETENTATIVA --------------------
async function tentarVariasVezes(fn, tentativas = 5, intervalo = 1200) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const resultado = await fn();
      if (resultado) return resultado;
    } catch {
      // ignora e tenta novamente
    }
    await esperar(intervalo);
  }
  return null;
}

async function obterVinculoCompleto(token, cpf) {
  return await tentarVariasVezes(async () => {
    const vinculo = await consultarVinculo(token, cpf);
    if (!vinculo?.sucesso) return null;
    if (!vinculo?.dados?.id?.length) return null;

    const info = vinculo.dados.id.find((v) => v.elegivel) || vinculo.dados.id[0];

    if (!info?.matricula) return null;
    if (!info?.numeroInscricaoEmpregador) return null;

    return info;
  });
}

async function obterMargemCompleta(token, cpf, info) {
  return await tentarVariasVezes(async () => {
    const margem = await consultarMargem(token, {
      cpf,
      matricula: info.matricula,
      cnpj: info.numeroInscricaoEmpregador,
    });

    if (!margem?.sucesso || !margem?.dados?.length) return null;

    const mg = margem.dados.find((m) => m.valorMargem > 0) || margem.dados[0];

    if (!mg?.nomeMae) return null;
    if (!mg?.dataNascimento) return null;
    if (!mg?.sexo) return null;

    return mg;
  });
}

// -------------------- SIMULAR --------------------
app.post("/presenca/simular", async (req, res) => {
  try {
    const { cpf, nome, telefone, email } = req.body;

    console.log("🚀 [CLT][SIMULAR] Iniciando simulação para CPF:", cpf);

    const login = await iniciarSessaoPresenca(
      process.env.PRESENCA_LOGIN,
      process.env.PRESENCA_PASSWORD
    );
    if (!login.sucesso) return res.json(login);

    console.log("🔎 [CLT][SIMULAR] Buscando vínculo completo...");
    const info = await obterVinculoCompleto(login.token, cpf);

    if (!info) {
      console.log("🟥 [CLT][SIMULAR] Vínculo completo não encontrado");
      return res.status(400).json({
        sucesso: false,
        erro: "Não foi possível obter vínculo completo para simulação",
      });
    }

    console.log("🔎 [CLT][SIMULAR] Buscando margem completa...");
    const mg = await obterMargemCompleta(login.token, cpf, info);

    if (!mg) {
      console.log("🟥 [CLT][SIMULAR] Margem completa não encontrada");
      return res.status(400).json({
        sucesso: false,
        erro: "Não foi possível obter margem completa (nomeMae, dataNascimento, sexo...)",
      });
    }

    const payloadFinal = {
      proposta: {
        valorSolicitado: 0,
        quantidadeParcelas: 0,
        produtoId: 28,
        valorParcela: mg.valorMargem ?? mg.valorMargemAvaliavel ?? 0,
        tabelaId: 0,
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
          bairro: "",
        },
        telefone: {
          ddd: telefone.substring(0, 2),
          numero: telefone.substring(2),
        },
        vinculoEmpregaticio: {
          cnpjEmpregador: mg.numeroInscricaoEmpregador || info.numeroInscricaoEmpregador,
          registroEmpregaticio: mg.matricula || info.matricula,
        },
        dadosBancarios: {
          codigoBanco: "",
          agencia: "",
          conta: "",
          digitoConta: "",
          formaCredito: "",
        },
        tenantId: "bb697451-7fae-41bf-a4b7-53db7c1f8197",
      },
    };

    console.log("📤 [CLT][SIMULAR] Enviando payload para simulação...");
    const resultado = await simularTabelas(login.token, payloadFinal);

    if (!resultado?.simulacoes?.length) {
      console.log("🟥 [CLT][SIMULAR] Simulação não retornou ofertas");
      return res.status(400).json({
        sucesso: false,
        erro: "Simulação não retornou ofertas",
      });
    }

    const simulacoesEnriquecidas = resultado.simulacoes.map((sim) => ({
      ...sim,
      nomeMae: mg.nomeMae,
      dataNascimento: mg.dataNascimento,
      sexo: mg.sexo,
      matricula: mg.matricula || info.matricula,
      numeroInscricaoEmpregador: mg.numeroInscricaoEmpregador || info.numeroInscricaoEmpregador,
    }));

    const maior = simulacoesEnriquecidas.reduce((m, s) =>
      s.valorLiberado > m.valorLiberado ? s : m
    );

    console.log("🟩 [CLT][SIMULAR] Melhor simulação encontrada:", {
      valorLiberado: maior.valorLiberado,
      prazo: maior.prazo,
    });

    return res.json({
      sucesso: true,
      melhorSimulacao: maior,
      payload_enviado: payloadFinal,
      resposta: resultado,
      vinculo: info,
      margem: mg,
    });
  } catch (err) {
    console.error("🟥 [CLT][SIMULAR][ERRO]:", err);
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// -------------------- CRIAR OPERAÇÃO --------------------
app.post("/presenca/operacao", async (req, res) => {
  try {
    console.log("\n======================================");
    console.log("🔥 [CLT][OPERACAO] NOVA REQUISIÇÃO");
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

    console.log("🔍 [CLT][OPERACAO] Buscando vínculo do CPF:", cpf);
    const vinculo = await consultarVinculo(login.token, cpf);
    if (!vinculo.sucesso || !vinculo.dados?.id?.length)
      return res.status(400).json({ sucesso: false, erro: "Vínculo não encontrado" });

    const info = vinculo.dados.id.find((v) => v.elegivel === true) || vinculo.dados.id[0];

    const payloadFinal = {
      type: "credito-privado-v3",
      proposta: {
        valorSolicitado: incoming.proposta.valorSolicitado,
        quantidadeParcelas: incoming.proposta.quantidadeParcelas,
        produtoId: incoming.proposta.produtoId,
        valorParcela: incoming.proposta.valorParcela,
        tabelaId: incoming.proposta.tabelaId,
      },
      tomador: {
        ...incoming.tomador,
        vinculoEmpregaticio: {
          cnpjEmpregador: info.numeroInscricaoEmpregador,
          registroEmpregaticio: info.matricula,
        },
      },
      representante: {
        cpf,
        nome: incoming.tomador.nome,
        nomeMae: incoming.tomador.nomeMae || "",
        dataNascimento: incoming.tomador.dataNascimento || "",
      },
      documentos: [],
    };

    console.log("\n📦 [CLT][OPERACAO] Payload enviado ao Presença:");
    console.log(JSON.stringify(payloadFinal, null, 2));

    const resposta = await criarOperacaoCLT(login.token, payloadFinal);
    console.log("\n📩 [CLT][OPERACAO] Resposta criarOperacaoCLT:", resposta);

    const operacaoId = resposta?.id;

    if (!operacaoId) {
      console.log("🟥 [CLT][OPERACAO] ERRO: Criar operação não retornou ID!");
      return res.json({ sucesso: false, erro: "ID da operação ausente" });
    }

    console.log(`\n🎯 [CLT][OPERACAO] OPERAÇÃO CRIADA COM ID: ${operacaoId}`);

    // -------- POOLING: ESPERAR OPERAÇÃO APARECER --------
    async function buscarOperacaoAteAchar(id) {
      for (let i = 1; i <= 40; i++) {
        console.log(`[CLT][OPERACAO][POOLING] Tentativa ${i}/40 para achar operação ${id}`);

        try {
          const resp = await axios.get(
            "https://presenca-bank-api.azurewebsites.net/operacoes",
            { headers: { Authorization: `Bearer ${login.token}` }, httpsAgent }
          );

          const lista = resp.data?.result || [];
          const op = lista.find((o) => Number(o.id) === Number(id));

          if (op) {
            console.log("[CLT][OPERACAO][POOLING] 🎯 ENCONTRADA!");
            return op;
          }
          console.log("[CLT][OPERACAO][POOLING] ❌ Ainda não apareceu...");
        } catch (err) {
          console.log("[CLT][OPERACAO][POOLING] ERRO:", err.message);
        }

        await esperar(1500);
      }

      console.log("[CLT][OPERACAO][POOLING] ❌ NÃO ENCONTRADA APÓS 40 TENTATIVAS!");
      return null;
    }

    let operacao = await buscarOperacaoAteAchar(operacaoId);

    // -------- POOLING: ESPERAR LINK DE FORMALIZAÇÃO --------
    async function buscarLinkAteAchar(op) {
      for (let i = 1; i <= 30; i++) {
        const atual = op?.formalizacao?.link || null;

        console.log(`[CLT][OPERACAO][LINK] Tentativa ${i}/30 — valor atual:`, atual);

        if (atual) {
          console.log("[CLT][OPERACAO][LINK] 🎯 LINK ENCONTRADO!");
          return atual;
        }

        try {
          const resp = await axios.get(
            "https://presenca-bank-api.azurewebsites.net/operacoes",
            { headers: { Authorization: `Bearer ${login.token}` }, httpsAgent }
          );

          const lista = resp.data?.result || [];
          op = lista.find((o) => Number(o.id) === Number(op.id));

          if (op?.formalizacao?.link) {
            console.log("[CLT][OPERACAO][LINK] 🎉 LINK APARECEU:", op.formalizacao.link);
            return op.formalizacao.link;
          }
        } catch {
          // ignora e tenta novamente
        }

        await esperar(2000);
      }

      console.log("[CLT][OPERACAO][LINK] ❌ LINK NÃO ENCONTRADO APÓS 30 TENTATIVAS!");
      return null;
    }

    let linkFormalizacao = operacao ? await buscarLinkAteAchar(operacao) : null;

    const respostaFinal = {
      sucesso: true,
      id: operacaoId,
      formalizacaoLink: linkFormalizacao,
    };

    console.log("\n======================================");
    console.log("🔥 [CLT][OPERACAO] RESPOSTA ENVIADA PARA O FRONT:");
    console.log(JSON.stringify(respostaFinal, null, 2));
    console.log("======================================\n");

    return res.json(respostaFinal);
  } catch (err) {
    console.error("🟥 [CLT][OPERACAO][ERRO]:", err);
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// -------------------- LISTAR TODAS AS OPERAÇÕES --------------------
app.get("/presenca/operacoes", async (req, res) => {
  try {
    console.log("📄 [CLT][OPERACOES] Listando operações...");

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
    console.error("🟥 [CLT][OPERACOES][ERRO]:", err.response?.data || err);
    return res.status(500).json({
      sucesso: false,
      erro: err.response?.data || err.message,
    });
  }
});

// -------------------- PEGAR OPERAÇÃO ESPECÍFICA POR ID --------------------
app.get("/presenca/operacoes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    console.log("📄 [CLT][OPERACAO-ID] Buscando operação:", id);

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

    const lista = resp.data?.result || [];
    const operacao = lista.find((op) => Number(op.id) === Number(id));

    if (!operacao) {
      console.log(`🟨 [CLT][OPERACAO-ID] Operação ${id} não encontrada na lista`);
      return res.status(404).json({
        sucesso: false,
        erro: `Operação ${id} não encontrada na lista`,
      });
    }

    return res.json({
      sucesso: true,
      result: operacao,
    });
  } catch (err) {
    console.error("🟥 [CLT][OPERACAO-ID][ERRO]:", err.response?.data || err);
    return res.status(500).json({
      sucesso: false,
      erro: err.response?.data || err.message,
    });
  }
});

// ============================================================================
//                                ROTAS DO ADMIN
// ============================================================================

app.post("/admin/login", (req, res) => {
  const { login, senha } = req.body;

  if (login === ADMIN_LOGIN && senha === ADMIN_SENHA) {
    console.log("🔐 [ADMIN][LOGIN] Login bem-sucedido");
    return res.json({ success: true, token: ADMIN_TOKEN });
  }

  console.log("🟥 [ADMIN][LOGIN] Credenciais inválidas");
  return res.status(401).json({ success: false, error: "Credenciais inválidas" });
});

app.get("/admin/dashboard-data", async (req, res) => {
  try {
    const token = req.headers["authorization"];
    if (token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: "Não autorizado" });
    }

    const { periodo } = req.query;

    let where = "";
    let params = [];

    if (periodo && periodo !== "tudo") {
      const dias =
        periodo === "hoje" ? 1 : periodo === "3dias" ? 3 : periodo === "7dias" ? 7 : 30;

      where = "WHERE updated_at >= NOW() - INTERVAL ? DAY";
      params.push(dias);
    }

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

    const funilEtapas = {};
    const empresasTamanho = {
      "Menos de 20 funcionários": 0,
      "Mais de 20 funcionários": 0,
      "100 ou mais funcionários": 0,
      "Não informado": 0,
    };

    let elegiveis = 0;
    let naoElegiveis = 0;

    const tabela = [];

    for (const row of rows) {
      let data = {};

      try {
        data = typeof row.dados === "string" ? JSON.parse(row.dados) : row.dados || {};
      } catch {
        data = {};
      }

      // FUNIL DE ETAPAS
      funilEtapas[row.etapa] = (funilEtapas[row.etapa] || 0) + 1;

      // TAMANHO EMPRESA
      const tamanho = data.tamanhoEmpresa || "Não informado";
      if (empresasTamanho[tamanho] !== undefined) empresasTamanho[tamanho]++;
      else empresasTamanho["Não informado"]++;

      // ELEGIBILIDADE
      const totalMeses = (Number(data.anosContrato) || 0) * 12 + (Number(data.mesesContrato) || 0);
      const empresaOK = tamanho !== "Menos de 20 funcionários" && tamanho !== "Não informado";
      const elegivel = totalMeses >= 6 && empresaOK;

      if (elegivel) elegiveis++;
      else naoElegiveis++;

      tabela.push({
        email: row.email,
        cpf: row.cpf,
        etapa: row.etapa,
        updated_at: new Date(new Date(row.updated_at).getTime() + 3 * 60 * 60 * 1000).toISOString(),
        dados: {
          ...data,
          cpf: data.cpf || row.cpf,
          email: data.email || row.email,
          nome: data.nome || "",
          telefone: data.telefone || "",
          tamanhoEmpresa: tamanho,
          bancoSelecionado: "presenca_clt",
          elegivel: elegivel ? "Elegível" : "Não elegível",
          anosContrato: Number(data.anosContrato) || 0,
          mesesContrato: Number(data.mesesContrato) || 0,
        },
      });
    }

    const funil = Object.entries(funilEtapas).map(([etapa, quantidade]) => ({
      etapa: Number(etapa),
      quantidade,
    }));

    res.json({
      total,
      funil,
      empresasTamanho,
      elegiveis,
      naoElegiveis,
      tabela,
    });
  } catch (err) {
    console.error("🟥 [ADMIN][DASHBOARD-DATA][ERRO]:", err);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});

// ================= CRM - LISTAR LEADS =================
app.get("/admin/crm/leads", async (req, res) => {
  try {
    const token = req.headers["authorization"];
    if (token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: "Não autorizado" });
    }

    const [rows] = await pool.query(`
      SELECT email, cpf, etapa, dados, updated_at
      FROM progresso_proposta
      ORDER BY updated_at DESC
    `);

    const leads = rows.map((r, idx) => {
      let dados = {};
      try {
        dados = typeof r.dados === "string" ? JSON.parse(r.dados) : r.dados || {};
      } catch {
        dados = {};
      }

      const email = r.email || dados?.email || `lead-${idx}`;

      return {
        id: email,
        email,
        cpf: r.cpf,
        etapa: r.etapa,
        updated_at: dados?.crm?.updatedAt || r.updated_at,
        dados: {
          ...dados,
          crm: {
            status: dados?.crm?.status || "NOVO",
            probability: dados?.crm?.probability || 20,
            statusAtendimento: dados?.crm?.statusAtendimento || "Não atendido",
            comentario: dados?.crm?.comentario || "",
            updatedAt: dados?.crm?.updatedAt || null,
          },
        },
      };
    });

    res.json({ leads });
  } catch (err) {
    console.error("🟥 [ADMIN][CRM][LIST][ERRO]:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// ================= CRM - ATUALIZAR LEAD =================
app.put("/admin/crm/lead", async (req, res) => {
  try {
    const token = req.headers["authorization"];
    if (token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: "Não autorizado" });
    }

    const { email, status, probability, comentario } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email é obrigatório" });
    }

    const [rows] = await pool.query(
      "SELECT dados FROM progresso_proposta WHERE email = ? LIMIT 1",
      [email]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Lead não encontrado" });
    }

    let dados = {};
    try {
      dados = typeof rows[0].dados === "string" ? JSON.parse(rows[0].dados) : rows[0].dados || {};
    } catch {
      dados = {};
    }

    dados.crm = {
      ...dados.crm,
      status: status ?? dados.crm?.status ?? "NOVO",
      probability: probability ?? dados.crm?.probability ?? 20,
      comentario: comentario ?? dados.crm?.comentario ?? "",
      statusAtendimento:
        status === "PROPOSTA_ACEITA" || status === "PROPOSTA_RECUSADA"
          ? "Atendido"
          : "Não atendido",
    };

    await pool.query(
      `
      UPDATE progresso_proposta
      SET dados = ?
      WHERE email = ?
      `,
      [JSON.stringify(dados), email]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("🟥 [ADMIN][CRM][UPDATE][ERRO]:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// -------------------- LOGIN SOCIAL --------------------
app.post("/auth/social", async (req, res) => {
  try {
    console.log("\n[AUTH SOCIAL] Requisição recebida:", req.body);

    const { cpf, nome, email, telefone } = req.body;

    if (!email) {
      console.log("🟥 [AUTH SOCIAL] ERRO: Email ausente");
      return res.status(400).json({ sucesso: false, erro: "Email é obrigatório" });
    }

    const cpfFinal = cpf ? cpf.replace(/\D/g, "") : null;

    const [rows] = await pool.query("SELECT * FROM usuarios WHERE email = ? LIMIT 1", [email]);

    let usuario = rows[0];

    if (!usuario) {
      console.log("[AUTH SOCIAL] Usuário não existe. Criando novo...");

      try {
        await pool.query(
          "INSERT INTO usuarios (cpf, nome, email, telefone) VALUES (?, ?, ?, ?)",
          [cpfFinal, nome, email, telefone]
        );
      } catch (dbErr) {
        console.log("🟥 [AUTH SOCIAL] ERRO AO INSERIR:", dbErr);
        return res.status(500).json({ sucesso: false, erro: dbErr.message });
      }

      const [novo] = await pool.query("SELECT * FROM usuarios WHERE email = ? LIMIT 1", [email]);
      usuario = novo[0];
      console.log("🟩 [AUTH SOCIAL] Usuário criado com sucesso:", usuario);
    } else {
      console.log("[AUTH SOCIAL] Usuário já existia:", usuario);
    }

    return res.json({
      sucesso: true,
      usuario,
    });
  } catch (err) {
    console.error("🟥 [AUTH SOCIAL] ERRO GERAL:", err);
    return res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// -------------------- CADASTRO --------------------
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

app.get("/usuario/:cpf", async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/\D/g, "");

    const [rows] = await pool.query("SELECT * FROM usuarios WHERE cpf = ? LIMIT 1", [cpf]);

    if (!rows.length) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------- PROGRESSO / SALVAR E RECUPERAR --------------------
app.post("/progresso/salvar", async (req, res) => {
  try {
    const { email, cpf, etapa, dados } = req.body;
    if (!email) return res.status(400).json({ success: false, error: "Email obrigatório" });

    const dadosJson = JSON.stringify(dados ?? {});

    console.log(`💾 [CLT][PROGRESSO] Salvando progresso — email: ${email} | etapa: ${etapa}`);

    await pool.query(
      `INSERT INTO progresso_proposta (email, cpf, etapa, dados)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cpf = VALUES(cpf), etapa = VALUES(etapa), dados = VALUES(dados), updated_at = CURRENT_TIMESTAMP`,
      [email, cpf, etapa, dadosJson]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("🟥 [PROGRESSO/SALVAR] ERRO:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/progresso/:email", async (req, res) => {
  try {
    const email = req.params.email;
    if (!email) return res.status(400).json({ success: false, error: "Email obrigatório" });

    const [rows] = await pool.query(
      "SELECT * FROM progresso_proposta WHERE email = ? LIMIT 1",
      [email]
    );

    if (!rows.length) return res.json({ existe: false });

    const item = rows[0];
    res.json({
      existe: true,
      email: item.email,
      cpf: item.cpf,
      etapa: item.etapa,
      dados: item.dados ? JSON.parse(item.dados) : {},
    });
  } catch (err) {
    console.error("🟥 [PROGRESSO/GET] ERRO:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------- PING / KEEP-ALIVE --------------------
app.get("/ping", (req, res) => {
  res.send("pong");
});

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || "";

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

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));