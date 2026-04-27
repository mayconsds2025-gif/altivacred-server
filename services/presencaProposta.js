// services/presencaProposta.js

import axios from "axios";
import https from "https";

const httpsAgent = new https.Agent({
  checkServerIdentity: () => undefined,
  rejectUnauthorized: false
});

// endpoint EXATO sem barra no final
const BASE_URL = "https://presenca-bank-api.azurewebsites.net/v3/operacoes";

// -------------------------------------------------------------
// Função com retry exponencial
// -------------------------------------------------------------
async function enviarComRetry(token, payload, maxRetries = 3) {
  const timeoutMs = 60000; // 60s
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[PRESENCA][CLT] Enviando operação (tentativa ${attempt})...`);

      const response = await axios.post(
        BASE_URL,
        payload,
        {
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            Authorization: `Bearer ${token}`
          },
          httpsAgent,
          timeout: timeoutMs
        }
      );

      console.log("[PRESENCA][CLT] SUCESSO:", response.data);

      // ---------------------------------------------------
      // 🔥 RESPOSTA EXPECTADA PELO FRONT
      // ---------------------------------------------------
      return {
        sucesso: true,
        id: response.data?.id ?? null
      };

    } catch (error) {
      const status = error.response?.status || null;

      console.log(`[PRESENCA][CLT] ERRO (tentativa ${attempt}):`, {
        mensagem: error.message,
        code: error.code,
        status,
        body: error.response?.data
      });

      // Erros 4xx não adianta tentar novamente
      if (status && status >= 400 && status < 500) break;

      if (attempt === maxRetries) {
        return {
          sucesso: false,
          erro: error.response?.data || error.message
        };
      }

      // espera exponencial antes do retry
      const wait = 500 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  return {
    sucesso: false,
    erro: "Erro desconhecido ao enviar operação"
  };
}


// -------------------------------------------------------------
// Export oficial
// -------------------------------------------------------------
export async function criarOperacaoCLT(token, payload) {
  console.log("[PRESENCA][CLT] Payload:", JSON.stringify(payload, null, 2));
  return await enviarComRetry(token, payload);
}
