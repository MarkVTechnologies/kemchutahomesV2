import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import Client from "../models/client.model.js";
import Subscription, { APPROVED_STATUSES } from "../models/Subscription.model.js";
import Inspection from "../models/inspection.model.js";
import { Buy2SellLead } from "../models/Buy2sell.model.js";
import { sendEmail } from "../utils/notifications.js";
import { sendClientWelcomeEmail } from "../utils/email.js";
import { issueAuthCookies } from "../utils/authTokens.js";
import { parsePagination } from "../utils/pagination.js";
import { getLockoutStatus, recordFailedLogin, recordSuccessfulLogin } from "../utils/loginLockout.js";

const FRONTEND = () =>
  process.env.FRONTEND_URL || "https://kemchutahomesltd.com";
const EMAIL_USER = () => process.env.EMAIL_USER || "";

const signToken = (id) =>
  jwt.sign({ id, role: "client" }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clients/register
// ─────────────────────────────────────────────────────────────────────────────
export const registerClient = async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password } = req.body;
    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !password)
      return res.status(400).json({ message: "All fields are required" });
    if (password.length < 8)
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters" });

    const exists = await Client.findOne({ email: email.toLowerCase().trim() });
    if (exists)
      return res
        .status(409)
        .json({ message: "Account already exists. Please log in." });

    const passwordHash = await bcrypt.hash(password, 12);
    const client = await Client.create({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.toLowerCase().trim(),
      phone: phone?.trim() || "",
      passwordHash,
    });

    const token = signToken(client._id);
    await issueAuthCookies(res, { id: client._id, role: "client" });

    // Fire-and-forget — never let a slow/failed email hold up registration.
    sendClientWelcomeEmail({ email: client.email, firstName: client.firstName }).catch(() => null);

    res.status(201).json({
      token,
      user: {
        _id: client._id,
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
        phone: client.phone,
        avatar: client.avatar,
        role: "client",
      },
    });
  } catch (err) {
    if (err.code === 11000)
      return res
        .status(409)
        .json({ message: "Account already exists. Please log in." });
    console.error("registerClient:", err);
    res.status(500).json({ message: "Registration failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clients/login
// ─────────────────────────────────────────────────────────────────────────────
export const loginClient = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res
        .status(400)
        .json({ message: "Email and password are required" });

    const client = await Client.findOne({ email: email.toLowerCase().trim() });
    if (!client)
      return res.status(401).json({ message: "Invalid email or password" });
    if (!client.isActive)
      return res
        .status(403)
        .json({ message: "Account is disabled. Contact support." });

    const lockStatus = getLockoutStatus(client);
    if (lockStatus.locked) {
      return res.status(423).json({
        message: `Too many failed attempts. Try again in ${lockStatus.minutesLeft} minute(s).`,
      });
    }

    const match = await bcrypt.compare(password, client.passwordHash);
    if (!match) {
      await recordFailedLogin(client);
      return res.status(401).json({ message: "Invalid email or password" });
    }
    await recordSuccessfulLogin(client);

    const token = signToken(client._id);
    await issueAuthCookies(res, { id: client._id, role: "client" });
    res.json({
      token,
      user: {
        _id: client._id,
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
        phone: client.phone,
        avatar: client.avatar,
        role: "client",
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Login failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clients/me
// ─────────────────────────────────────────────────────────────────────────────
export const getClientProfile = async (req, res) => {
  try {
    const client = await Client.findById(req.user.id)
      .select("-passwordHash -resetPasswordToken -resetPasswordExpiry")
      .lean();
    if (!client) return res.status(404).json({ message: "Client not found" });
    res.json(client);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch profile" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/clients/me — self-service profile edit (mobile app)
// ─────────────────────────────────────────────────────────────────────────────
export const updateMyProfile = async (req, res) => {
  try {
    const updated = await Client.findByIdAndUpdate(req.user.id, req.body, {
      new: true,
      runValidators: true,
    }).select("-passwordHash -resetPasswordToken -resetPasswordExpiry");
    if (!updated) return res.status(404).json({ message: "Client not found" });
    return res.json(updated);
  } catch (err) {
    console.error("UPDATE CLIENT PROFILE ERROR:", err);
    return res.status(500).json({ message: "Couldn't update profile" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/clients/me/password
// ─────────────────────────────────────────────────────────────────────────────
export const changeMyPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const client = await Client.findById(req.user.id);
    if (!client) return res.status(404).json({ message: "Client not found" });

    const isMatch = await bcrypt.compare(currentPassword, client.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    client.passwordHash = await bcrypt.hash(newPassword, 12);
    await client.save({ validateModifiedOnly: true });

    return res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE CLIENT PASSWORD ERROR:", err);
    return res.status(500).json({ message: "Couldn't change password" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clients/dashboard
// Returns subscriptions + buy2sell investments + unified stats
// ─────────────────────────────────────────────────────────────────────────────
export const getClientDashboard = async (req, res) => {
  try {
    const email = req.user.email;

    // Fetch in parallel — match by email (clients may have invested before registering)
    const [subscriptions, investments, totalInspections, upcomingInspections] =
      await Promise.all([
        Subscription.find({ email }).sort({ createdAt: -1 }).lean(),
        Buy2SellLead.find({ email }).sort({ createdAt: -1 }).lean(),
        Inspection.countDocuments({ email }),
        Inspection.countDocuments({
          email,
          status: { $in: ["pending", "confirmed"] },
          inspectionDate: { $gte: new Date() },
        }),
      ]);

    // Attach Buy2SellLead virtuals manually (lean() strips them)
    investments.forEach((inv) => {
      if (inv.investmentDate && inv.maturityDate) {
        const total_ms =
          new Date(inv.maturityDate) - new Date(inv.investmentDate);
        const elapsed = Math.min(
          Date.now() - new Date(inv.investmentDate),
          total_ms,
        );
        inv.maturityProgressPercent = Math.min(
          100,
          Math.max(0, Math.round((elapsed / total_ms) * 100)),
        );
        inv.daysRemaining = Math.max(
          0,
          Math.ceil((new Date(inv.maturityDate) - Date.now()) / 86400000),
        );
      } else {
        inv.maturityProgressPercent = 0;
        inv.daysRemaining = null;
      }
      inv.balanceOutstanding = Math.max(
        0,
        (inv.principalAmount || 0) - (inv.amountPaid || 0),
      );
    });

    // ── Stats ──────────────────────────────────────────────────────────────
    const stats = {
      // Land subscription stats
      totalSubscriptions: subscriptions.length,
      approvedSubscriptions: subscriptions.filter((s) =>
        APPROVED_STATUSES.includes(s.status),
      ).length,
      pendingSubscriptions: subscriptions.filter((s) => s.status === "pending")
        .length,
      totalAmountPaid: subscriptions.reduce(
        (acc, s) => acc + (s.amountPaid || 0),
        0,
      ),

      // Buy2Sell investment stats
      totalInvestments: investments.length,
      activeInvestments: investments.filter((i) => i.status === "active")
        .length,
      pendingInvestments: investments.filter((i) => i.status === "pending")
        .length,
      totalInvested: investments.reduce(
        (acc, i) => acc + (i.principalAmount || 0),
        0,
      ),
      totalExpectedROI: investments.reduce(
        (acc, i) => acc + (i.expectedROI || 0),
        0,
      ),
      totalExpectedPayout: investments.reduce(
        (acc, i) => acc + (i.expectedPayout || 0),
        0,
      ),
      maturingInvestments: investments.filter((i) => i.status === "matured")
        .length,
      paidOutInvestments: investments.filter((i) => i.status === "paid_out")
        .length,

      // Inspections
      totalInspections,
      upcomingInspections,
    };

    // Recent items for overview — the full subscriptions/investments arrays
    // (payments, instalment schedules, documents, etc.) aren't needed here;
    // the portal detail pages fetch a single record via their own endpoints.
    res.json({
      stats,
      recentSubscriptions: subscriptions.slice(0, 3),
      recentInvestments: investments.slice(0, 3),
    });
  } catch (err) {
    console.error("getClientDashboard:", err);
    res.status(500).json({ message: "Failed to load dashboard" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clients/forgot-password
// ─────────────────────────────────────────────────────────────────────────────
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const client = await Client.findOne({ email: email?.toLowerCase().trim() });
    // Always 200 to prevent email enumeration
    if (!client)
      return res.json({
        message: "If this email exists, a reset link has been sent.",
      });

    const token = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await Client.findByIdAndUpdate(client._id, {
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: expiry,
    });

    const link = `${FRONTEND()}/client/reset-password?token=${token}`;
    await sendEmail({
      to: client.email,
      subject: "Reset your Kemchuta Homes password",
      html: `<p>Click the link below to reset your password (expires in 1 hour):</p>
             <p><a href="${link}">${link}</a></p>`,
    }).catch(() => null);

    res.json({ message: "If this email exists, a reset link has been sent." });
  } catch (err) {
    res.status(500).json({ message: "Failed to send reset email" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clients/reset-password
// ─────────────────────────────────────────────────────────────────────────────
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ message: "Token and password required" });
    if (password.length < 8)
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters" });

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const client = await Client.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: new Date() },
    });
    if (!client)
      return res
        .status(400)
        .json({ message: "Invalid or expired reset token" });

    const passwordHash = await bcrypt.hash(password, 12);
    // findByIdAndUpdate silently drops keys whose value is `undefined` —
    // the Mongo driver never sends them, so the field is never actually
    // unset. Use $unset explicitly so the token can't be replayed.
    await Client.findByIdAndUpdate(client._id, {
      $set: { passwordHash },
      $unset: { resetPasswordToken: "", resetPasswordExpiry: "" },
    });
    res.json({ message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to reset password" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clients/check-email?email=xxx  (public — used by Buy2SellPage)
// Returns { exists: boolean } so frontend can show login vs register prompt
// ─────────────────────────────────────────────────────────────────────────────
export const checkEmailExists = async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ message: "Email required" });
    const client = await Client.findOne({ email: email.toLowerCase().trim() })
      .select("_id")
      .lean();
    res.json({ exists: !!client });
  } catch (err) {
    res.status(500).json({ message: "Failed to check email" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/clients/inspections  (client — paginated)
// Returns inspections matched by the client's email
// ─────────────────────────────────────────────────────────────────────────────
export const getClientInspections = async (req, res) => {
  try {
    const { status } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 10);
    const filter = { email: req.user.email };
    if (status) filter.status = status;

    const [inspections, total] = await Promise.all([
      Inspection.find(filter)
        .sort({ inspectionDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Inspection.countDocuments(filter),
    ]);

    res.json({
      inspections,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch inspections." });
  }
};
