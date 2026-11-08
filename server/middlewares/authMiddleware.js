import jwt from "jsonwebtoken";
import Realtor from "../models/realtor.model.js";
import Admin from "../models/admin.js";
import Client from "../models/client.model.js";
import { verifyCsrf } from "./csrf.js";

// Reads the Bearer header (existing, unchanged behavior) or falls back to
// the access_token cookie (Phase 5 addition — PRD FR-4 dual-credential
// window). Bearer takes precedence so client-legacy's existing requests
// are completely unaffected.
function extractToken(req) {
  if (req.headers.authorization?.startsWith("Bearer ")) {
    return { token: req.headers.authorization.split(" ")[1], viaCookie: false };
  }
  if (req.cookies?.access_token) {
    return { token: req.cookies.access_token, viaCookie: true };
  }
  return { token: null, viaCookie: false };
}

/**
 * Protect routes (Admin + Realtor + Client)
 * Original protect middleware — UNCHANGED, still handles Admin & Realtor
 */
export const protect = async (req, res, next) => {
  try {
    const { token, viaCookie } = extractToken(req);

    if (!token) {
      return res.status(401).json({ message: "Not authorized. No token." });
    }

    if (viaCookie && !verifyCsrf(req)) {
      return res.status(403).json({ message: "CSRF validation failed." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 1️⃣ Try Admin first
    let user = await Admin.findById(decoded.id).select(
      "_id email role permissions status firstName lastName",
    );
    if (user) {
      if (user.status === "suspended") {
        return res
          .status(403)
          .json({ message: "Account suspended. Contact a superadmin." });
      }
      req.user = {
        _id: user._id,
        id: user._id,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
        firstName: user.firstName,
        lastName: user.lastName,
      };
      return next();
    }

    // 2️⃣ Try Realtor
    user = await Realtor.findById(decoded.id).select(
      "_id email role firstName lastName referralCode",
    );
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.user = {
      _id: user._id,
      id: user._id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      referralCode: user.referralCode,
    };

    next();
  } catch (error) {
    console.error("Auth error:", error.message);
    return res.status(401).json({ message: "Invalid or expired token." });
  }
};

/**
 * Client-only guard — new, does not affect existing routes
 */
export const protectClient = async (req, res, next) => {
  try {
    const { token, viaCookie } = extractToken(req);

    if (!token) {
      return res.status(401).json({ message: "Not authorized. No token." });
    }

    if (viaCookie && !verifyCsrf(req)) {
      return res.status(403).json({ message: "CSRF validation failed." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== "client") {
      return res
        .status(403)
        .json({ message: "Access denied. Client account required." });
    }

    const client = await Client.findById(decoded.id).select(
      "_id email role firstName lastName isActive emailVerified sessionsValidAfter",
    );

    if (!client) {
      return res.status(401).json({ message: "Client account not found." });
    }

    if (
      client.sessionsValidAfter &&
      decoded.iat * 1000 < client.sessionsValidAfter.getTime()
    ) {
      return res.status(401).json({ message: "Invalid or expired token." });
    }

    if (!client.isActive) {
      return res
        .status(403)
        .json({ message: "Account suspended. Contact support." });
    }

    req.user = {
      _id: client._id,
      id: client._id,
      email: client.email,
      role: client.role,
      firstName: client.firstName,
      lastName: client.lastName,
      emailVerified: client.emailVerified,
    };

    next();
  } catch (error) {
    console.error("Client auth error:", error.message);
    return res.status(401).json({ message: "Invalid or expired token." });
  }
};

/**
 * Subscriptions, investments and inspections are matched to a client by email,
 * so an account must prove it owns the address before it can see them. Only an
 * explicit false is unverified; older accounts have no value.
 */
export const hasVerifiedEmail = (user) => user?.emailVerified !== false;

/**
 * Admin-only guard — accepts any admin-family role ("admin" or
 * "superadmin"); superadmin is a superset, not a different track.
 */
export const isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  if (!["admin", "superadmin"].includes(req.user.role)) {
    return res.status(403).json({
      message: "Access denied. Admin privileges required.",
    });
  }
  next();
};

/**
 * Admin protected routes — UNCHANGED
 */
export const protectAdmin = [protect, isAdmin];

/**
 * Superadmin-only guard — for managing other admin accounts. Run after
 * protect() so req.user is already populated.
 */
export const requireSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  if (req.user.role !== "superadmin") {
    return res.status(403).json({ message: "Superadmin privileges required." });
  }
  next();
};

/**
 * Per-section permission guard for regular admins — run after
 * protect()+isAdmin() so req.user.role is already guaranteed to be
 * "admin" or "superadmin". Superadmins always pass; admins need the
 * specific key granted via the admin-management API (see
 * config/permissions.js for the catalog).
 */
export const userHasPermission = (user, key) =>
  user?.role === "superadmin" ||
  (Array.isArray(user?.permissions) && user.permissions.includes(key));

export const hasPermission = (key) => (req, res, next) => {
  if (userHasPermission(req.user, key)) return next();
  return res
    .status(403)
    .json({ message: "You do not have permission to access this section." });
};
