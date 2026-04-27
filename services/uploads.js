import express from "express";
import multer from "multer";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import s3 from "./s3.js";

const router = express.Router();

/* ======================================================
   CONFIGURAÇÃO MULTER (UPLOAD EM MEMÓRIA)
====================================================== */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB (melhor para PDF)
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "application/pdf"
    ];

    if (!allowed.includes(file.mimetype)) {
      console.log("🟡 [UPLOAD][MULTER] Tipo inválido:", file.mimetype);
      return cb(
        new Error("Formato inválido. Apenas JPG, PNG ou PDF.")
      );
    }

    cb(null, true);
  }
}); // 🔥 AQUI ESTAVA FALTANDO O FECHAMENTO

/* ======================================================
   ROTA DE UPLOAD
====================================================== */
router.post("/:cpf", upload.array("documentos", 2), async (req, res) => {
  const requestId = `UPLOAD-${Date.now()}`;
  const startTime = Date.now();

  console.log("\n=====================================================");
  console.log(`📥 [${requestId}] NOVA REQUISIÇÃO DE UPLOAD`);
  console.log("📍 URL:", req.originalUrl);
  console.log("=====================================================\n");

  try {
    const { cpf } = req.params;

    if (!cpf) {
      return res.status(400).json({
        sucesso: false,
        erro: "CPF obrigatório na URL"
      });
    }

    const cpfLimpo = cpf.replace(/\D/g, "");

    if (!cpfLimpo || cpfLimpo.length !== 11) {
      return res.status(400).json({
        sucesso: false,
        erro: "CPF inválido"
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        sucesso: false,
        erro: "Envie pelo menos 1 documento"
      });
    }

    if (!process.env.AWS_BUCKET_NAME) {
      return res.status(500).json({
        sucesso: false,
        erro: "AWS_BUCKET_NAME não configurado"
      });
    }

    const uploads = [];

    for (const file of req.files) {
      const safeName = file.originalname.replace(/\s+/g, "_");
      const key = `documentos/${cpfLimpo}/${Date.now()}-${safeName}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype
        })
      );

      uploads.push(key);
    }

    const duration = Date.now() - startTime;

    return res.json({
      sucesso: true,
      arquivos: uploads,
      tempoMs: duration
    });

  } catch (err) {
    console.error("🟥 ERRO NO UPLOAD:", err);

    return res.status(500).json({
      sucesso: false,
      erro: err.message || "Erro interno no upload"
    });
  }
});

export default router;
