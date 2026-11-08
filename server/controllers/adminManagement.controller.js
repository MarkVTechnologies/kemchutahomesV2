import crypto from "crypto";
import Admin from "../models/admin.js";
import { issueAdminSetupToken } from "../utils/adminInvite.js";
import { sendAdminInviteEmail } from "../utils/email.js";
import { ADMIN_PERMISSIONS } from "../config/permissions.js";

const SAFE_FIELDS = "-password -resetPasswordToken -resetPasswordExpiry";

/* ─────────────────────────── LIST / GET ──────────────────────────────── */

export const listAdmins = async (req, res) => {
  try {
    const page = Math.max(+req.query.page || 1, 1);
    const limit = Math.min(+req.query.limit || 10, 100);

    const total = await Admin.countDocuments();
    const docs = await Admin.find()
      .select(SAFE_FIELDS)
      .sort("-createdAt")
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return res.json({ docs, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error("LIST ADMINS ERROR:", err);
    return res.status(500).json({ message: "Failed to fetch admins" });
  }
};

export const getAdminById = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id).select(SAFE_FIELDS);
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    return res.json(admin);
  } catch (err) {
    console.error("GET ADMIN ERROR:", err);
    return res.status(500).json({ message: "Failed to fetch admin" });
  }
};

export const listPermissionCatalog = (req, res) => {
  res.json(ADMIN_PERMISSIONS);
};

/* ─────────────────────────── INVITE ──────────────────────────────────── */

export const inviteAdmin = async (req, res) => {
  try {
    const { email, firstName, lastName, role, permissions } = req.body;

    const existing = await Admin.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "An admin with that email already exists" });
    }

    const admin = await Admin.create({
      email,
      firstName,
      lastName,
      role,
      permissions,
      status: "pending",
      invitedBy: req.user.id,
      // Disposable — never revealed, satisfies the schema's required
      // password until the invitee sets their own via setup-account.
      password: crypto.randomBytes(32).toString("hex"),
    });

    const setupUrl = await issueAdminSetupToken(admin, 7);

    sendAdminInviteEmail({
      email: admin.email,
      firstName: admin.firstName,
      setupUrl,
      invitedByEmail: req.user.email,
    }).catch(async () => {
      admin.resetPasswordToken = undefined;
      admin.resetPasswordExpiry = undefined;
      await admin.save({ validateBeforeSave: false }).catch(() => null);
    });

    return res.status(201).json({
      message: "Invite sent",
      admin: {
        id: admin._id,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        role: admin.role,
        permissions: admin.permissions,
        status: admin.status,
      },
    });
  } catch (err) {
    console.error("INVITE ADMIN ERROR:", err);
    return res.status(500).json({ message: "Failed to invite admin" });
  }
};

export const resendInviteAdmin = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ message: "Admin not found" });
    if (admin.status !== "pending") {
      return res.status(400).json({ message: "This account has already been activated" });
    }

    const setupUrl = await issueAdminSetupToken(admin, 7);
    const result = await sendAdminInviteEmail({
      email: admin.email,
      firstName: admin.firstName,
      setupUrl,
      invitedByEmail: req.user.email,
    });

    if (!result.success) {
      return res.status(502).json({ message: "Failed to send invite email" });
    }
    return res.json({ message: "Invite resent" });
  } catch (err) {
    console.error("RESEND INVITE ERROR:", err);
    return res.status(500).json({ message: "Failed to resend invite" });
  }
};

/* ─────────────────────────── UPDATE / DELETE ─────────────────────────── */

export const updateAdmin = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ message: "Admin not found" });

    const isSelf = String(admin._id) === String(req.user.id);
    const { role, status, ...rest } = req.body;

    if (isSelf && role && role !== "superadmin" && admin.role === "superadmin") {
      return res.status(400).json({ message: "You cannot remove your own superadmin role" });
    }
    if (isSelf && status && status !== "active") {
      return res.status(400).json({ message: "You cannot change your own account status" });
    }

    Object.assign(admin, rest);
    if (role !== undefined) admin.role = role;
    if (status !== undefined) admin.status = status;

    await admin.save({ validateBeforeSave: false });

    const safe = admin.toObject();
    delete safe.password;
    delete safe.resetPasswordToken;
    delete safe.resetPasswordExpiry;
    return res.json(safe);
  } catch (err) {
    console.error("UPDATE ADMIN ERROR:", err);
    return res.status(500).json({ message: "Failed to update admin" });
  }
};

export const deleteAdmin = async (req, res) => {
  try {
    // req.params.id is a route string; req.user.id is the ObjectId protect()
    // pulled off the Admin doc — compare as strings or this never matches.
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ message: "You cannot delete your own account" });
    }

    const admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ message: "Admin not found" });

    if (admin.role === "superadmin") {
      const superadminCount = await Admin.countDocuments({ role: "superadmin" });
      if (superadminCount <= 1) {
        return res.status(400).json({ message: "Cannot delete the last superadmin" });
      }
    }

    await admin.deleteOne();
    return res.json({ message: "Admin deleted" });
  } catch (err) {
    console.error("DELETE ADMIN ERROR:", err);
    return res.status(500).json({ message: "Failed to delete admin" });
  }
};

/* ─────────────────────────── ACCOUNT SETUP (public) ───────────────────── */

export const completeAdminSetup = async (req, res) => {
  try {
    const { token, password } = req.body;

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    // Invites and forgot-password share this token field. Without the status
    // filter, a suspended admin could request a reset, post that token here,
    // and be set back to "active".
    const admin = await Admin.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiry: { $gt: Date.now() },
      status: "pending",
    });

    if (!admin) {
      return res.status(400).json({ message: "Setup link is invalid or has expired." });
    }

    admin.password = password;
    admin.status = "active";
    admin.resetPasswordToken = undefined;
    admin.resetPasswordExpiry = undefined;
    await admin.save();

    return res.status(200).json({ message: "Account activated. You can now log in." });
  } catch (err) {
    console.error("COMPLETE ADMIN SETUP ERROR:", err);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
};
