import fs from "fs";
import csv from "csv-parser";
import axios from "axios";
import https from "https";
import dotenv from "dotenv";
import dayjs from "dayjs";
import { createObjectCsvWriter } from "csv-writer";

dotenv.config();

/* =====================================================
   CONFIGURAÇÕES
===================================================== */
const INPUT_CSV = "./cpfs.csv";
const OUTPUT_CSV = "./resultado_cpfs.csv";
const BASE_URL = "https://presenca-bank-api.azurewebsites.net";
const INTERVALO_MS = 2000;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  try {
    const resp = await api.post("/login", {
      login: process.env.PRESENCA_LOGIN,
      senha: process.env.PRESENCA_PASSWORD,
    });
    return { sucesso: true, token: resp.data.token };
  } catch {
    return { sucesso: false };
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
    return { sucesso: true, dados: resp.data?.id || [] };
  } catch {
    return { sucesso: false, dados: [] };
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
    return { sucesso: true, dados: resp.data };
  } catch {
    return { sucesso: false };
  }
}

/* =====================================================
   LER CSV
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
   PROCESSAMENTO
===================================================== */
async function executarConsulta() {
  const login = await loginPresenca();
  if (!login.sucesso) return;

  const token = login.token;
  const cpfs = await lerCpfs();
  const resultados = [];

  for (let i = 0; i < cpfs.length; i++) {
    const cpf = cpfs[i];

    const vinculo = await consultarVinculo(token, cpf);

    if (!vinculo.sucesso || !vinculo.dados.length) {
      resultados.push({
        CPF: cpf,
        tempo_empresa_dias: "",
        valor_margem_disponivel: "",
      });
      await sleep(INTERVALO_MS);
      continue;
    }

    const v = escolherVinculoElegivel(vinculo.dados);

    if (!v) {
      resultados.push({
        CPF: cpf,
        tempo_empresa_dias: "",
        valor_margem_disponivel: "",
      });
      await sleep(INTERVALO_MS);
      continue;
    }

    const margem = await consultarMargem(token, {
      cpf,
      matricula: v.matricula,
      cnpj: v.numeroInscricaoEmpregador,
    });

    if (!margem.sucesso) {
      resultados.push({
        CPF: cpf,
        tempo_empresa_dias: "",
        valor_margem_disponivel: "",
      });
      await sleep(INTERVALO_MS);
      continue;
    }

    const tempoEmpresaDias = dayjs().diff(
      dayjs(margem.dados.dataAdmissao),
      "day"
    );

    console.log(
      `✅ CPF ${mascararCpf(cpf)} | ${tempoEmpresaDias} dias | Margem ${margem.dados.valorMargemDisponivel}`
    );

    resultados.push({
      CPF: cpf,
      tempo_empresa_dias: tempoEmpresaDias,
      valor_margem_disponivel: margem.dados.valorMargemDisponivel,
    });

    await sleep(INTERVALO_MS);
  }

  await salvarCsv(resultados);
}

/* =====================================================
   SALVAR CSV
===================================================== */
async function salvarCsv(dados) {
  const writer = createObjectCsvWriter({
    path: OUTPUT_CSV,
    header: [
      { id: "CPF", title: "CPF" },
      { id: "tempo_empresa_dias", title: "Tempo Empresa (dias)" },
      { id: "valor_margem_disponivel", title: "Valor Margem Disponível" },
    ],
  });

  await writer.writeRecords(dados);
}

/* =====================================================
   EXECUÇÃO
===================================================== */
executarConsulta();
