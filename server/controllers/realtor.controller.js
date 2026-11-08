import { escapeHtml } from "../utils/escapeHtml.js";
import Realtor from "../models/realtor.model.js";
import { Commission } from "../models/Commission.model.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cloudinary from "../utils/cloudinary.config.js";
import crypto from "crypto";
import { escapeRegex } from "../utils/escapeRegex.js";
import {
  sendEmail,
  sendSMS,
  notifyRealtorWelcomeSMS,
  notifyUplineOfNewRecruit,
} from "../utils/notifications.js";
import { issueAuthCookies } from "../utils/authTokens.js";
import { getLockoutStatus, recordFailedLogin, recordSuccessfulLogin } from "../utils/loginLockout.js";

/* ────────────────────────────────────────────────────────────────────────────
   HELPERS
──────────────────────────────────────────────────────────────────────────── */

const generateReferralCode = async () => {
  let code,
    exists = true;
  while (exists) {
    const count = await Realtor.countDocuments();
    const rand = Math.floor(10 + Math.random() * 90);
    code = `kem${String(count + 1).padStart(3, "0")}${rand}`;
    exists = await Realtor.exists({ referralCode: code });
  }
  return code;
};

const FRONTEND = () =>
  process.env.FRONTEND_URL || "https://kemchutahomesltd.com";

const emailTakenBody = () => {
  const message =
    "Email already registered. Please log in, or use Forgot Password if you can't remember your password.";
  return { message, errors: [{ path: "email", message }] };
};

// Codes are stored lowercase ("kem00734"), but people type them from a message
// or with auto-capitalisation on. Exact match first, then ignoring case.
const findRecruiter = async (code) =>
  (await Realtor.findOne({ referralCode: code })) ||
  Realtor.findOne({
    referralCode: { $regex: `^${escapeRegex(code)}$`, $options: "i" },
  });

// Earlier app builds created the account, then showed "Registration Failed",
// and a request that outlives the app's timeout does the same. Those people
// retry with the same details and would be stuck on a 400. If the password is
// right they could log in anyway, so answer as a success and let the app's
// normal signup-then-login continue. Wrong guesses count toward the same
// lockout as login, so this can't be used to get around it.
async function respondToExistingSignup(existing, password, res) {
  if (!getLockoutStatus(existing).locked && existing.passwordHash) {
    if (await bcrypt.compare(password, existing.passwordHash)) {
      return res.status(200).json({
        message: "Account already exists",
        user: {
          id: existing._id,
          name: `${existing.firstName} ${existing.lastName}`,
          referralCode: existing.referralCode,
          referralLink: existing.referralLink,
        },
      });
    }
    await recordFailedLogin(existing);
  }
  return res.status(400).json(emailTakenBody());
}

/* ────────────────────────────────────────────────────────────────────────────
   AUTH
──────────────────────────────────────────────────────────────────────────── */

