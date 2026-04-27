import axios from "axios";

async function testAuth() {
  try {
    console.log("🔐 Testando autenticação na V8...");

    const body = new URLSearchParams({
      grant_type: "password",
      username: "maycon.sds@outlook.com",
      password: "H!p0tenusa",
      audience: "https://bff.v8sistema.com",
      scope: "offline_access",
      client_id: "DHWogdaYmEI8n5bwwxPDzulMlSK7dwIn",
    });

    const response = await axios.post(
      "https://auth.v8sistema.com/oauth/token",
      body,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("\n✅ TOKEN GERADO COM SUCESSO!");
    console.log("Token:", response.data.access_token);
    console.log("\n🕒 expira em:", response.data.expires_in, "segundos");

  } catch (error) {
    console.error("❌ Erro ao autenticar!");

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    } else {
      console.error("Mensagem:", error.message);
    }
  }
}

testAuth();
