import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

// Sessão global
let browserGlobal = null;
let pageGlobal = null;

export function getC6Page() {
  return pageGlobal;
}

export async function iniciarSessaoC6(usuario, senha) {
  console.log("🟦 [C6] Iniciando sessão…");
  console.log("🟦 [C6] Usuário recebido:", usuario);

  const executablePath = await chromium.executablePath();

  const proxyHost = process.env.PROXY_HOST;
  const proxyPort = process.env.PROXY_PORT;
  const proxyUser = process.env.PROXY_USER;
  const proxyPass = process.env.PROXY_PASS;

  console.log("🔧 Proxy usado:", `${proxyHost}:${proxyPort}`);

  // 🚀 Inicia navegador com anti-bot aprimorado
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      `--proxy-server=http://${proxyHost}:${proxyPort}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-blink-features=AutomationControlled",
      ...chromium.args,
    ],
    defaultViewport: chromium.defaultViewport,
  });

  const page = await browser.newPage();

  // Anti-bot: remover webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });
  });

  // Salvar instâncias globais
  browserGlobal = browser;
  pageGlobal = page;

  // Autenticação do proxy
  await page.authenticate({
    username: proxyUser,
    password: proxyPass,
  });

  console.log("🌐 Acessando C6…");

  const response = await page.goto("https://c6.c6consig.com.br/", {
    waitUntil: "networkidle0",
    timeout: 120000,
  });

  console.log("🔍 Status HTTP:", response.status());

  if (response.status() === 403) {
    throw new Error("❌ Proxy recusado (403). IP bloqueado.");
  }

  // Logs de console da página
  page.on("console", (msg) => {
    console.log("🟨 [C6 Console]:", msg.text());
  });

  page.on("pageerror", (err) => {
    console.log("❌ [C6 Page Error]:", err);
  });

  // Garantir que DOM carregou totalmente
  await page.waitForFunction(() => document.readyState === "complete");
  await page.waitForTimeout(5000);

  console.log("🟦 [C6] Preenchendo login…");

  // Preencher login
  await page.type("#EUsuario_CAMPO", usuario, { delay: 25 });
  await page.type("#ESenha_CAMPO", senha, { delay: 25 });

  console.log("🟦 [C6] Clicando no botão Entrar…");

  await page.click("#lnkEntrar");

  console.log("🟦 [C6] Aguardando dashboard… (até 90s)");

  // Tenta localizar o #lnkSair de várias maneiras
  try {
    // Tentativa 1 — normal
    await page.waitForSelector("#lnkSair", {
      timeout: 60000,
      visible: true,
    });

    console.log("✅ Login realizado com sucesso! [Método 1]");
    return { sucesso: true };

  } catch (_) {
    console.log("⚠ Tentativa 1 falhou. Tentando detectar refresh automático…");
  }

  // Tentativa 2 — espera JavaScript dinâmico iniciar
  try {
    await page.waitForFunction(
      () => document.querySelector("#lnkSair") !== null,
      { timeout: 90000 }
    );

    console.log("✅ Login realizado com sucesso! [Método 2]");
    return { sucesso: true };

  } catch (_) {
    console.log("⚠ Tentativa 2 falhou. Tentando aguardar HTML interno…");
  }

  // Tentativa 3 — força novo carregamento se o sistema demora
  try {
    await page.reload({ waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector("#lnkSair", {
      timeout: 45000,
      visible: true,
    });

    console.log("✅ Login realizado com sucesso! [Método 3]");
    return { sucesso: true };

  } catch (err) {
    console.log("❌ Falha ao localizar #lnkSair depois do login.", err);
    return {
      sucesso: false,
      erro: "Falha no login (timeout, JS não carregou ou layout mudou).",
    };
  }
}
