const fs = require("fs");
const csv = require("csv-parser");
const axios = require("axios");
const dayjs = require("dayjs");
const { createObjectCsvWriter } = require("csv-writer");

/* ===============================
   CONFIGURAÇÕES
================================ */
const INPUT_CSV = "./cpfs.csv";
const OUTPUT_CSV = "./resultado_cpfs.csv";

const BASE_URL = "https://presenca-bank-api.azurewebsites.net";

const LOGIN_PAYLOAD = {
  login: "44935512830_GUhP",
  senha: "H!p0tenusa"
};

/* ===============================
   NORMALIZA CPF
   - Remove tudo que não for número
   - Garante 11 dígitos (padStart)
================================ */
function normalizarCpf(cpf) {
  const somenteNumeros = String(cpf).replace(/\D/g, "");
  return somenteNumeros.padStart(11, "0");
}

/* ===============================
   AUTENTICAÇÃO
================================ */
async function autenticar() {
  const response = await axios.post(`${BASE_URL}/login`, LOGIN_PAYLOAD);
  return response.data.token;
}

/* ===============================
   CONSULTA VÍNCULOS
================================ */
async function consultarVinculos(cpf, token) {
  const response = await axios.post(
    `${BASE_URL}/v3/operacoes/consignado-privado/consultar-vinculos`,
    { cpf },
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
  return response.data?.id || [];
}

/* ===============================
   CONSULTA MARGEM
================================ */
async function consultarMargem({ cpf, matricula, cnpj }, token) {
  const response = await axios.post(
    `${BASE_URL}/v3/operacoes/consignado-privado/consultar-margem`,
    {
      cpf,
      matricula,
      cnpj
    },
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
  return response.data;
}

/* ===============================
   LEITURA DO CSV (ROBUSTA)
================================ */
function lerCpfs() {
  return new Promise((resolve, reject) => {
    const cpfs = [];

    fs.createReadStream(INPUT_CSV)
      .pipe(csv())
      .on("data", (row) => {
        if (row.CPF !== undefined && row.CPF !== null) {
          const cpfNormalizado = normalizarCpf(row.CPF);
          cpfs.push(cpfNormalizado);
        }
      })
      .on("end", () => resolve(cpfs))
      .on("error", reject);
  });
}

/* ===============================
   PROCESSAMENTO PRINCIPAL
================================ */
async function processarCpfs() {
  const token = await autenticar();
  const cpfs = await lerCpfs();

  const resultados = [];

  for (const cpf of cpfs) {
    console.log(`\n🔍 CPF processado: ${cpf}`);

    try {
      const vinculos = await consultarVinculos(cpf, token);

      if (!vinculos.length) {
        console.log("⚠️ Nenhum vínculo encontrado");
        resultados.push({
          CPF: cpf,
          tempo_empresa_dias: "",
          valor_margem_disponivel: ""
        });
        continue;
      }

      for (const vinculo of vinculos) {
        if (!vinculo.elegivel) {
          console.log("⛔ Vínculo não elegível");
          continue;
        }

        const margem = await consultarMargem(
          {
            cpf,
            matricula: vinculo.matricula,
            cnpj: vinculo.numeroInscricaoEmpregador
          },
          token
        );

        const dataAdmissao = dayjs(margem.dataAdmissao);
        const tempoEmpresaDias = dayjs().diff(dataAdmissao, "day");

        console.log(`✅ Matrícula: ${vinculo.matricula}`);
        console.log(`📅 Tempo empresa (dias): ${tempoEmpresaDias}`);
        console.log(`💰 Margem disponível: ${margem.valorMargemDisponivel}`);

        resultados.push({
          CPF: cpf,
          tempo_empresa_dias: tempoEmpresaDias,
          valor_margem_disponivel: margem.valorMargemDisponivel
        });
      }
    } catch (error) {
      console.error(`❌ Erro no CPF ${cpf}:`, error.message);
      resultados.push({
        CPF: cpf,
        tempo_empresa_dias: "",
        valor_margem_disponivel: ""
      });
    }
  }

  await salvarCsv(resultados);
}

/* ===============================
   SALVAR CSV FINAL
================================ */
async function salvarCsv(dados) {
  const csvWriter = createObjectCsvWriter({
    path: OUTPUT_CSV,
    header: [
      { id: "CPF", title: "CPF" },
      { id: "tempo_empresa_dias", title: "Tempo Empresa (dias)" },
      { id: "valor_margem_disponivel", title: "Valor Margem Disponível" }
    ]
  });

  await csvWriter.writeRecords(dados);
  console.log(`\n📁 CSV gerado com sucesso: ${OUTPUT_CSV}`);
}

/* ===============================
   EXECUÇÃO
================================ */
processarCpfs()
  .then(() => console.log("\n🚀 Finalizado com sucesso"))
  .catch((err) => console.error("Erro fatal:", err));
