import express from "express";
import {
  registerClient,
  loginClient,
  getClientProfile,
  updateMyProfile,
  changeMyPassword,
  getClientDashboard,
  forgotPassword,
  resetPassword,
  checkEmailExists,
  getClientInspections,
  showVerifyEmailPage,
  verifyEmail,
  resendVerification,
} from "../controllers/client.controller.js";
import { protectClient } from "../middlewares/authMiddleware.js";
import {
  authLimiter,
  contactLimiter,
  publicFormLimiter,
} from "../middlewares/rateLimiters.js";
import { validate } from "../middlewares/validate.js";
import {
  registerClientSchema,
  loginClientSchema,
  clientForgotPasswordSchema,
  clientResetPasswordSchema,
  checkEmailQuerySchema,
  updateMyClientProfileSchema,
  changeMyClientPasswordSchema,
} from "../schemas/client.schema.js";

const router = express.Router();

// ── Public ─────────────────────────────────────────────────────────────────
router.get("/verify-email", publicFormLimiter, showVerifyEmailPage);
router.post("/verify-email", publicFormLimiter, verifyEmail);
router.post(
  "/me/resend-verification",
  contactLimiter,
  protectClient,
  resendVerification,
);
router.post(
  "/register",
  authLimiter,
  validate(registerClientSchema),
  registerClient,
);
router.post("/login", authLimiter, validate(loginClientSchema), loginClient);
router.post(
  "/forgot-password",
  authLimiter,
  validate(clientForgotPasswordSchema),
  forgotPassword,
);
router.post(
  "/reset-password",
  authLimiter,
  validate(clientResetPasswordSchema),
  resetPassword,
);
router.get(
  "/check-email",
  authLimiter,
  validate(checkEmailQuerySchema, "query"),
  checkEmailExists,
);

// ── Protected (client token) ───────────────────────────────────────────────
router.get("/me", protectClient, getClientProfile);
router.put(
  "/me",
  protectClient,
  validate(updateMyClientProfileSchema),
  updateMyProfile,
);
router.put(
  "/me/password",
  protectClient,
  validate(changeMyClientPasswordSchema),
  changeMyPassword,
);
router.get("/dashboard", protectClient, getClientDashboard);
router.get("/inspections", protectClient, getClientInspections);

export default router;
