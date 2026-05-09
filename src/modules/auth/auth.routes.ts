import { Router } from "express";

import { requireAuth } from "../../middleware/auth.js";
import { authRateLimiter } from "../../middleware/rate-limit.js";
import { validate } from "../../middleware/validate.js";
import * as authService from "./auth.service.js";

const router = Router();

router.post("/login", authRateLimiter, validate({ body: authService.loginBodySchema }), (req, res, next) => {
  authService.login(req, res).catch(next);
});

router.post("/refresh", authRateLimiter, (req, res, next) => {
  authService.refresh(req, res).catch(next);
});

router.post("/logout", requireAuth, (req, res, next) => {
  authService.logout(req, res).catch(next);
});

router.get("/me", requireAuth, (req, res, next) => {
  authService.me(req, res).catch(next);
});

export default router;
