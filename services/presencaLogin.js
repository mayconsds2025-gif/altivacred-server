// services/presencaLogin.js

import axios from "axios";
import https from "https";

// Ignora verificação de hostname do certificado da Azure (necessário)
const httpsAgent = new https.Agent({
  checkServerIdentity: () => undefined,
});

// URL de PRODUÇÃO
const BASE_URL = "https://presenca-bank-api.azurewebsites.net";

/**
 * Faz login no Presença Bank e retorna o token.
 */
export async function iniciarSessaoPresenca(login, senha) {
  console.log("--------------------------------------------------------");
  console.log("[PRESENÇA][LOGIN] Iniciando autenticação em PRODUÇÃO...");
  console.log("[PRESENÇA][LOGIN] Endpoint:", `${BASE_URL}/login`);
  console.log("[PRESENÇA][LOGIN] Login enviado:", login);
  console.log("--------------------------------------------------------");

  try {
    const response = await axios.post(
      `${BASE_URL}/login`,
      { login, senha },
      {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        httpsAgent,
        timeout: 15000,
      }
    );

    console.log("[PRESENÇA][LOGIN] ✔ SUCESSO — Token recebido");
    console.log("[PRESENÇA][LOGIN] Resposta completa:", response.data);
    console.log("--------------------------------------------------------");

    return {
      sucesso: true,
      token: response.data?.token || null,
      data: response.data,
    };
  } catch (error) {
    console.log("[PRESENÇA][LOGIN] ❌ ERRO NA AUTENTICAÇÃO");
    console.log("--------------------------------------------------------");

    if (error.response) {
      console.log("[PRESENÇA][LOGIN] Resposta do servidor:");
      console.log(error.response.data);
    } else {
      console.log("[PRESENÇA][LOGIN] Erro local:", error.message);
    }

    console.log("--------------------------------------------------------");

    return {
      sucesso: false,
      erro: error.response?.data || error.message,
    };
  }
}
