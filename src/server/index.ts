import "dotenv/config";
import { createServer } from "http";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { loadFromEnv, hasCookies } from "./lib/cookies.js";
import authRouter from "./routes/auth.js";
import generateRouter from "./routes/generate.js";
import remoteLoginRouter, { handleRemoteLoginWs } from "./routes/remote-login.js";

// Bootstrap cookies from .env if available
loadFromEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Serve generated images from .chrome-profile/.generated-images/
app.use("/images", express.static(path.join(process.cwd(), ".chrome-profile", ".generated-images")));

// In production, serve the built Vite frontend
const clientDir = path.join(__dirname, "..", "client");
app.use(express.static(clientDir));

// Parse JSON request bodies
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// API routes
app.use("/api", authRouter);
app.use("/api", generateRouter);

// Remote browser login UI (self-contained HTML — must be before SPA fallback)
app.use("/auth", remoteLoginRouter);

// SPA fallback — serve index.html for unmatched GET routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Handle multer errors
  if (err.message?.includes("File too large")) {
    return res.status(413).json({ error: "File too large. Maximum size is 10MB per file." });
  }
  if (err.message?.includes("Invalid file type")) {
    return res.status(400).json({ error: err.message });
  }
  if (err.message?.includes("Unexpected field")) {
    return res.status(400).json({ error: "Too many files. Maximum is 10 files." });
  }
  
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Create HTTP server to handle WebSocket upgrades
const httpServer = createServer(app);

// Handle WebSocket upgrade for remote login screencast
httpServer.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (url === "/auth/remote-login/ws") {
    handleRemoteLoginWs(req, socket as any, head);
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Gemini image server listening on http://localhost:${PORT}`);
  console.log(
    hasCookies()
      ? "Cookies loaded from .env"
      : "No cookies in .env - use the Login button to authenticate"
  );
});