export const signup = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      country,
      state,
      bank,
      accountName,
      accountNumber,
      password,
      ref,
      birthDate,
      avatar,
    } = req.body;

    const existing = await Realtor.findOne({ email });
    if (existing) return respondToExistingSignup(existing, password, res);

    let recruiter = null;
    if (ref?.trim()) {
      recruiter = await findRecruiter(ref.trim());
      if (!recruiter) {
        const message = "Invalid referral code. Check the code or leave it blank.";
        return res.status(400).json({ message, errors: [{ path: "ref", message }] });
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Codes come from a count plus two random digits, so concurrent signups
    // can collide on the unique index. Same retry as subscription references.
    let realtor;
    let referralCode;
    for (let attempt = 0; attempt < 3 && !realtor; attempt++) {
      referralCode = await generateReferralCode();
      try {
        realtor = await Realtor.create({
          firstName,
          lastName,
          email,
          phone,
          country: country || undefined,
          state,
          bank,
          accountName,
          accountNumber,
          avatar: avatar || undefined,
          passwordHash,
          referralCode,
          birthDate: new Date(birthDate),
          recruitedBy: recruiter?._id || null,
        });
      } catch (err) {
        if (!(err.code === 11000 && err.keyPattern?.referralCode) || attempt === 2) throw err;
      }
    }

    // ── Welcome email ─────────────────────────────────────────────────────
    const referralLink = `${FRONTEND()}/signup?ref=${referralCode}`;
    const welcomeHtml = `
      <!DOCTYPE html><html><head><meta charset="UTF-8"></head>
      <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
      <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(112,12,235,0.1);">
        <div style="background:linear-gradient(135deg,#3F0C91,#700CEB);padding:44px 32px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;font-weight:800;text-transform:uppercase;letter-spacing:-0.5px;">Kemchuta Homes</h1>
          <span style="display:inline-block;background:rgba(255,255,255,0.2);color:#fff;font-size:11px;font-weight:700;padding:4px 14px;border-radius:20px;margin-top:10px;letter-spacing:1px;">REALTOR WELCOME</span>
        </div>
        <div style="padding:40px 36px;">
          <h2 style="color:#0f0a1e;font-size:22px;font-weight:900;margin:0 0 12px;">Welcome, ${escapeHtml(firstName)}! 🎉</h2>
          <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 24px;">
            You have been successfully registered as a Kemchuta Homes realtor. You can now start earning commissions by referring clients to our estates.
          </p>
          <div style="background:#f9f6ff;border-radius:12px;padding:20px 24px;margin:0 0 24px;border-left:4px solid #700CEB;">
            <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Your Referral Code:</strong> <strong style="color:#700CEB;font-size:16px;">${referralCode}</strong></p>
            <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Your Referral Link:</strong></p>
            <p style="margin:5px 0;font-size:12px;word-break:break-all;"><a href="${referralLink}" style="color:#700CEB;">${referralLink}</a></p>
          </div>
          <div style="text-align:center;margin:28px 0;">
            <a href="${FRONTEND()}/login" style="display:inline-block;background:linear-gradient(135deg,#3F0C91,#700CEB);color:#fff;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">Log In to Your Dashboard</a>
          </div>
          <p style="color:#6b7280;font-size:13px;text-align:center;margin:0;">Share your referral link and earn commissions on every successful subscription.</p>
        </div>
        <div style="background:#0f0a1e;padding:20px 36px;text-align:center;">
          <p style="color:#6b7280;font-size:11px;margin:0;">© ${new Date().getFullYear()} Kemchuta Homes Limited · info@kemchutahomesltd.com</p>
        </div>
      </div></body></html>`;

    // Fire email + SMS — non-blocking. If this signup came through a
    // referral link, also let the upline know who just joined under them.
    Promise.allSettled([
      sendEmail({
        to: realtor.email,
        subject: "Welcome to Kemchuta Homes — Your Realtor Account is Ready!",
        html: welcomeHtml,
      }),
      notifyRealtorWelcomeSMS({
        firstName,
        phone,
        referralCode,
        referralLink,
      }),
      recruiter
        ? notifyUplineOfNewRecruit({
            uplineEmail: recruiter.email,
            uplineFirstName: recruiter.firstName,
            recruitFirstName: firstName,
            recruitLastName: lastName,
          })
        : null,
    ]).catch(() => null);

    return res.status(201).json({
      message: "Registration successful",
      user: {
        id: realtor._id,
        name: `${realtor.firstName} ${realtor.lastName}`,
        referralCode: realtor.referralCode,
        referralLink: realtor.referralLink,
      },
    });
  } catch (err) {
    // A double tap can get past the findOne above; the unique index catches it.
    if (err.code === 11000 && err.keyPattern?.email) {
      return res.status(400).json(emailTakenBody());
    }
    console.error("SIGNUP ERROR:", err);
    return res.status(500).json({ message: "Signup failed" });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password required" });
    }

    const realtor = await Realtor.findOne({ email });
    if (!realtor) return res.status(404).json({ message: "Realtor not found" });

    const lockStatus = getLockoutStatus(realtor);
    if (lockStatus.locked) {
      return res.status(423).json({
        message: `Too many failed attempts. Try again in ${lockStatus.minutesLeft} minute(s).`,
      });
    }

    const isMatch = await bcrypt.compare(password, realtor.passwordHash);
    if (!isMatch) {
      await recordFailedLogin(realtor);
      return res.status(401).json({ message: "Invalid credentials" });
    }
    await recordSuccessfulLogin(realtor);

    const token = jwt.sign(
      { id: realtor._id, role: realtor.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );
    await issueAuthCookies(res, { id: realtor._id, role: realtor.role });

    return res.json({
      message: "Login successful",
      token,
      user: {
        id: realtor._id,
        firstName: realtor.firstName,
        lastName: realtor.lastName,
        email: realtor.email,
        role: realtor.role,
        avatar: realtor.avatar,
        referralCode: realtor.referralCode,
        referralLink: realtor.referralLink,
      },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({ message: "Login failed" });
  }
};

/* ────────────────────────────────────────────────────────────────────────────
   DASHBOARD
──────────────────────────────────────────────────────────────────────────── */

export const getDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const realtor = await Realtor.findById(userId)
      .populate("recruitedBy", "firstName lastName role")
      .exec();

    if (!realtor) return res.status(404).json({ message: "User not found" });

    const realtorObj = realtor.toObject({ virtuals: true });
    const recruitCount = await Realtor.countDocuments({ recruitedBy: userId });

    let recruitedByLabel = "Admin";
    if (realtorObj.recruitedBy && typeof realtorObj.recruitedBy === "object") {
      recruitedByLabel =
        realtorObj.recruitedBy.role === "admin"
          ? "Admin"
          : `${realtorObj.recruitedBy.firstName} ${realtorObj.recruitedBy.lastName}`;
    }

    return res.json({
      firstName: realtorObj.firstName,
      lastName: realtorObj.lastName,
      name: `${realtorObj.firstName} ${realtorObj.lastName}`,
      avatar: realtorObj.avatar || null,
      downlines: recruitCount,
      recruitedBy: recruitedByLabel,
      referralCode: realtorObj.referralCode,
      referralLink: realtorObj.referralLink,
    });
  } catch (error) {
    console.error("Dashboard Error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/* ────────────────────────────────────────────────────────────────────────────
   MY RECRUITS
──────────────────────────────────────────────────────────────────────────── */

export const getMyRecruits = async (req, res) => {
  try {
    const recruits = await Realtor.find({ recruitedBy: req.user.id })
      .select("firstName lastName email phone avatar referralCode createdAt")
      .sort("-createdAt")
      .lean();

    return res.json({ recruits, total: recruits.length });
  } catch (error) {
    console.error("Get My Recruits Error:", error);
    res.status(500).json({ message: "Failed to fetch recruits" });
  }
};

/* ────────────────────────────────────────────────────────────────────────────
   LEADERBOARD
   "Confirmed" earnings = status in [approved, paid] — same definition the
   admin analytics topRealtors card uses, so a realtor's rank here always
   agrees with what an admin sees. Excludes pending (not yet confirmed) and
   clawedback (reversed) commissions.
──────────────────────────────────────────────────────────────────────────── */

export const getLeaderboard = async (req, res) => {
  try {
    const meId = String(req.user.id);

    const [earningsAgg, recruitAgg] = await Promise.all([
      Commission.aggregate([
        { $match: { status: { $in: ["approved", "paid"] } } },
        {
          $group: {
            _id: "$realtorId",
            totalNet: { $sum: "$netAmount" },
            commissionCount: { $sum: 1 },
          },
        },
        { $sort: { totalNet: -1 } },
      ]),
      Realtor.aggregate([
        { $match: { recruitedBy: { $ne: null } } },
        { $group: { _id: "$recruitedBy", downlineCount: { $sum: 1 } } },
        { $sort: { downlineCount: -1 } },
      ]),
    ]);

    // One lookup for every realtor referenced by either board, plus "me" in
    // case I'm not in either (avoids one query per row).
    const neededIds = new Set([
      ...earningsAgg.slice(0, 10).map((r) => String(r._id)),
      ...recruitAgg.slice(0, 10).map((r) => String(r._id)),
      meId,
    ]);
    const realtors = await Realtor.find({ _id: { $in: [...neededIds] } })
      .select("firstName lastName avatar referralCode")
      .lean();
    const byId = new Map(realtors.map((r) => [String(r._id), r]));

    const topEarners = earningsAgg.slice(0, 10).map((r, i) => {
      const p = byId.get(String(r._id));
      return {
        rank: i + 1,
        realtorId: String(r._id),
        firstName: p?.firstName ?? "",
        lastName: p?.lastName ?? "",
        avatar: p?.avatar ?? null,
        referralCode: p?.referralCode ?? "",
        totalNet: r.totalNet,
        commissionCount: r.commissionCount,
      };
    });

    const topRecruiters = recruitAgg.slice(0, 10).map((r, i) => {
      const p = byId.get(String(r._id));
      return {
        rank: i + 1,
        realtorId: String(r._id),
        firstName: p?.firstName ?? "",
        lastName: p?.lastName ?? "",
        avatar: p?.avatar ?? null,
        referralCode: p?.referralCode ?? "",
        downlineCount: r.downlineCount,
      };
    });

    const earningsIdx = earningsAgg.findIndex((r) => String(r._id) === meId);
    const recruitIdx = recruitAgg.findIndex((r) => String(r._id) === meId);

    return res.json({
      topEarners,
      topRecruiters,
      myStats: {
        earningsRank: earningsIdx >= 0 ? earningsIdx + 1 : earningsAgg.length + 1,
        totalNet: earningsIdx >= 0 ? earningsAgg[earningsIdx].totalNet : 0,
        commissionCount:
          earningsIdx >= 0 ? earningsAgg[earningsIdx].commissionCount : 0,
        recruitRank: recruitIdx >= 0 ? recruitIdx + 1 : recruitAgg.length + 1,
        downlineCount: recruitIdx >= 0 ? recruitAgg[recruitIdx].downlineCount : 0,
      },
    });
  } catch (error) {
    console.error("Get Leaderboard Error:", error);
    res.status(500).json({ message: "Failed to load leaderboard" });
  }
};

/* ────────────────────────────────────────────────────────────────────────────
   SELF-SERVICE PROFILE (mobile app Settings)
──────────────────────────────────────────────────────────────────────────── */

// Full self-service snapshot returned by every /me/* mutation below, so
// setUser() on the client never clobbers fields a different screen just set
// (e.g. saving bank details shouldn't wipe out phone/state in the store).
const myProfileSnapshot = (realtor) => ({
  id: realtor._id,
  firstName: realtor.firstName,
  lastName: realtor.lastName,
  email: realtor.email,
  phone: realtor.phone,
  country: realtor.country,
  state: realtor.state,
  bank: realtor.bank,
  accountName: realtor.accountName,
  accountNumber: realtor.accountNumber,
  role: realtor.role,
  avatar: realtor.avatar,
  referralCode: realtor.referralCode,
  referralLink: realtor.referralLink,
});

// PUT /api/realtors/me
export const updateMyProfile = async (req, res) => {
  try {
    const updated = await Realtor.findByIdAndUpdate(req.user.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ message: "Realtor not found" });
    return res.json(myProfileSnapshot(updated));
  } catch (err) {
    console.error("UPDATE MY PROFILE ERROR:", err);
    return res.status(500).json({ message: "Couldn't update profile" });
  }
};

// PUT /api/realtors/me/bank
export const updateMyBank = async (req, res) => {
  try {
    const updated = await Realtor.findByIdAndUpdate(req.user.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ message: "Realtor not found" });
    return res.json(myProfileSnapshot(updated));
  } catch (err) {
    console.error("UPDATE MY BANK ERROR:", err);
    return res.status(500).json({ message: "Couldn't update bank details" });
  }
};

// PUT /api/realtors/me/password
export const changeMyPassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const realtor = await Realtor.findById(req.user.id);
    if (!realtor) return res.status(404).json({ message: "Realtor not found" });

    const isMatch = await bcrypt.compare(currentPassword, realtor.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    realtor.passwordHash = await bcrypt.hash(newPassword, 12);
    // Older realtors have no birthDate; full validation would fail the save.
    await realtor.save({ validateModifiedOnly: true });

    return res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE MY PASSWORD ERROR:", err);
    return res.status(500).json({ message: "Couldn't change password" });
  }
};

