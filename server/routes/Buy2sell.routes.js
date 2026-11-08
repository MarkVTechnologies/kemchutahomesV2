import express from "express";
import jwt from "jsonwebtoken";
import {
  getROISettings,
  updateROISettings,
  submitBuy2SellLead,
  getAllLeads,
  getLeadById,
  getMyInvestments,
  recordPayment,
  markMatured,
  processPayout,
  downloadDocument,
  updateLeadStatus,
} from "../controllers/Buy2sell.controller.js";
import {
  protect,
  isAdmin,
  protectClient,
  hasPermission,
} from "../middlewares/authMiddleware.js";
import { publicFormLimiter } from "../middlewares/rateLimiters.js";
import { validate } from "../middlewares/validate.js";
import {
  updateROISettingsSchema,
  submitBuy2SellLeadSchema,
  recordB2SPaymentSchema,
  processPayoutSchema,
  updateLeadStatusSchema,
} from "../schemas/buy2sell.schema.js";

const router = express.Router();

// ── protectAdminOrClient — checks token role first, avoids protect() calling
// res.status(401) directly for client tokens (which breaks the callback chain)
const protectAdminOrClient = (req, res, next) => {
  try {
    // Bearer header (client-legacy) or access_token cookie (client, PRD
    // FR-4 dual-credential window) — same gap as subscription.routes.js
    // had before it was fixed; mirrors extractToken() in authMiddleware.js.
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : req.cookies?.access_token;
    if (!token) {
      return res.status(401).json({ message: "Not authorized. No token." });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role === "client") {
      return protectClient(req, res, next);
    }
    protect(req, res, (err) => {
      if (err) return next(err);
      isAdmin(req, res, (err2) => {
        if (err2) return res.status(403).json({ message: "Access denied." });
        next();
      });
    });
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
};

// Public
router.get("/roi", getROISettings);
router.post("/leads", publicFormLimiter, validate(submitBuy2SellLeadSchema), submitBuy2SellLead);

// Shared
router.get(
  "/leads/:id/documents/:docType",
  protectAdminOrClient,
  downloadDocument,
);

// Client
router.get("/my", protectClient, getMyInvestments);

// Admin
router.put(
  "/roi",
  protect,
  isAdmin,
  hasPermission("buy2sell"),
  validate(updateROISettingsSchema),
  updateROISettings,
);
router.get("/leads", protect, isAdmin, hasPermission("buy2sell"), getAllLeads);
router.get("/leads/:id", protect, isAdmin, hasPermission("buy2sell"), getLeadById);
router.patch(
  "/leads/:id/status",
  protect,
  isAdmin,
  hasPermission("buy2sell"),
  validate(updateLeadStatusSchema),
  updateLeadStatus,
);
router.post(
  "/leads/:id/record-payment",
  protect,
  isAdmin,
  hasPermission("buy2sell"),
  validate(recordB2SPaymentSchema),
  recordPayment,
);
router.patch("/leads/:id/mature", protect, isAdmin, hasPermission("buy2sell"), markMatured);
router.post(
  "/leads/:id/process-payout",
  protect,
  isAdmin,
  hasPermission("buy2sell"),
  validate(processPayoutSchema),
  processPayout,
);

export default router;
