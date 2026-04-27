import fs from "fs";
import csv from "csv-parser";
import axios from "axios";
import https from "https";
import dotenv from "dotenv";
import puppeteer from "puppeteer";

dotenv.config();

/* =====================================================
   CONFIG
===================================================== */
const INPUT_CSV = "./cpfs.csv";
const BASE_URL = "https://presenca-bank-api.azurewebsites.net";

const DELAY_API_MS = 5500;       // delay ENTRE chamadas HTTP
const DELAY_CPF_MS = 6000;       // delay ENTRE CPFs
const MAX_RETRIES = 3;

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
  timeout: 20000,
  httpsAgent,
});

/* =====================================================
   UTILS
===================================================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizarCpf(cpf) {
  return String(cpf).replace(/\D/g, "").padStart(11, "0");
}

function mascararCpf(cpf) {
  return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

function gerarTelefoneUnico(cpf) {
  // Gera telefone único baseado no CPF (determinístico)
  const base = cpf.slice(-8);
  return `11${base}`;
}

/* =====================================================
   LOGIN
===================================================== */
async function loginPresenca() {
  await sleep(DELAY_API_MS);

  try {
    const resp = await api.post("/login", {
      login: process.env.PRESENCA_LOGIN,
      senha: process.env.PRESENCA_PASSWORD,
    });

    return resp.data.token;
  } catch (err) {
    console.error("[LOGIN][ERRO]", err.response?.data || err.message);
    return null;
  }
}

/* =====================================================
   GERAR TERMO (COM BACKOFF)
===================================================== */
async function gerarTermo(token, cpf) {
  const telefone = gerarTelefoneUnico(cpf);

  for (let tentativa = 1; tentativa <= MAX_RETRIES; tentativa++) {
    await sleep(DELAY_API_MS);

    try {
      const resp = await api.post(
        "/v2/consultas/termo-autorizacao",
        {
          cpf,
          nome: "AUTORIZACAO AUTOMATICA",
          telefone,
          cpfRepresentante: "",
          nomeRepresentante: "",
          produtoId: 28,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      return resp.data?.shortUrl || null;
    } catch (err) {
      const data = err.response?.data;
      console.error(
        `[TERMO][ERRO][${mascararCpf(cpf)}][Tentativa ${tentativa}]`,
        data || err.message
      );

      // Se for telefone duplicado, não adianta retry
      if (data?.errors?.some(e => e.includes("Telefone"))) {
        return null;
      }

      // Rate limit → backoff progressivo
      if (data?.error?.includes("Rate limit")) {
        const backoff = tentativa * 10000;
        console.log(`⏳ Rate limit. Aguardando ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }

      return null;
    }
  }

  return null;
}

/* =====================================================
   CSV
===================================================== */
function lerCpfs() {
  return new Promise((resolve, reject) => {
    const cpfs = [];

    fs.createReadStream(INPUT_CSV)
      .pipe(csv({ separator: ";" }))
      .on("data", (row) => {
        const key = Object.keys(row)[0];
        if (row[key]) cpfs.push(normalizarCpf(row[key]));
      })
      .on("end", () => resolve(cpfs))
      .on("error", reject);
  });
}

/* =====================================================
   AUTORIZAÇÃO (PUPPETEER)
===================================================== */
async function autorizarConsulta(browser, shortUrl) {
  const page = await browser.newPage();

  try {
    await page.goto(shortUrl, { waitUntil: "networkidle2", timeout: 30000 });

    await page.waitForSelector(
      'input[type="checkbox"].mdc-checkbox__native-control',
      { timeout: 15000 }
    );

    await page.click(
      'input[type="checkbox"].mdc-checkbox__native-control'
    );

    await sleep(500);

    await page.waitForSelector("button.mat-mdc-unelevated-button", {
      timeout: 15000,
    });

    await page.click("button.mat-mdc-unelevated-button");

    await sleep(2000);
  } finally {
    await page.close();
  }
}

/* =====================================================
   MAIN
===================================================== */
async function executarAutorizacoes() {
  const token = await loginPresenca();
  if (!token) return;

  const cpfs = await lerCpfs();

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized"],
  });

  for (const cpf of cpfs) {
    console.log(`🔄 Processando CPF ${mascararCpf(cpf)}...`);

    const shortUrl = await gerarTermo(token, cpf);

    if (!shortUrl) {
      console.log(`❌ CPF ${mascararCpf(cpf)} | Falha ao gerar termo`);
      await sleep(DELAY_CPF_MS);
      continue;
    }

    try {
      await autorizarConsulta(browser, shortUrl);
      console.log(`✅ CPF ${mascararCpf(cpf)} | OK`);
    } catch {
      console.log(`❌ CPF ${mascararCpf(cpf)} | ERRO NA AUTORIZAÇÃO`);
    }

    await sleep(DELAY_CPF_MS);
  }

  await browser.close();
}

/* =====================================================
   RUN
===================================================== */
executarAutorizacoes();
