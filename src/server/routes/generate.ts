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
import { upscaleStore } from "../lib/upscale-store.js";
import { getImageMetaStore } from "../lib/image-meta-store.js";
import { removeWatermark } from "../lib/watermark-remover.js";

const router = Router();

// Limits for input validation
const MAX_PROMPT_LENGTH = 4000;
const MAX_FILES = 10;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_SUMMARY_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB single file
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

const summarizeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SUMMARY_FILE_SIZE_BYTES, files: 1 },
});

// Store generated images in .chrome-profile/.generated-images/
const IMAGES_DIR = path.join(process.cwd(), ".chrome-profile", ".generated-images");
fs.mkdirSync(IMAGES_DIR, { recursive: true });

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

function cleanSummaryText(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  // Fast path: normalize repeated non-heading blocks first
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const dedupedBlocks: string[] = [];
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

  for (const block of blocks) {
    const n = norm(block);
    if (!n) continue;
    const last = dedupedBlocks[dedupedBlocks.length - 1];
    if (!last) {
      dedupedBlocks.push(block);
      continue;
    }
    const ln = norm(last);
    if (n === ln) continue;
    if (n.startsWith(ln)) {
      dedupedBlocks[dedupedBlocks.length - 1] = block;
      continue;
    }
    if (ln.startsWith(n)) continue;
    dedupedBlocks.push(block);
  }

  const normalized = dedupedBlocks.join("\n\n");

  // Canonicalize repeated markdown sections by heading, keeping the most complete body per section.
  const headingRe = /^###\s+(.+)$/gm;
  const matches = Array.from(normalized.matchAll(headingRe));
  if (matches.length === 0) return normalized;

  const sections = new Map<string, { title: string; body: string }>();
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const title = m[1].trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? normalized.length) : normalized.length;
    const body = normalized.slice(start, end).trim();
    if (!body) continue;

    const key = title.toLowerCase();
    const existing = sections.get(key);
    if (!existing || body.length > existing.body.length) {
      sections.set(key, { title, body });
    }
  }

  const preferredOrder = ["overview", "key points", "risks/issues", "action items"];
  const ordered: string[] = [];

  for (const key of preferredOrder) {
    const sec = sections.get(key);
    if (sec) ordered.push(`### ${sec.title}\n${sec.body}`);
  }

  for (const [key, sec] of sections.entries()) {
    if (!preferredOrder.includes(key)) {
      ordered.push(`### ${sec.title}\n${sec.body}`);
    }
  }

  return ordered.join("\n\n").trim() || normalized;
}

