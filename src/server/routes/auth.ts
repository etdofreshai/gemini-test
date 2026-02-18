import { Router } from "express";
import { hasCookies } from "../lib/cookies.js";
import { loginFlow } from "../lib/auth.js";

const router = Router();

let loginInProgress = false;

// GET /api/login — redirect to remote login UI (headful login not available in Docker)
router.get("/login", (_req, res) => {
  res.json({ redirect: "/auth/remote-login" });
});

// GET /api/status — check auth state
router.get("/status", (_req, res) => {
  res.json({
    authenticated: hasCookies(),
    loginInProgress,
  });
});

export default router;
