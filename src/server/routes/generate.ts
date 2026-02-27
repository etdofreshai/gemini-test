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

// Limits for input validation
const MAX_PROMPT_LENGTH = 4000;
const MAX_FILES = 10;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
const ALLOWED_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

// File filter for multer
const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${ALLOWED_IMAGE_TYPES.join(", ")}`));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_FILES },
  fileFilter,
});

// Store generated images in .chrome-profile/.generated-images/
const IMAGES_DIR = path.join(process.cwd(), ".chrome-profile", ".generated-images");
fs.mkdirSync(IMAGES_DIR, { recursive: true });

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

// Validation helpers
function validatePrompt(prompt: unknown): { valid: boolean; error?: string } {
  if (prompt === undefined || prompt === null) {
    return { valid: false, error: "Missing 'prompt' field" };
  }
  if (typeof prompt !== "string") {
    return { valid: false, error: "'prompt' must be a string" };
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "'prompt' cannot be empty" };
  }
  if (trimmed.length > MAX_PROMPT_LENGTH) {
    return { valid: false, error: `'prompt' exceeds maximum length of ${MAX_PROMPT_LENGTH} characters` };
  }
  return { valid: true };
}

function validateAspectRatio(aspectRatio: unknown): { valid: boolean; value?: string } {
  if (!aspectRatio) return { valid: true, value: undefined };
  if (typeof aspectRatio !== "string") return { valid: false };
  if (!ALLOWED_ASPECT_RATIOS.includes(aspectRatio)) return { valid: false };
  return { valid: true, value: aspectRatio };
}

// GET /api/images — list all stored images
router.get("/images", (_req, res) => {
  try {
    const files = fs.readdirSync(IMAGES_DIR);
    const images = files
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(IMAGES_DIR, f));
        return {
          filename: f,
          url: `/images/${f}`,
          bytes: stat.size,
          createdAt: stat.birthtimeMs || stat.mtimeMs,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt); // newest first
    res.json({ images });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// DELETE /api/images/:filename — delete a single image
router.delete("/images/:filename", (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(IMAGES_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    fs.unlinkSync(filePath);
    res.json({ success: true, deleted: filename });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// DELETE /api/images — bulk delete images
router.delete("/images", (req, res) => {
  try {
    const { filenames } = req.body || {};
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return res.status(400).json({ error: "Missing filenames array" });
    }
    const deleted: string[] = [];
    const errors: string[] = [];
    for (const raw of filenames) {
      const filename = path.basename(String(raw)); // prevent path traversal
      const filePath = path.join(IMAGES_DIR, filename);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted.push(filename);
        } else {
          errors.push(`${filename}: not found`);
        }
      } catch (e: unknown) {
        errors.push(`${filename}: ${e instanceof Error ? e.message : "error"}`);
      }
    }
    res.json({ success: true, deleted, errors });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/generate — generate images (always returns 1K previews)
router.post("/generate", upload.array("images", MAX_FILES), ensureAuth, async (req, res) => {
  // Validate prompt
  const promptValidation = validatePrompt(req.body?.prompt);
  if (!promptValidation.valid) {
    return res.status(400).json({ error: promptValidation.error });
  }
  const rawPrompt = (req.body.prompt as string).trim();

  // Validate aspect ratio
  const aspectValidation = validateAspectRatio(req.body?.aspectRatio);
  if (!aspectValidation.valid) {
    return res.status(400).json({ 
      error: `Invalid aspect ratio. Allowed values: ${ALLOWED_ASPECT_RATIOS.join(", ")}` 
    });
  }
  const prompt = aspectValidation.value
    ? `${rawPrompt}. Use a ${aspectValidation.value} aspect ratio.`
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

    // Download only PNG images as 1K previews, save to IMAGES_DIR
    const pngImages = result.images.filter((img) => img.mime === "image/png");
    const images = [];
    for (const img of pngImages) {
      try {
        const buf = await downloadImageToBuffer(img.url);
        const id = crypto.randomUUID();
        const ext = img.mime === "image/png" ? ".png" : ".jpg";
        const savedName = `${id}${ext}`;
        fs.writeFileSync(path.join(IMAGES_DIR, savedName), buf);
        images.push({
          filename: img.filename,
          mime: img.mime,
          dimensions: img.dimensions,
          url: `/images/${savedName}`,
          savedName,
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

  // Validate required fields
  const missing: string[] = [];
  if (!imageToken || typeof imageToken !== "string") missing.push("imageToken");
  if (!responseChunkId || typeof responseChunkId !== "string") missing.push("responseChunkId");
  if (!conversationId || typeof conversationId !== "string") missing.push("conversationId");
  if (!responseId || typeof responseId !== "string") missing.push("responseId");
  
  if (missing.length > 0) {
    return res.status(400).json({ 
      error: `Missing or invalid fields: ${missing.join(", ")}` 
    });
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
      (typeof prompt === "string" ? prompt : "") || "",
      conversationId,
      responseId,
      tokens
    );

    const buf = await downloadImageToBuffer(fullSizeUrl);
    const id = crypto.randomUUID();
    const savedName = `${id}.png`;
    fs.writeFileSync(path.join(IMAGES_DIR, savedName), buf);
    res.json({
      url: `/images/${savedName}`,
      savedName,
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