// GET /api/realtors/me/preferences
export const getMyPreferences = async (req, res) => {
  try {
    const realtor = await Realtor.findById(req.user.id).select("preferences");
    if (!realtor) return res.status(404).json({ message: "Realtor not found" });
    return res.json({
      pushEnabled: realtor.preferences?.pushEnabled ?? true,
      emailEnabled: realtor.preferences?.emailEnabled ?? true,
    });
  } catch (err) {
    console.error("GET MY PREFERENCES ERROR:", err);
    return res.status(500).json({ message: "Couldn't load preferences" });
  }
};

// PUT /api/realtors/me/preferences
export const updateMyPreferences = async (req, res) => {
  try {
    const { pushEnabled, emailEnabled } = req.body;
    const updated = await Realtor.findByIdAndUpdate(
      req.user.id,
      { preferences: { pushEnabled, emailEnabled } },
      { new: true, runValidators: true },
    ).select("preferences");
    if (!updated) return res.status(404).json({ message: "Realtor not found" });
    return res.json({
      pushEnabled: updated.preferences.pushEnabled,
      emailEnabled: updated.preferences.emailEnabled,
    });
  } catch (err) {
    console.error("UPDATE MY PREFERENCES ERROR:", err);
    return res.status(500).json({ message: "Couldn't save preferences" });
  }
};

