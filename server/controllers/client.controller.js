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
import { hasVerifiedEmail } from "../middlewares/authMiddleware.js";
import RefreshToken from "../models/RefreshToken.model.js";

const FRONTEND = () =>
  process.env.FRONTEND_URL || "https://kemchutahomesltd.com";
const API_URL = () =>
  process.env.API_URL || "https://api.kemchutahomesltd.com";
const EMAIL_USER = () => process.env.EMAIL_USER || "";

const signToken = (id) =>
  jwt.sign({ id, role: "client" }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });

const hashVerifyToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const VERIFY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Never lets a slow or failed email hold up the request that triggered it.
async function sendVerificationEmail(client) {
  const token = crypto.randomBytes(32).toString("hex");
  await Client.findByIdAndUpdate(client._id, {
    emailVerifyToken: hashVerifyToken(token),
    emailVerifyExpiry: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
  });
  const link = `${API_URL()}/api/clients/verify-email?token=${token}`;
  await sendEmail({
    to: client.email,
    subject: "Confirm your Kemchuta Homes email",
    html: `<p>Please confirm this email address to see your plots, investments and inspections in your Kemchuta Homes account:</p>
           <p><a href="${link}">Confirm my email</a></p>
           <p>This link expires in 7 days. If you did not create this account, ignore this email and do not click the link.</p>`,
  }).catch(() => null);
}

const verifyPage = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#222">
<div style="max-width:440px;margin:48px auto;padding:32px 24px;background:#fff;border-radius:16px;text-align:center">
<h1 style="color:#700CEB;font-size:22px">${title}</h1>${body}
</div></body></html>`;

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
      emailVerified: false,
    });

    const token = signToken(client._id);
    await issueAuthCookies(res, { id: client._id, role: "client" });

    // Fire-and-forget — never let a slow/failed email hold up registration.
    sendClientWelcomeEmail({ email: client.email, firstName: client.firstName }).catch(() => null);
    sendVerificationEmail(client).catch(() => null);

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
        emailVerified: false,
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

    // Installed app builds have no resend button, so an expired link is
    // replaced the next time the person logs in.
    if (
      client.emailVerified === false &&
      !(client.emailVerifyExpiry > new Date())
    ) {
      sendVerificationEmail(client).catch(() => null);
    }

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
        emailVerified: hasVerifiedEmail(client),
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
      .select("-passwordHash -resetPasswordToken -resetPasswordExpiry -emailVerifyToken -emailVerifyExpiry -sessionsValidAfter")
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
    }).select("-passwordHash -resetPasswordToken -resetPasswordExpiry -emailVerifyToken -emailVerifyExpiry -sessionsValidAfter");
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
    const emailVerified = hasVerifiedEmail(req.user);
    // $in: [] matches nothing, so an unverified account gets the normal,
    // empty response shape that installed app builds already handle.
    const email = emailVerified ? req.user.email : { $in: [] };

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
      emailVerified,
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
// GET /api/clients/verify-email?token=  — confirmation page
// Only POST changes anything, so mail scanners that open links can't verify.
// ─────────────────────────────────────────────────────────────────────────────
export const showVerifyEmailPage = (req, res) => {
  const token = String(req.query.token || "");
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res
      .status(400)
      .send(verifyPage("Link not valid", "<p>This confirmation link is not valid.</p>"));
  }
  res.send(
    verifyPage(
      "Confirm your email",
      `<p>Tap below to confirm this email belongs to you. Only continue if you created a Kemchuta Homes account.</p>
       <form method="post" action="/api/clients/verify-email?token=${token}">
       <button type="submit" style="background:#700CEB;color:#fff;border:0;border-radius:10px;padding:14px 28px;font-size:16px;font-weight:bold">Confirm my email</button>
       </form>`,
    ),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clients/verify-email?token=
// ─────────────────────────────────────────────────────────────────────────────
export const verifyEmail = async (req, res) => {
  try {
    const client = await Client.findOneAndUpdate(
      {
        emailVerifyToken: hashVerifyToken(String(req.query.token || "")),
        emailVerifyExpiry: { $gt: new Date() },
      },
      {
        $set: { emailVerified: true },
        $unset: { emailVerifyToken: "", emailVerifyExpiry: "" },
      },
    );
    if (!client) {
      return res.status(400).send(
        verifyPage(
          "Link expired",
          "<p>This link has expired or was already used. Log in to the app to receive a new one.</p>",
        ),
      );
    }
    res.send(
      verifyPage(
        "Email confirmed",
        "<p>Thank you. You can now go back to the app and see your account details.</p>",
      ),
    );
  } catch (err) {
    console.error("verifyEmail:", err);
    res.status(500).send(verifyPage("Something went wrong", "<p>Please try again.</p>"));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/clients/me/resend-verification
// ─────────────────────────────────────────────────────────────────────────────
export const resendVerification = async (req, res) => {
  try {
    if (hasVerifiedEmail(req.user)) {
      return res.json({ message: "Your email is already confirmed." });
    }
    await sendVerificationEmail(req.user);
    res.json({ message: "We've sent you a new confirmation email." });
  } catch (err) {
    console.error("resendVerification:", err);
    res.status(500).json({ message: "Couldn't send the confirmation email" });
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
    // The reset link proves the person owns this email. If the account was
    // unverified, whoever created it may be someone else, so their sessions
    // must not survive the real owner taking it over.
    const claimingUnverified = client.emailVerified === false;
    const update = {
      $set: { passwordHash },
      $unset: { resetPasswordToken: "", resetPasswordExpiry: "" },
    };
    if (claimingUnverified) {
      update.$set.emailVerified = true;
      update.$set.sessionsValidAfter = new Date(
        Math.floor(Date.now() / 1000) * 1000,
      );
      update.$unset.emailVerifyToken = "";
      update.$unset.emailVerifyExpiry = "";
    }
    await Client.findByIdAndUpdate(client._id, update);
    if (claimingUnverified) {
      await RefreshToken.updateMany(
        { principalType: "client", principalId: client._id, revokedAt: null },
        { revokedAt: new Date() },
      );
    }
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
    const filter = {
      email: hasVerifiedEmail(req.user) ? req.user.email : { $in: [] },
    };
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
