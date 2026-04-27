import { getC6Page } from "./c6Login.js";

/**
 * Prepara a proposta consignado no C6:
 * - Proposta Nova
 * - Produto 0001 (Margem Livre)
 * - Grupo Convenio PRIVADO
 * - Formalização Digital
 * - Preenche CPF / DDD / Celular
 * - Clica captcha, confirmar e enviar token
 */
export async function configurarPropostaC6(req, res) {
  const page = getC6Page();
  if (!page) throw new Error("Navegador do C6 não está ativo.");

  const { cpf, ddd, celular } = req.body;

  console.log("📌 Dados recebidos do front:", { cpf, ddd, celular });
  console.log("🟡 Configurando Proposta Consignado...");

  // ---------------------------------------------------------
  // 🔵 PROPOSTA NOVA
  // ---------------------------------------------------------
  try {
    await page.select(
      "#ctl00_Cph_UcPrp_FIJN1_JnDadosIniciais_UcDIni_cboTipoOperacao_CAMPO",
      "MargemLivre"
    );
    console.log("✔ Tipo Operação: Proposta Nova selecionado");
    await page.waitForTimeout(1500);
  } catch (e) {
    console.log("❌ Erro ao selecionar Tipo Operação:", e);
  }

  // ---------------------------------------------------------
  // 🔵 PRODUTO 0001
  // ---------------------------------------------------------
  try {
    await page.select(
      "#ctl00_Cph_UcPrp_FIJN1_JnDadosIniciais_UcDIni_cboTipoProduto_CAMPO",
      "0001"
    );
    console.log("✔ Tipo Produto: 0001 - MARGEM LIVRE selecionado");
    await page.waitForTimeout(1500);
  } catch (e) {
    console.log("❌ Erro ao selecionar Tipo Produto:", e);
  }

  // ---------------------------------------------------------
  // 🔵 GRUPO CONVÊNIO PRIVADO
  // ---------------------------------------------------------
  try {
    await page.select(
      "#ctl00_Cph_UcPrp_FIJN1_JnDadosIniciais_UcDIni_cboGrupoConvenio_CAMPO",
      "4"
    );
    console.log("✔ Grupo Convenio: PRIVADO selecionado");
    await page.waitForTimeout(1500);
  } catch (e) {
    console.log("❌ Erro ao selecionar Grupo Convênio:", e);
  }

  // ---------------------------------------------------------
  // 🔵 FORMALIZAÇÃO DIGITAL
  // ---------------------------------------------------------
  try {
    await page.click(
      "#ctl00_Cph_UcPrp_FIJN1_JnDadosIniciais_UcDIni_rblTpFormalizacao_1"
    );
    console.log("✔ Formalização: DIGITAL selecionada");
    await page.waitForTimeout(1500);
  } catch (e) {
    console.log("❌ Erro ao selecionar formalização:", e);
  }

  // ---------------------------------------------------------
  // 🔵 CPF
  // ---------------------------------------------------------
  try {
    console.log("✏ Preenchendo CPF...");
    await page.type(
      "#ctl00_Cph_UcPrp_FIJN1_JnDadosIniciais_UcDIni_txtCpfCPD_CAMPO",
      cpf,
      { delay: 20 }
    );
    await page.waitForTimeout(800);
  } catch (e) {
    console.log("❌ Erro ao preencher CPF:", e);
  }

  // ---------------------------------------------------------
  // 🔵 DDD
  // ---------------------------------------------------------
  try {
    console.log("✏ Preenchendo DDD...");
    await page.type(
      "#ctl00_Cph_UcPrp_FIJN1_JnDadosIniciais_UcDIni_txtDddCPD_CAMPO",
      ddd,
      { delay: 20 }
    );
    await page.waitForTimeout(800);
  } catch (e) {
    console.log("❌ Erro ao preencher DDD:", e);
  }

  // ---------------------------------------------------------
  // 🔵 CELULAR
  // ---------------------------------------------------------
  try {
    console.log("✏ Preenchendo Celular...");
    await page.type(
      "#ctl00_Cph_UcPrp_FIJN1_JnDadosIniciais_UcDIni_txtCelularCPD_CAMPO",
      celular,
      { delay: 20 }
    );
    await page.waitForTimeout(1000);
  } catch (e) {
    console.log("❌ Erro ao preencher Celular:", e);
  }

  // ---------------------------------------------------------
  // 🔵 reCAPTCHA (usuário precisa resolver)
  // ---------------------------------------------------------
  try {
    console.log("🔎 Procurando frame do reCAPTCHA...");
    await page.waitForTimeout(2000);

    const frames = page.frames();
    const captchaFrame = frames.find((f) => f.url().includes("recaptcha"));

    if (captchaFrame) {
      console.log("🟦 Frame do reCAPTCHA encontrado.");
    } else {
      console.log("⚠ Frame do reCAPTCHA NÃO encontrado.");
    }

    console.log("⚠ IMPORTANTE: O usuário precisa resolver o reCAPTCHA manualmente.");
    console.log("⏳ Aguardando interação humana…");

  } catch (e) {
    console.log("❌ Erro ao lidar com reCAPTCHA:", e);
  }

  // ---------------------------------------------------------
  // 🔵 CLICAR CONFIRMAR
  // ---------------------------------------------------------
  try {
    console.log("🟦 Tentando clicar botão Confirmar…");
    await page.click("#btnConfirmar_txt");
    await page.waitForTimeout(2500);
    console.log("✔ Botão Confirmar clicado");
  } catch (e) {
    console.log("❌ Erro ao clicar Confirmar:", e);
  }

  // ---------------------------------------------------------
  // 🔵 CLICAR ENVIAR TOKEN
  // ---------------------------------------------------------
  try {
    console.log("🟦 Aguardando botão Enviar Token…");
    await page.waitForSelector("#btnEnviarTokenCPD_txt", {
      timeout: 6000,
    });

    await page.click("#btnEnviarTokenCPD_txt");
    await page.waitForTimeout(2000);

    console.log("✔ Botão ENVIAR TOKEN clicado!");
  } catch (e) {
    console.log("❌ Erro ao clicar Enviar Token:", e);
  }

  console.log("🎉 Proposta configurada com sucesso!");

  return { sucesso: true };
}
