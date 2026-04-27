import mysql from "mysql2/promise";
import axios from "axios";
import https from "https";
import dotenv from "dotenv";
import dayjs from "dayjs";

dotenv.config();

/* =====================================================
   CONFIG
===================================================== */
const BASE_URL = "https://presenca-bank-api.azurewebsites.net";
const INTERVALO_ENTRE_ENDPOINTS_MS = 2000; // 2s entre endpoints
const INTERVALO_ENTRE_CNPJS_MS = 3000;    // 3s entre CPFs/CNPJs
const TIMEOUT_MS = 10000;

/* =====================================================
   MYSQL POOL (MESMO PADRÃO DO BACKEND)
===================================================== */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
});

/* =====================================================
   HTTPS AGENT
===================================================== */
const httpsAgent = new https.Agent({
  checkServerIdentity: () => undefined,
  rejectUnauthorized: false,
});

/* =====================================================
   AXIOS
===================================================== */
const api = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT_MS,
  httpsAgent,
});

/* =====================================================
   UTILS
===================================================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const limparCpf = (cpf) => String(cpf || "").replace(/\D/g, "");

function escolherVinculoElegivel(vinculos) {
  return vinculos.find(v => v.elegivel === true) || vinculos[0] || null;
}

/* =====================================================
   PRESENÇA — LOGIN
===================================================== */
async function loginPresenca() {
  try {
    const resp = await api.post("/login", {
      login: process.env.PRESENCA_LOGIN,
      senha: process.env.PRESENCA_PASSWORD,
    });
    return resp.data?.token || null;
  } catch {
    return null;
  }
}

/* =====================================================
   CONSULTAR VÍNCULO
===================================================== */
async function consultarVinculo(token, cpf) {
  try {
    const resp = await api.post(
      "/v3/operacoes/consignado-privado/consultar-vinculos",
      { cpf },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return resp.data?.id || [];
  } catch {
    return [];
  }
}

/* =====================================================
   CONSULTAR MARGEM
===================================================== */
async function consultarMargem(token, payload) {
  try {
    const resp = await api.post(
      "/v3/operacoes/consignado-privado/consultar-margem",
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return resp.data || null;
  } catch {
    return null;
  }
}

/* =====================================================
   PROCESSO PRINCIPAL
===================================================== */
async function atualizarTempoEMargem() {
  console.log("🔐 Logando no Presença...");
  const token = await loginPresenca();

  if (!token) {
    console.error("❌ Falha no login Presença");
    return;
  }

  console.log("📥 Buscando CPFs da tabela progresso_proposta (ordenado por dataSimulacao DESC)...");

  const [rows] = await pool.query(`
    SELECT email, cpf
    FROM progresso_proposta
    WHERE cpf IS NOT NULL
      AND cpf <> ''
    ORDER BY dataSimulacao DESC
  `);

  console.log(`📊 ${rows.length} registros encontrados\n`);

  for (const row of rows) {
    const cpf = limparCpf(row.cpf);
    if (!cpf) continue;

    console.log(`➡️ Processando CPF ${cpf}`);

    try {
      /* ---------- CONSULTA VÍNCULO ---------- */
      const vinculos = await consultarVinculo(token, cpf);
      await sleep(INTERVALO_ENTRE_ENDPOINTS_MS);

      if (!vinculos.length) {
        console.log("⚠️ Nenhum vínculo encontrado");
        await salvarResultado(row.email, null, null);
        await sleep(INTERVALO_ENTRE_CNPJS_MS);
        continue;
      }

      const v = escolherVinculoElegivel(vinculos);
      if (!v?.matricula || !v?.numeroInscricaoEmpregador) {
        console.log("⚠️ Vínculo inválido");
        await salvarResultado(row.email, null, null);
        await sleep(INTERVALO_ENTRE_CNPJS_MS);
        continue;
      }

      /* ---------- CONSULTA MARGEM ---------- */
      const margem = await consultarMargem(token, {
        cpf,
        matricula: v.matricula,
        cnpj: v.numeroInscricaoEmpregador,
      });
      await sleep(INTERVALO_ENTRE_ENDPOINTS_MS);

      if (!margem?.dataAdmissao) {
        console.log("⚠️ Margem não retornou dataAdmissao");
        await salvarResultado(row.email, null, null);
        await sleep(INTERVALO_ENTRE_CNPJS_MS);
        continue;
      }

      const tempoDias = dayjs().diff(
        dayjs(margem.dataAdmissao),
        "day"
      );

      const valorMargem =
        margem.valorMargemDisponivel ??
        margem.valorMargem ??
        null;

      console.log(`✅ ${tempoDias} dias | Margem ${valorMargem}`);

      await salvarResultado(row.email, tempoDias, valorMargem);

    } catch (err) {
      console.error("❌ Erro inesperado:", err.message);
      await salvarResultado(row.email, null, null);
    }

    /* ---------- INTERVALO ENTRE CPFs / CNPJs ---------- */
    await sleep(INTERVALO_ENTRE_CNPJS_MS);
  }

  console.log("\n🏁 Finalizado.");
  process.exit(0);
}

/* =====================================================
   UPDATE NO BANCO
===================================================== */
async function salvarResultado(email, tempo, margem) {
  await pool.query(
    `
    UPDATE progresso_proposta
    SET
      tempo_servico_clt = ?,
      margem_consignavel = ?
    WHERE email = ?
    `,
    [tempo, margem, email]
  );
}

/* =====================================================
   EXECUÇÃO
===================================================== */
atualizarTempoEMargem();