// GET /api/images — list all stored images
router.get("/images", (_req, res) => {
  try {
    const files = fs.readdirSync(IMAGES_DIR);
    const metaStore = getImageMetaStore(IMAGES_DIR);
    const images = files
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(IMAGES_DIR, f));
        const meta = metaStore.get(f);
        return {
          filename: f,
          url: `/images/${f}`,
          bytes: stat.size,
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          prompt: meta?.prompt,
          aspectRatio: meta?.aspectRatio,
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
    // Also delete metadata
    const metaStore = getImageMetaStore(IMAGES_DIR);
    metaStore.delete(filename);
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
    // Also delete metadata for deleted files
    if (deleted.length > 0) {
      const metaStore = getImageMetaStore(IMAGES_DIR);
      metaStore.deleteMany(deleted);
    }
    res.json({ success: true, deleted, errors });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// POST /api/generate — generate images (always returns 1K previews)
router.post("/generate", upload.array("images", MAX_FILES), async (req, res) => {
  // Validate prompt FIRST (before auth) for better UX
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

  // Now check auth
  if (!hasCookies()) {
    const restored = await tryRestoreSession();
    if (!restored) {
      return res.status(401).json({ error: "Not authenticated. Call GET /api/login first." });
    }
  }
  const normalizedPrompt = /^create image\b[:-]?\s*/i.test(rawPrompt)
    ? rawPrompt
    : `Create image: ${rawPrompt}`;

  const prompt = aspectValidation.value
    ? `${normalizedPrompt}. Use a ${aspectValidation.value} aspect ratio.`
    : normalizedPrompt;

  try {
    const imageBuffers = ((req.files as Express.Multer.File[]) || []).map(
      (f) => ({
        buffer: f.buffer,
        fileName: f.originalname,
        mimeType: f.mimetype,
      })
    );

    const result = await generateImages(prompt, imageBuffers);

    // If Gemini returned text instead of images, return it as a structured response
    if (result.images.length === 0 && result.textContent) {
      return res.json({
        images: [],
        textContent: cleanSummaryText(result.textContent),
        metadata: {
          conversationId: result.conversationId,
          responseId: result.responseId,
          modelName: result.modelName,
          prompt: rawPrompt,
        },
      });
    }

    // Download only PNG images as 1K previews, save to IMAGES_DIR
    const pngImages = result.images.filter((img) => img.mime === "image/png");
    const images = [];
    const metaStore = getImageMetaStore(IMAGES_DIR);
    for (const img of pngImages) {
      try {
        let buf = await downloadImageToBuffer(img.url);
        try {
          buf = await removeWatermark(buf);
        } catch (wmErr) {
          console.warn(`Watermark removal failed for ${img.filename}, saving original:`, wmErr);
        }
        const id = crypto.randomUUID();
        const ext = img.mime === "image/png" ? ".png" : ".jpg";
        const savedName = `${id}${ext}`;
        fs.writeFileSync(path.join(IMAGES_DIR, savedName), buf);
        // Store prompt and aspect ratio metadata
        metaStore.set(savedName, {
          prompt: rawPrompt,
          aspectRatio: aspectValidation.value,
          createdAt: Date.now(),
        });
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

    const imagesWithUpscale = images.map((img) => {
      // Only create upscale link if we have all required metadata
      // (imageToken, responseChunkId, conversationId, responseId)
      const hasAllMetadata = 
        img.imageToken != null &&
        img.responseChunkId != null &&
        result.conversationId != null &&
        result.responseId != null;
      
      if (hasAllMetadata) {
        // Store upscale metadata server-side and return a clean token
        const upscaleId = upscaleStore.storeMetadata({
          imageToken: img.imageToken!,
          responseChunkId: img.responseChunkId!,
          conversationId: result.conversationId!,
          responseId: result.responseId!,
          prompt: rawPrompt,
          aspectRatio: aspectValidation.value,
        });
        return {
          filename: img.filename,
          mime: img.mime,
          dimensions: img.dimensions,
          url: img.url,
          savedName: img.savedName,
          upscaleId,
          upscaleLink: `/api/upscale-link/${upscaleId}`,
          prompt: rawPrompt,
          aspectRatio: aspectValidation.value,
        };
      }
      
      // No upscale link available (missing metadata)
      return {
        filename: img.filename,
        mime: img.mime,
        dimensions: img.dimensions,
        url: img.url,
        savedName: img.savedName,
        prompt: rawPrompt,
        aspectRatio: aspectValidation.value,
      };
    });

    res.json({
      images: imagesWithUpscale,
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

// POST /api/summarize — summarize a single uploaded file
router.post("/summarize", summarizeUpload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "Missing file upload (field name: file)" });
  }

  const instructions = typeof req.body?.instructions === "string" ? req.body.instructions.trim() : "";

  if (!hasCookies()) {
    const restored = await tryRestoreSession();
    if (!restored) {
      return res.status(401).json({ error: "Not authenticated. Call GET /api/login first." });
    }
  }

  const prompt = [
    "Analyze the attached file for memory retrieval and archival.",
    "",
    "If the raw content (transcription, OCR, extracted text) is under ~2000 words,",
    "return it verbatim under a Raw Content section. Otherwise, summarize using",
    "the structure below.",
    "",
    "- Title: A descriptive, searchable title for this file.",
    "- Summary: One paragraph capturing the essence — what it is, what it says,",
    "  and why it matters.",
    "- File Description: What type of file this is (document, video, audio,",
    "  image, screenshot, etc.), its format, and any relevant metadata like",
    "  duration, dimensions, speaker, author, or date.",
    "- Tags: 5-15 lowercase comma-separated keywords for search",
    "  (e.g., \"invoice, acme-corp, q3-2025, accounts-payable\").",
    instructions ? `\nAdditional instructions: ${instructions}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await generateImages(prompt, [
      {
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
      },
    ]);

    const rawSummary = result.textContent?.trim();
    const summary = rawSummary ? cleanSummaryText(rawSummary) : "";
    if (!summary) {
      return res.status(500).json({ error: "Gemini returned no summary text for this file." });
    }

    res.json({
      summary,
      metadata: {
        conversationId: result.conversationId,
        responseId: result.responseId,
        modelName: result.modelName,
        fileName: file.originalname,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Summarize error:", message);
    res.status(500).json({ error: message });
  }
});

type UpscaleRequest = {
  imageToken: string;
  responseChunkId: string;
  conversationId: string;
  responseId: string;
  prompt?: string;
  aspectRatio?: string;
};

function validateUpscaleInput(input: any): { valid: boolean; error?: string; data?: UpscaleRequest } {
  const { imageToken, responseChunkId, conversationId, responseId, prompt, aspectRatio } = input || {};
  const missing: string[] = [];
  if (!imageToken || typeof imageToken !== "string") missing.push("imageToken");
  if (!responseChunkId || typeof responseChunkId !== "string") missing.push("responseChunkId");
  if (!conversationId || typeof conversationId !== "string") missing.push("conversationId");
  if (!responseId || typeof responseId !== "string") missing.push("responseId");

  if (missing.length > 0) {
    return { valid: false, error: `Missing or invalid fields: ${missing.join(", ")}` };
  }

  return {
    valid: true,
    data: {
      imageToken,
      responseChunkId,
      conversationId,
      responseId,
      prompt: typeof prompt === "string" ? prompt : "",
      aspectRatio: typeof aspectRatio === "string" ? aspectRatio : undefined,
    },
  };
}

async function runUpscale(data: UpscaleRequest) {
  const tokens = await getSessionTokens();
  const fullSizeUrl = await requestFullSizeUrl(
    {
      url: "",
      filename: "upscale",
      mime: "image/png",
      dimensions: null,
      imageToken: data.imageToken,
      responseChunkId: data.responseChunkId,
    },
    data.prompt || "",
    data.conversationId,
    data.responseId,
    tokens
  );

  let buf = await downloadImageToBuffer(fullSizeUrl);
  try {
    buf = await removeWatermark(buf);
  } catch (wmErr) {
    console.warn("Watermark removal failed for upscaled image, saving original:", wmErr);
  }
  const id = crypto.randomUUID();
  const savedName = `${id}.png`;
  fs.writeFileSync(path.join(IMAGES_DIR, savedName), buf);
  
  // Store metadata for the upscaled image
  const metaStore = getImageMetaStore(IMAGES_DIR);
  metaStore.set(savedName, {
    prompt: data.prompt || "",
    aspectRatio: data.aspectRatio,
    createdAt: Date.now(),
  });
  
  return { url: `/images/${savedName}`, savedName, mime: "image/png", bytes: buf.length };
}

// POST /api/upscale — download full-size (2K) image via c8o8Fe RPC
router.post("/upscale", async (req, res) => {
  const validation = validateUpscaleInput(req.body);
  if (!validation.valid || !validation.data) {
    return res.status(400).json({ error: validation.error });
  }

  if (!hasCookies()) {
    const restored = await tryRestoreSession();
    if (!restored) {
      return res.status(401).json({ error: "Not authenticated. Call GET /api/login first." });
    }
  }

  try {
    const result = await runUpscale(validation.data);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Upscale error:", message);
    res.status(500).json({ error: message });
  }
});

// GET /api/upscale-link/:id — one-click upscale using server-stored metadata
// Results are cached: first click performs the upscale, subsequent clicks within
// the 24-hour TTL redirect immediately to the cached image. After 24h (or if the
// cached file is missing from disk) a 410 Gone response is returned.
router.get("/upscale-link/:id", async (req, res) => {
  const { id } = req.params;
  
  // Validate ID format (should be a UUID)
  if (!id || typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid upscale link ID format" });
  }

  // Check for a cached upscale result first (avoids re-calling Gemini)
  const cached = upscaleStore.getCachedResult(id);
  if (cached) {
    // Verify the file still exists on disk
    const cachedPath = path.join(IMAGES_DIR, cached.savedName);
    if (fs.existsSync(cachedPath)) {
      return res.redirect(302, cached.url);
    }
    // File was deleted — return 410 Gone
    return res.status(410).json({
      error: "Upscaled image file no longer exists on disk.",
      code: "UPSCALE_FILE_MISSING",
    });
  }

  // Look up metadata from store (checks TTL expiration)
  const metadata = upscaleStore.getMetadata(id);
  if (!metadata) {
    return res.status(404).json({ 
      error: "Upscale link not found or expired. Links are valid for 24 hours.",
      code: "UPSCALE_LINK_EXPIRED"
    });
  }

  // Check auth
  if (!hasCookies()) {
    const restored = await tryRestoreSession();
    if (!restored) {
      return res.status(401).json({ error: "Not authenticated. Call GET /api/login first." });
    }
  }

  try {
    const result = await runUpscale({
      imageToken: metadata.imageToken,
      responseChunkId: metadata.responseChunkId,
      conversationId: metadata.conversationId,
      responseId: metadata.responseId,
      prompt: metadata.prompt,
      aspectRatio: metadata.aspectRatio,
    });
    
    // Cache the result so subsequent clicks within 24h are instant
    upscaleStore.cacheResult(id, { url: result.url, savedName: result.savedName });
    
    return res.redirect(302, result.url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Upscale link error:", message);
    return res.status(500).json({ error: message });
  }
});

// GET /api/upscale/direct/:payload — legacy one-click upscale (DEPRECATED)
// Kept for backwards compatibility with older clients
router.get("/upscale/direct/:payload", async (req, res) => {
  let decoded: any;
  try {
    const raw = Buffer.from(req.params.payload, "base64url").toString("utf8");
    decoded = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: "Invalid upscale payload" });
  }

  const validation = validateUpscaleInput(decoded);
  if (!validation.valid || !validation.data) {
    return res.status(400).json({ error: validation.error });
  }

  if (!hasCookies()) {
    const restored = await tryRestoreSession();
    if (!restored) {
      return res.status(401).json({ error: "Not authenticated. Call GET /api/login first." });
    }
  }

  try {
    const result = await runUpscale(validation.data);
    return res.redirect(302, result.url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Upscale direct error:", message);
    return res.status(500).json({ error: message });
  }
});

export default router;
