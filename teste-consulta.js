import axios from "axios";
import dotenv from "dotenv";
import https from "https";

dotenv.config();

// ==================================================================
// 📋 LISTA DE CPFS
// ==================================================================
const LISTA_CPFS = [
  "71760151475",
  "56460451850",
  "6080735555",
  "98904990106",
  "63382165325",
  "439201012",
  "47019966888",
  "85869332524",
  "85869332524",
  "9785288676",
  "2289434000",
  "70318495279",
  "27380977822",
  "6448350284",
  "10432563776",
  "8677411984",
  "5886697500",
  "9674954902",
  "1611388376",
  "7762225382",
  "5126256114",
  "12071318498",
  "53555040944",
  "15082633708",
  "1740441192",
  "40594306841",
  "28052849845",
  "87477394287",
  "1645582175",
  "3852437156",
  "7368711524",
  "14416283636",
  "61026033381",
  "38569421818",
  "2699077003",
  "43577934832",
  "3424075116",
  "7273815632",
  "36337867831",
  "8186536981"
];

const LOGIN = process.env.PRESENCA_LOGIN;
const PASSWORD = process.env.PRESENCA_PASSWORD;

const BASE_URL = "https://presenca-bank-api.azurewebsites.net";
const URL_CONSULTA = `${BASE_URL}/v3/operacoes/consignado-privado/consultar-vinculos`;

const httpsAgent = new https.Agent({
  checkServerIdentity: () => undefined,
  rejectUnauthorized: false,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------- 1. LOGIN ---------------
async function login() {
  try {
    console.log("\n🔑 Realizando autenticação...");

    const resp = await axios.post(
      `${BASE_URL}/login`,
      { login: LOGIN, senha: PASSWORD },
      {
        httpsAgent,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      }
    );

    console.log("✔ Token obtido com sucesso.\n");
    return resp.data.token;

  } catch (err) {
    console.log("❌ ERRO NO LOGIN:", err.response?.data || err.message);
    process.exit(1);
  }
}

// --------------- 2. CONSULTAR CPF (VALIDANDO STATUS 200) ---------------
async function consultarCpf(token, cpf) {
  try {
    const body = { cpf: String(cpf) };

    const resp = await axios.post(
      URL_CONSULTA,
      body,
      {
        httpsAgent,
        headers: {
          Authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        // Opcional: validação padrão do axios já joga erro se for != 2xx
        // validateStatus: function (status) { return status >= 200 && status < 300; }
      }
    );

    // 🔹 FILTRO APENAS PELO STATUS CODE 200
    if (resp.status === 200) {
      console.log(`${cpf} OK`);
    }

  } catch (err) {
    // Se der erro (400, 401, 404, 500), cai aqui.
    // Não fazemos nada, pois só queremos logar os que deram 200.
    
    // Se quiser debugar, descomente abaixo:
    // console.log(`${cpf} FALHOU (Status: ${err.response?.status})`);
  }
}

// --------------- 3. EXECUÇÃO ---------------
(async () => {
  if (!LOGIN || !PASSWORD) {
    console.log("⚠ Configure PRESENCA_LOGIN e PRESENCA_PASSWORD no .env");
    return;
  }

  const token = await login();

  console.log(`🚀 Iniciando verificação de Status 200 em ${LISTA_CPFS.length} CPFs...\n`);

  for (let i = 0; i < LISTA_CPFS.length; i++) {
    const cpfAtual = LISTA_CPFS[i];

    await consultarCpf(token, cpfAtual);

    if (i < LISTA_CPFS.length - 1) {
      await sleep(3500); // Intervalo de 5 segundos
    }
  }

  console.log("\n🏁 Finalizado.");
})();