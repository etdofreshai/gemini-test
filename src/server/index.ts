import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { loadFromEnv, hasCookies } from "./lib/cookies.js";
import authRouter from "./routes/auth.js";
import generateRouter from "./routes/generate.js";

// Bootstrap cookies from .env if available
loadFromEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Serve saved images from tmp/
app.use("/tmp", express.static(path.join(process.cwd(), "tmp")));

// In production, serve the built Vite frontend
const clientDir = path.join(__dirname, "..", "client");
app.use(express.static(clientDir));

// Parse JSON request bodies
app.use(express.json());

// API routes
app.use("/api", authRouter);
app.use("/api", generateRouter);

// SPA fallback — serve index.html for unmatched GET routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gemini image server listening on http://localhost:${PORT}`);
  console.log(
    hasCookies()
      ? "Cookies loaded from .env"
      : "No cookies in .env - use the Login button to authenticate"
  );
});
