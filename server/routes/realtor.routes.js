import express from "express";
import {
  signup,
  login,
  updateAvatar,
  getRealtors,
  exportRealtors,
  getRealtorById,
  updateRealtor,
  deleteRealtor,
  getDashboard,
  getMyRecruits,
  getLeaderboard,
  updateMyProfile,
  updateMyBank,
  changeMyPassword,
  getMyPreferences,
  updateMyPreferences,
  forgotPassword,
  resetPassword, // ✅ Import the new controller
} from "../controllers/realtor.controller.js";

import { uploadSingleImage } from "../middlewares/upload.middleware.js";
import { protect, protectAdmin, hasPermission } from "../middlewares/authMiddleware.js";
import { authLimiter } from "../middlewares/rateLimiters.js";
import { rejectInvalidIdParam, validate } from "../middlewares/validate.js";
import {
  realtorSignupSchema,
  realtorLoginSchema,
  realtorForgotPasswordSchema,
  realtorResetPasswordSchema,
  updateRealtorSchema,
  realtorExportQuerySchema,
  updateMyProfileSchema,
  updateMyBankSchema,
  changeMyPasswordSchema,
  updateMyPreferencesSchema,
} from "../schemas/realtor.schema.js";

const router = express.Router();

router.param("id", rejectInvalidIdParam("realtor"));

// ✅ Public routes
router.post("/signup", authLimiter, validate(realtorSignupSchema), signup);
router.post("/login", authLimiter, validate(realtorLoginSchema), login);

// ✅ IMPORTANT: Specific routes BEFORE parameterized routes
router.get("/dashboard", protect, getDashboard);
router.get("/my-recruits", protect, getMyRecruits); // ✅ New route for getting recruits
router.get("/leaderboard", protect, getLeaderboard);
router.put("/avatar", protect, uploadSingleImage, updateAvatar);

// Self-service (mobile app Settings) — all specific paths under /me, so they
// must stay above the /:id block below or Express would match "me" as an id.
router.put("/me", protect, validate(updateMyProfileSchema), updateMyProfile);
router.put("/me/bank", protect, validate(updateMyBankSchema), updateMyBank);
router.put(
  "/me/password",
  protect,
  validate(changeMyPasswordSchema),
  changeMyPassword,
);
router.get("/me/preferences", protect, getMyPreferences);
router.put(
  "/me/preferences",
  protect,
  validate(updateMyPreferencesSchema),
  updateMyPreferences,
);
router.post(
  "/forgot-password",
  authLimiter,
  validate(realtorForgotPasswordSchema),
  forgotPassword,
);
router.post(
  "/reset-password",
  authLimiter,
  validate(realtorResetPasswordSchema),
  resetPassword,
);

// ✅ Admin-only, but declared up here with the other specific routes: mounted
// below /:id, Express would match "export" as a realtor id.
router.get(
  "/export",
  protectAdmin,
  hasPermission("manage_realtors"),
  validate(realtorExportQuerySchema, "query"),
  exportRealtors,
);

// ✅ Admin routes (parameterized routes LAST)
router.get("/", protectAdmin, hasPermission("manage_realtors"), getRealtors);
router.get("/:id", protectAdmin, hasPermission("manage_realtors"), getRealtorById);
router.put(
  "/:id",
  protectAdmin,
  hasPermission("manage_realtors"),
  validate(updateRealtorSchema),
  updateRealtor,
);
router.delete("/:id", protectAdmin, hasPermission("manage_realtors"), deleteRealtor);

export default router;
