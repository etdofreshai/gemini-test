import { Router } from "express";
import { hasCookies } from "../lib/cookies.js";

const router = Router();

// GET /api/login — redirect to remote login UI
router.get("/login", (_req, res) => {
  res.json({ redirect: "/auth/remote-login" });
});

// GET /api/status — check auth state
router.get("/status", (_req, res) => {
  res.json({
    authenticated: hasCookies(),
  });
});

export default router;
