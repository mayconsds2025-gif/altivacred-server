import axios from "axios";
import dotenv from "dotenv";
import https from "https";

dotenv.config();

const LOGIN = process.env.PRESENCA_LOGIN;
const PASSWORD = process.env.PRESENCA_PASSWORD;

const BASE_URL = "https://presenca-bank-api.azurewebsites.net";

// mesmo agent do backend
const httpsAgent = new https.Agent({
  checkServerIdentity: () => undefined,
  rejectUnauthorized: false,
});

// payload de teste (idêntico ao do backend)
const payloadOperacao = {
  type: "credito-privado-v3",
  proposta: {
    valorSolicitado: 8496.64,
    quantidadeParcelas: 6,
    produtoId: 28,
    valorParcela: 2314.3,
    tabelaId: 5162,
  },
  tomador: {
    cpf: "46036533870",
    nome: "Nathalya Ferreira Lima",
    dataNascimento: "1998-10-07",
    nomeMae: "DAIANE MARTINS FERREIRA",
    email: "maycon.sds@outlook.com",
    sexo: "Feminino",
    endereco: {
      cep: "05350000",
      rua: "Avenida Escola Politecnica",
      numero: "2200",
      complemento: "",
      cidade: "Sao Paulo",
      estado: "SP",
      bairro: "Rio Pequeno",
    },
    telefone: {
      ddd: "16",
      numero: "988216167",
    },
    vinculoEmpregaticio: {
      cnpjEmpregador: "68311216000101",
      registroEmpregaticio: "00041201",
    },
    dadosBancarios: {
      codigoBanco: "260",
      agencia: "0001",
      conta: "17634495",
      digitoConta: "7",
      formaCredito: "CC",
    },
    tenantId: "bb697451-7fae-41bf-a4b7-53db7c1f8197",
  },
  representante: {
    cpf: "46036533870",
    nome: "Nathalya Ferreira Lima",
    nomeMae: "DAIANE MARTINS FERREIRA",
    dataNascimento: "1998-10-07",
  },
  documentos: [],
};

async function login() {
  try {
    console.log("\n➡ Fazendo login...");

    const resp = await axios.post(
      `${BASE_URL}/login`,
      {
        login: LOGIN,
        senha: PASSWORD, // 🔥 AQUI A CORREÇÃO
      },
      {
        httpsAgent,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      }
    );

    console.log("✔ Login OK");
    return resp.data.token;
  } catch (err) {
    console.log("❌ ERRO LOGIN:", err.response?.data || err.message);
    process.exit(1);
  }
}

async function criarOperacao(token) {
  try {
    console.log("\n➡ Enviando operação...");

    const resp = await axios.post(
      `${BASE_URL}/v3/operacoes/`,
      payloadOperacao,
      {
        httpsAgent,
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      }
    );

    console.log("✔ Resposta:", resp.data);
  } catch (err) {
    console.log("❌ ERRO OPERACAO:", err.response?.data || err.message);
  }
}

(async () => {
  const token = await login();
  await criarOperacao(token);
})();
