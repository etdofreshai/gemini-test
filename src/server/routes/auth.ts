import { Router } from "express";
import { hasCookies } from "../lib/cookies.js";
import { loginFlow } from "../lib/auth.js";

const router = Router();

let loginInProgress = false;

// GET /api/login — trigger Puppeteer login flow
router.get("/login", async (_req, res) => {
  if (loginInProgress) {
    return res.status(409).json({ error: "Login already in progress" });
  }
  loginInProgress = true;
  try {
    await loginFlow();
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  } finally {
    loginInProgress = false;
  }
});

// GET /api/status — check auth state
router.get("/status", (_req, res) => {
  res.json({
    authenticated: hasCookies(),
    loginInProgress,
  });
});

export default router;