/* ────────────────────────────────────────────────────────────────────────────
   PROFILE
──────────────────────────────────────────────────────────────────────────── */

export const updateAvatar = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const uploadFromBuffer = (buffer) =>
      new Promise((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            {
              folder: "kemchuta/avatars",
              transformation: { width: 400, height: 400, crop: "fill" },
            },
            (err, result) => (err ? reject(err) : resolve(result)),
          )
          .end(buffer);
      });

    const result = await uploadFromBuffer(req.file.buffer);
    const updated = await Realtor.findByIdAndUpdate(
      req.user.id,
      { avatar: result.secure_url },
      { new: true },
    ).select("firstName lastName avatar referralCode email role");
    if (!updated) return res.status(404).json({ message: "Realtor not found" });

    return res.json({
      message: "Avatar updated",
      avatar: result.secure_url,
      user: {
        id: updated._id,
        firstName: updated.firstName,
        lastName: updated.lastName,
        email: updated.email,
        role: updated.role,
        avatar: updated.avatar,
        referralCode: updated.referralCode,
      },
    });
  } catch (err) {
    console.error("AVATAR UPLOAD ERROR:", err);
    return res.status(500).json({ message: "Avatar upload failed" });
  }
};

/* ────────────────────────────────────────────────────────────────────────────
   ADMIN — REALTOR MANAGEMENT
──────────────────────────────────────────────────────────────────────────── */

