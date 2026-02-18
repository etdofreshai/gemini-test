import "dotenv/config";
import express from "express";
import multer from "multer";
import {
  loadFromEnv,
  hasCookies,
  getCookieString,
} from "./lib/cookies.js";
import { loginFlow, tryRestoreSession } from "./lib/auth.js";
import {
  generateImages,
  downloadImageToBuffer,
} from "./lib/gemini.js";

// Bootstrap cookies from .env if available
loadFromEnv();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static("public"));

let loginInProgress = false;

// GET /api/login - trigger Puppeteer login flow
app.get("/api/login", async (_req, res) => {
  if (loginInProgress) {
    return res.status(409).json({ error: "Login already in progress" });
  }
  loginInProgress = true;
  try {
    await loginFlow();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    loginInProgress = false;
  }
});

// GET /api/status - check auth state
app.get("/api/status", (_req, res) => {
  res.json({
    authenticated: hasCookies(),
    loginInProgress,
  });
});

// POST /api/generate - generate images
// Accepts multipart form: "prompt" field + optional "images" files
app.post("/api/generate", upload.array("images", 10), async (req, res) => {
  const prompt = req.body?.prompt;
  if (!prompt) {
    return res.status(400).json({ error: "Missing 'prompt' field" });
  }

  // If no cookies in memory, try restoring from Chrome profile
  if (!hasCookies()) {
    const restored = await tryRestoreSession();
    if (!restored) {
      return res
        .status(401)
        .json({ error: "Not authenticated. Call GET /api/login first." });
    }
  }

  try {
    // Convert uploaded files to the format generateImages expects
    const imageBuffers = (req.files || []).map((f) => ({
      buffer: f.buffer,
      fileName: f.originalname,
      mimeType: f.mimetype,
    }));

    const result = await generateImages(prompt, imageBuffers);

    // Download each image and return as base64
    const images = [];
    for (const img of result.images) {
      try {
        const buf = await downloadImageToBuffer(img.url);
        images.push({
          filename: img.filename,
          mime: img.mime,
          dimensions: img.dimensions,
          base64: buf.toString("base64"),
        });
      } catch (err) {
        console.error(`Failed to download ${img.filename}: ${err.message}`);
      }
    }

    res.json({
      images,
      metadata: {
        conversationId: result.conversationId,
        responseId: result.responseId,
        modelName: result.modelName,
      },
    });
  } catch (err) {
    console.error("Generation error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gemini image server listening on http://localhost:${PORT}`);
  console.log(
    hasCookies()
      ? "Cookies loaded from .env"
      : "No cookies in .env - use GET /api/login to authenticate"
  );
});
