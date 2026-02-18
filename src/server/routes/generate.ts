import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { hasCookies } from "../lib/cookies.js";
import { tryRestoreSession } from "../lib/auth.js";
import {
  generateImages,
  downloadImageToBuffer,
  requestFullSizeUrl,
  getSessionTokens,
} from "../lib/gemini.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
const TMP_DIR = path.join(process.cwd(), "tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

// Middleware to ensure cookies are available
async function ensureAuth(_req: any, res: any, next: any) {
  if (!hasCookies()) {
    const restored = await tryRestoreSession();
    if (!restored) {
      return res
        .status(401)
        .json({ error: "Not authenticated. Call GET /api/login first." });
    }
  }
  next();
}

// POST /api/generate — generate images (always returns 1K previews)
router.post("/generate", upload.array("images", 10), ensureAuth, async (req, res) => {
  const rawPrompt = req.body?.prompt;
  if (!rawPrompt) {
    return res.status(400).json({ error: "Missing 'prompt' field" });
  }

  const aspectRatio = req.body?.aspectRatio;
  const prompt = aspectRatio
    ? `${rawPrompt}. Use a ${aspectRatio} aspect ratio.`
    : rawPrompt;

  try {
    const imageBuffers = ((req.files as Express.Multer.File[]) || []).map(
      (f) => ({
        buffer: f.buffer,
        fileName: f.originalname,
        mimeType: f.mimetype,
      })
    );

    const result = await generateImages(prompt, imageBuffers);

    // Download only PNG images as 1K previews, save to tmp/
    const pngImages = result.images.filter((img) => img.mime === "image/png");
    const images = [];
    for (const img of pngImages) {
      try {
        const buf = await downloadImageToBuffer(img.url);
        const id = crypto.randomUUID();
        const ext = img.mime === "image/png" ? ".png" : ".jpg";
        const savedName = `${id}${ext}`;
        fs.writeFileSync(path.join(TMP_DIR, savedName), buf);
        images.push({
          filename: img.filename,
          mime: img.mime,
          dimensions: img.dimensions,
          url: `/tmp/${savedName}`,
          imageToken: img.imageToken,
          responseChunkId: img.responseChunkId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`Failed to download ${img.filename}: ${message}`);
      }
    }

    res.json({
      images,
      metadata: {
        conversationId: result.conversationId,
        responseId: result.responseId,
        modelName: result.modelName,
        prompt: rawPrompt,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Generation error:", err);
    res.status(500).json({ error: message });
  }
});

// POST /api/upscale — download full-size (2K) image via c8o8Fe RPC
router.post("/upscale", ensureAuth, async (req, res) => {
  const { imageToken, responseChunkId, conversationId, responseId, prompt } =
    req.body || {};

  if (!imageToken || !responseChunkId || !conversationId || !responseId) {
    return res.status(400).json({ error: "Missing upscale metadata" });
  }

  try {
    const tokens = await getSessionTokens();
    const fullSizeUrl = await requestFullSizeUrl(
      {
        url: "",
        filename: "upscale",
        mime: "image/png",
        dimensions: null,
        imageToken,
        responseChunkId,
      },
      prompt || "",
      conversationId,
      responseId,
      tokens
    );

    const buf = await downloadImageToBuffer(fullSizeUrl);
    const id = crypto.randomUUID();
    const savedName = `${id}.png`;
    fs.writeFileSync(path.join(TMP_DIR, savedName), buf);
    res.json({
      url: `/tmp/${savedName}`,
      mime: "image/png",
      bytes: buf.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Upscale error:", message);
    res.status(500).json({ error: message });
  }
});

export default router;
