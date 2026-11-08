import express from "express";
import jwt from "jsonwebtoken";
import {
  createSubscription,
  getAllSubscriptions,
  getSubscriptionById,
  getMySubscriptions,
  getMySubscriptionById,
  updateSubscriptionStatus,
  confirmSubscription,
  addNote,
  recordPayment,
  confirmPayment,
  allocatePlot,
  downloadDocument,
} from "../controllers/subscription.controller.js";
import {
  protect,
  isAdmin,
  protectClient,
  hasPermission,
} from "../middlewares/authMiddleware.js";
import { publicFormLimiter } from "../middlewares/rateLimiters.js";
import { validate } from "../middlewares/validate.js";
import {
  createSubscriptionSchema,
  updateSubscriptionStatusSchema,
  addSubscriptionNoteSchema,
  recordSubscriptionPaymentSchema,
  allocatePlotSchema,
} from "../schemas/subscription.schema.js";

const router = express.Router();

// ── protectAdminOrClient ──────────────────────────────────────────────────────
// Decodes the JWT first to check role, then runs the correct middleware.
// This avoids protect() calling res.status(401) directly for client tokens
// (which breaks the callback chain and causes "User not found").
const protectAdminOrClient = (req, res, next) => {
  try {
    // Bearer header (client-legacy) or access_token cookie (client, PRD
    // FR-4 dual-credential window) — this route predated the cookie-auth
    // work and only checked the header, so cookie-authenticated callers
    // (the Next client portal / dashboard) got a 401 here even with a
    // valid session. Mirrors extractToken() in authMiddleware.js.
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : req.cookies?.access_token;
    if (!token) {
      return res.status(401).json({ message: "Not authorized. No token." });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Route to the correct middleware based on role in the token
    if (decoded.role === "client") {
      return protectClient(req, res, next);
    }
    // Admin or Realtor — run protect then isAdmin
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

// ── Public
router.post("/", publicFormLimiter, validate(createSubscriptionSchema), createSubscription);

// ── Shared (admin OR client)
router.get("/:id/documents/:docType", protectAdminOrClient, downloadDocument);

// ── Client portal
router.get("/my", protectClient, getMySubscriptions);
router.get("/my/:id", protectClient, getMySubscriptionById);

// ── Admin
router.get("/", protect, isAdmin, hasPermission("manage_subscriptions"), getAllSubscriptions);
router.get("/:id", protect, isAdmin, hasPermission("manage_subscriptions"), getSubscriptionById);
router.patch(
  "/:id/status",
  protect,
  isAdmin,
  hasPermission("manage_subscriptions"),
  validate(updateSubscriptionStatusSchema),
  updateSubscriptionStatus,
);
router.patch(
  "/:id/confirm",
  protect,
  isAdmin,
  hasPermission("manage_subscriptions"),
  confirmSubscription,
);
router.post(
  "/:id/notes",
  protect,
  isAdmin,
  hasPermission("manage_subscriptions"),
  validate(addSubscriptionNoteSchema),
  addNote,
);
router.post(
  "/:id/payments",
  protect,
  isAdmin,
  hasPermission("manage_subscriptions"),
  validate(recordSubscriptionPaymentSchema),
  recordPayment,
);
router.patch(
  "/:id/payments/:paymentId/confirm",
  protect,
  isAdmin,
  hasPermission("manage_subscriptions"),
  confirmPayment,
);
router.patch(
  "/:id/allocate",
  protect,
  isAdmin,
  hasPermission("manage_subscriptions"),
  validate(allocatePlotSchema),
  allocatePlot,
);

export default router;