// Shared by the paginated list and the export endpoint so the two can never
// drift: whatever an admin sees in the table is exactly what an export of the
// same search returns. Regex-escaped (see utils/escapeRegex.js) and length
// capped — the raw value goes into a $regex.
export const buildRealtorSearchFilter = (search) => {
  if (!search) return {};
  const safeSearch = escapeRegex(String(search).slice(0, 100));
  return {
    $or: [
      { firstName: { $regex: safeSearch, $options: "i" } },
      { lastName: { $regex: safeSearch, $options: "i" } },
      { email: { $regex: safeSearch, $options: "i" } },
      { referralCode: { $regex: safeSearch, $options: "i" } },
    ],
  };
};

export const getRealtors = async (req, res) => {
  try {
    const page = Math.max(+req.query.page || 1, 1);
    const limit = Math.min(+req.query.limit || 10, 100);
    const search = req.query.search || "";

    const filter = buildRealtorSearchFilter(search);

    const total = await Realtor.countDocuments(filter);
    const realtors = await Realtor.find(filter)
      .select("-passwordHash -resetPasswordToken -resetPasswordExpiry")
      .sort("-createdAt")
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("recruitedBy", "firstName lastName referralCode")
      .lean();

    const docs = realtors.map((r) => ({
      ...r,
      name: `${r.firstName} ${r.lastName}`,
      recruitedByName: r.recruitedBy
        ? `${r.recruitedBy.firstName} ${r.recruitedBy.lastName}`
        : null,
    }));

    return res.json({ docs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("GET REALTORS ERROR:", err);
    return res.status(500).json({ message: "Failed to fetch realtors" });
  }
};

// Exports one contact column for EVERY realtor matching the current search,
// not just the page the admin happens to be looking at — the dashboard's
// "Export Emails/Phones" buttons used to copy only the 10 loaded rows.
// Deliberately projects a single field (never a whole document) so this can
// never become another passwordHash leak.
const EXPORTABLE_FIELDS = ["email", "phone"];

export const exportRealtors = async (req, res) => {
  try {
    const { field } = req.query;
    // routes/realtor.routes.js already gates this with realtorExportQuerySchema;
    // repeated here so the projection is safe even if the controller is ever
    // mounted or called without that middleware.
    if (!EXPORTABLE_FIELDS.includes(field)) {
      return res
        .status(400)
        .json({ message: "field must be 'email' or 'phone'" });
    }

    const filter = buildRealtorSearchFilter(req.query.search || "");
    const docs = await Realtor.find(filter)
      .select(`${field} -_id`)
      .sort("-createdAt")
      .lean();

    const values = docs
      .map((doc) => doc[field])
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim());

    return res.json({ values, total: values.length });
  } catch (err) {
    console.error("EXPORT REALTORS ERROR:", err);
    return res.status(500).json({ message: "Failed to export realtors" });
  }
};

export const getRealtorById = async (req, res) => {
  try {
    const realtor = await Realtor.findById(req.params.id)
      .populate("recruitedBy", "firstName lastName referralCode")
      .select("-passwordHash -resetPasswordToken -resetPasswordExpiry");
    if (!realtor) return res.status(404).json({ message: "Realtor not found" });
    res.json(realtor);
  } catch (err) {
    console.error("GET REALTOR ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const updateRealtor = async (req, res) => {
  try {
    const updated = await Realtor.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    }).select("-passwordHash -resetPasswordToken -resetPasswordExpiry");
    if (!updated) return res.status(404).json({ message: "Realtor not found" });
    res.json({ message: "Updated successfully", realtor: updated });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.email) {
      return res.status(400).json({ message: "That email is already in use by another realtor." });
    }
    console.error("UPDATE REALTOR ERROR:", err);
    res.status(500).json({ message: "Update failed" });
  }
};

