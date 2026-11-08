import express from "express";
import {
  listAdmins,
  getAdminById,
  inviteAdmin,
  updateAdmin,
  deleteAdmin,
  resendInviteAdmin,
  completeAdminSetup,
  listPermissionCatalog,
} from "../controllers/adminManagement.controller.js";
import { protect, requireSuperAdmin } from "../middlewares/authMiddleware.js";
import { authLimiter } from "../middlewares/rateLimiters.js";
import { rejectInvalidIdParam, validate } from "../middlewares/validate.js";
import {
  inviteAdminSchema,
  updateAdminSchema,
  completeAdminSetupSchema,
} from "../schemas/admin.schema.js";

const router = express.Router();

router.param("id", rejectInvalidIdParam("admin"));

// Public — completes an invite, mirrors POST /api/admin/reset-password.
router.post(
  "/setup-account",
  authLimiter,
  validate(completeAdminSetupSchema),
  completeAdminSetup,
);

// Superadmin-only — managing other admin accounts.
router.get("/permissions", protect, requireSuperAdmin, listPermissionCatalog);
router.get("/admins", protect, requireSuperAdmin, listAdmins);
router.post(
  "/admins",
  authLimiter,
  protect,
  requireSuperAdmin,
  validate(inviteAdminSchema),
  inviteAdmin,
);
router.get("/admins/:id", protect, requireSuperAdmin, getAdminById);
router.put(
  "/admins/:id",
  protect,
  requireSuperAdmin,
  validate(updateAdminSchema),
  updateAdmin,
);
router.delete("/admins/:id", protect, requireSuperAdmin, deleteAdmin);
router.post(
  "/admins/:id/resend-invite",
  authLimiter,
  protect,
  requireSuperAdmin,
  resendInviteAdmin,
);

export default router;
