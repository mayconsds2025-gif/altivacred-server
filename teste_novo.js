/**
 * Teste de autenticação + simulação
 * API Novo Saque
 * Compatível com ES Modules
 */

import axios from "axios";

// ===============================
// CONFIGURAÇÕES
// ===============================
const BASE_URL = "https://sistema.novosaque.com.br/api/v1";

const LOGIN_PAYLOAD = {
  email: "maycon.sds@nitzdigital.com",
  password: "Credito@2025",
};

const SIMULATION_PAYLOAD = {
  simulation: {
    value: 500,
    interest_rate: 20,
    installments: 4,
  },
};

// ===============================
// EXECUÇÃO
// ===============================
async function runTest() {
  try {
    console.log("🔐 Autenticando...");

    // 1️⃣ LOGIN
    const loginResponse = await axios.post(
      `${BASE_URL}/login`,
      LOGIN_PAYLOAD,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const { token, email, id } = loginResponse.data;

    if (!token) {
      throw new Error("Token não retornado pela API de login");
    }

    console.log("✅ Login efetuado com sucesso");
    console.log("Usuário:", email);
    console.log("User ID:", id);
    console.log("Token:", token);

    // 2️⃣ SIMULAÇÃO
    console.log("\n📊 Enviando simulação...");

    const simulationResponse = await axios.post(
      `${BASE_URL}/simulations/simulation_values/credit_limit`,
      SIMULATION_PAYLOAD,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    console.log("✅ Simulação realizada com sucesso");
    console.log("Resposta da simulação:");
    console.dir(simulationResponse.data, { depth: null });

  } catch (error) {
    console.error("❌ Erro no teste");

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    } else {
      console.error(error.message);
    }
  }
}

// ===============================
// START
// ===============================
runTest();
