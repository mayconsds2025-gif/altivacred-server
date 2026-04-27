import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const SAQUE_LOGIN_URL = "https://homolog.novosaque.com.br/api/v1/login";

/**
 * Autentica na API do Novo Saque
 * Retorna token para uso nas demais chamadas
 */
export async function authenticateSaque() {
  try {
    console.log("\n🔵 [SAQUE][AUTH] Iniciando autenticação...");

    if (!process.env.LOGIN_SAQUE || !process.env.SENHA_SAQUE) {
      throw new Error("Credenciais LOGIN_SAQUE ou SENHA_SAQUE ausentes no .env");
    }

    const payload = {
      email: process.env.LOGIN_SAQUE,
      password: process.env.SENHA_SAQUE
    };

    console.log("📤 [SAQUE][AUTH] Payload enviado (login oculto)");

    const response = await axios.post(
      SAQUE_LOGIN_URL,
      payload,
      {
        headers: {
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    console.log("🟩 [SAQUE][AUTH] Autenticação realizada com sucesso");

    /**
     * Ajuste aqui caso o token venha em outro campo
     * Exemplos comuns:
     * - response.data.token
     * - response.data.access_token
     * - response.data.data.token
     */
    const token =
      response.data?.token ||
      response.data?.access_token ||
      response.data?.data?.token ||
      null;

    if (!token) {
      console.log("🟥 [SAQUE][AUTH] Token não encontrado na resposta:", response.data);
      throw new Error("Token não retornado pela API do Saque");
    }

    return {
      sucesso: true,
      token
    };

  } catch (error) {
    console.log("🟥 [SAQUE][AUTH][ERRO]");
    console.log(error?.response?.data || error.message);

    return {
      sucesso: false,
      erro: error?.response?.data || error.message
    };
  }
}