export const deleteRealtor = async (req, res) => {
  try {
    const recruits = await Realtor.countDocuments({
      recruitedBy: req.params.id,
    });
    if (recruits > 0) {
      return res
        .status(400)
        .json({ message: "Cannot delete realtor with recruits" });
    }
    await Realtor.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    console.error("DELETE REALTOR ERROR:", err);
    res.status(500).json({ message: "Delete failed" });
  }
};

/* ────────────────────────────────────────────────────────────────────────────
   FORGOT / RESET PASSWORD
──────────────────────────────────────────────────────────────────────────── */

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const realtor = await Realtor.findOne({
      email: email.toLowerCase().trim(),
    });
    // Always 200 — prevents email enumeration
    if (!realtor) {
      return res
        .status(200)
        .json({ message: "If that email exists, a reset link has been sent." });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    realtor.resetPasswordToken = hashedToken;
    realtor.resetPasswordExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
    await realtor.save({ validateBeforeSave: false });

    const resetUrl = `${FRONTEND()}/reset-password?token=${rawToken}`;

    sendEmail({
      to: realtor.email,
      subject: "Reset Your Kemchuta Homes Password",
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;">
          <h2 style="color:#0f0a1e;">Password Reset Request</h2>
          <p style="color:#374151;">Hi ${realtor.firstName},</p>
          <p style="color:#374151;">Click the button below to reset your password. This link expires in 1 hour.</p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${resetUrl}" style="background:#700CEB;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Reset Password</a>
          </div>
          <p style="color:#9ca3af;font-size:12px;">If you did not request this, ignore this email.</p>
        </div>`,
    }).catch(async () => {
      realtor.resetPasswordToken = undefined;
      realtor.resetPasswordExpiry = undefined;
      await realtor.save({ validateBeforeSave: false }).catch(() => null);
    });

    return res
      .status(200)
      .json({ message: "If that email exists, a reset link has been sent." });
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    return res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
};

export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res
        .status(400)
        .json({ message: "Token and new password are required" });
    }
    if (password.length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters" });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const realtor = await Realtor.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: Date.now() },
    });

    if (!realtor) {
      return res
        .status(400)
        .json({ message: "Reset link is invalid or has expired." });
    }

    realtor.passwordHash = await bcrypt.hash(password, 12);
    realtor.resetPasswordToken = undefined;
    realtor.resetPasswordExpiry = undefined;
    await realtor.save({ validateBeforeSave: false });

    return res
      .status(200)
      .json({ message: "Password reset successful. You can now log in." });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    return res
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
};
