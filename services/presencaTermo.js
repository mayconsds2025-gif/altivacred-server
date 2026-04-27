import axios from "axios";
import https from "https";

const httpsAgent = new https.Agent({
  checkServerIdentity: () => undefined,
});

// -------------------- CRIAR TERMO --------------------
export async function criarTermo(token, payload) {
  try {
    const resp = await axios.post(
      "https://presenca-bank-api.azurewebsites.net/v2/consultas/termo-autorizacao",
      {
        cpf: payload.cpf,
        nome: payload.nome,
        telefone: payload.telefone,
        cpfRepresentante: "",
        nomeRepresentante: "",
        produtoId: 28,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        httpsAgent,
      }
    );

    return {
      sucesso: true,
      shortUrl: resp.data?.shortUrl,
      id: resp.data?.autorizacaoId,
    };
  } catch (err) {
    return { sucesso: false, erro: err.response?.data || err.message };
  }
}

// -------------------- CONSULTA VÍNCULO --------------------
export async function consultarVinculo(token, cpf) {
  try {
    const resp = await axios.post(
      "https://presenca-bank-api.azurewebsites.net/v3/operacoes/consignado-privado/consultar-vinculos",
      { cpf },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        httpsAgent,
      }
    );

    return { sucesso: true, dados: resp.data };
  } catch (err) {
    return { sucesso: false, erro: err.response?.data || err.message };
  }
}

// -------------------- CONSULTA MARGEM --------------------
export async function consultarMargem(token, { cpf, matricula, cnpj }) {
  try {
    const resp = await axios.post(
      "https://presenca-bank-api.azurewebsites.net/v3/operacoes/consignado-privado/consultar-margem",
      { cpf, matricula, cnpj },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        httpsAgent,
      }
    );

    return {
      sucesso: true,
      dados: Array.isArray(resp.data) ? resp.data : [resp.data],
    };
  } catch (err) {
    return { sucesso: false, erro: err.response?.data || err.message };
  }
}

// -------------------- SIMULAR TABELAS (INSS) --------------------
export async function simularTabelas(token, payloadFinal) {
  try {
    console.log("--------------------------------------------------------");
    console.log("[PRESENÇA][SIMULAR] Payload enviado para INSS =>");
    console.log(JSON.stringify(payloadFinal, null, 2));
    console.log("--------------------------------------------------------");

    const resp = await axios.post(
      "https://presenca-bank-api.azurewebsites.net/v3/tabelas/simulacao/inss/disponiveis",
      payloadFinal,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        httpsAgent,
      }
    );

    console.log("[PRESENÇA][SIMULAR] Resposta recebida =>");
    console.log(JSON.stringify(resp.data, null, 2));
    console.log("--------------------------------------------------------");

    return { sucesso: true, simulacoes: resp.data };
  } catch (err) {
    console.log("[PRESENÇA][SIMULAR][ERRO DETALHADO]", err.response?.data || err.message);
    return { sucesso: false, erro: err.response?.data || err.message };
  }
}

// -------------------- CRIAR OPERAÇÃO CLT (INSS) --------------------
export async function criarOperacaoCLT(token, payloadFinal) {
  try {
    console.log("--------------------------------------------------------");
    console.log("[PRESENÇA][CRIAR OPERACAO] Payload enviado =>");
    console.log(JSON.stringify(payloadFinal, null, 2));
    console.log("--------------------------------------------------------");

    const resp = await axios.post(
      "https://presenca-bank-api.azurewebsites.net/v3/operacoes/",
      payloadFinal,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        httpsAgent,
      }
    );

    console.log("[PRESENÇA][CRIAR OPERACAO] Resposta Presença =>");
    console.log(JSON.stringify(resp.data, null, 2));
    console.log("--------------------------------------------------------");

    return {
      sucesso: true,
      dados: resp.data,
    };

  } catch (err) {
    console.log("[PRESENÇA][CRIAR OPERACAO][ERRO DETALHADO]", err.response?.data || err.message);

    return {
      sucesso: false,
      erro: err.response?.data || err.message,
    };
  }
}
