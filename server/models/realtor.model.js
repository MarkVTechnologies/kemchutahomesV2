import mongoose from "mongoose";

const RealtorSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  phone: { type: String, required: true, trim: true },
  birthDate: { type: Date, required: true },
  // Country of residence — optional; older realtors predate it (Nigeria).
  country: { type: String, trim: true },
  state: { type: String },
  bank: { type: String },
  accountName: { type: String },
  accountNumber: { type: String },
  passwordHash: { type: String, required: true },

  // No default: a missing avatar means "no uploaded photo", and the UI renders
  // a native initials fallback for that case (client Avatar component). The old
  // default baked a third-party ui-avatars.com URL — with a hardcoded "Realtor"
  // name — into every document. Existing docs still holding that URL are
  // treated as "no photo" by the same client-side check, so no migration.
  avatar: { type: String },

  referralCode: { type: String, required: true, unique: true },

  recruitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Realtor",
    default: null,
  },

  role: { type: String, enum: ["admin", "realtor"], default: "realtor" },

  // Mobile app self-service notification toggles (Settings > Notifications).
  // Both default true so existing realtors keep receiving what they already get.
  preferences: {
    pushEnabled: { type: Boolean, default: true },
    emailEnabled: { type: Boolean, default: true },
  },

  // ✅ Password reset
  resetPasswordToken: { type: String },
  resetPasswordExpiry: { type: Date },

  // Brute-force lockout (see utils/loginLockout.js)
  loginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
});

RealtorSchema.index({ recruitedBy: 1 });

RealtorSchema.virtual("referralLink").get(function () {
  return `https://kemchutahomesltd.com/signup?ref=${this.referralCode}`;
});

RealtorSchema.virtual("recruitCount", {
  ref: "Realtor",
  localField: "_id",
  foreignField: "recruitedBy",
  count: true,
});

RealtorSchema.set("toJSON", { virtuals: true });
RealtorSchema.set("toObject", { virtuals: true });

export default mongoose.models.Realtor ||
  mongoose.model("Realtor", RealtorSchema);
