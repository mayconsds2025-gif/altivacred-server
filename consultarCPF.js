import axios from "axios";
import https from "https";
import dotenv from "dotenv";
import dayjs from "dayjs";
import readline from "readline";

dotenv.config();

/* =====================================================
   CONFIGURAÇÕES
===================================================== */
const BASE_URL = "https://presenca-bank-api.azurewebsites.net";
const TIMEOUT_MS = 8000;

/* =====================================================
   HTTPS AGENT
===================================================== */
const httpsAgent = new https.Agent({
  checkServerIdentity: () => undefined,
});

/* =====================================================
   AXIOS INSTANCE
===================================================== */
const api = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT_MS,
  httpsAgent,
});

/* =====================================================
   UTIL
===================================================== */
function normalizarCpf(cpf) {
  return String(cpf).replace(/\D/g, "").padStart(11, "0");
}

function mascararCpf(cpf) {
  return cpf.replace(
    /^(\d{3})(\d{3})(\d{3})(\d{2})$/,
    "$1.$2.$3-$4"
  );
}

function escolherVinculoElegivel(vinculos) {
  return vinculos.find((v) => v.elegivel === true) || null;
}

/* =====================================================
   LOGIN
===================================================== */
async function loginPresenca() {
  const resp = await api.post("/login", {
    login: process.env.PRESENCA_LOGIN,
    senha: process.env.PRESENCA_PASSWORD,
  });

  return resp.data.token;
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

    return resp.data;
  } catch {
    return null;
  }
}

/* =====================================================
   INPUT
===================================================== */
function perguntar(pergunta) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(pergunta, (resposta) => {
      rl.close();
      resolve(resposta);
    });
  });
}

/* =====================================================
   LOOP PRINCIPAL
===================================================== */
async function executar() {
  console.log("🔐 Realizando login...");
  const token = await loginPresenca();
  console.log("✅ Login realizado\n");

  while (true) {
    const cpfInput = await perguntar("Digite o CPF (ou 'sair'): ");

    if (cpfInput.toLowerCase() === "sair") {
      console.log("Encerrando...");
      process.exit(0);
    }

    const cpf = normalizarCpf(cpfInput);

    const vinculos = await consultarVinculo(token, cpf);

    if (!vinculos.length) {
      console.log(`❌ CPF ${mascararCpf(cpf)} sem vínculo encontrado\n`);
      continue;
    }

    const v = escolherVinculoElegivel(vinculos);

    if (!v) {
      console.log(
        `❌ CPF ${mascararCpf(cpf)} possui vínculos, mas nenhum elegível\n`
      );
      continue;
    }

    const margem = await consultarMargem(token, {
      cpf,
      matricula: v.matricula,
      cnpj: v.numeroInscricaoEmpregador,
    });

    if (!margem) {
      console.log("❌ Erro ao consultar margem\n");
      continue;
    }

    const tempoEmpresaDias = dayjs().diff(
      dayjs(margem.dataAdmissao),
      "day"
    );

    console.log("---------------------------------");
    console.log(`CPF: ${mascararCpf(cpf)}`);
    console.log(`Tempo de empresa: ${tempoEmpresaDias} dias`);
    console.log(`Margem disponível: R$ ${margem.valorMargemDisponivel}`);
    console.log("---------------------------------\n");
  }
}

executar().catch((err) => {
  console.error("Erro fatal:", err.message);
});
