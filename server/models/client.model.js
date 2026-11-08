import mongoose from "mongoose";

const clientSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true, // unique:true already creates the index — no .index({ email: 1 }) needed
      lowercase: true,
      trim: true,
    },
    // Optional at signup (see registerClientSchema and the web form), so
    // requiring it here turned a blank phone into a 500.
    phone: { type: String, trim: true, default: "" },
    passwordHash: { type: String, required: true },

    // ── Password reset ──────────────────────────────────────────────────────
    resetPasswordToken: { type: String },
    resetPasswordExpiry: { type: Date },

    // ── Email verification ──────────────────────────────────────────────────
    // Deliberately no default: accounts from before verification existed have
    // no value and count as verified. Only new signups are stored as false.
    emailVerified: { type: Boolean },
    emailVerifyToken: { type: String },
    emailVerifyExpiry: { type: Date },
    // Login tokens issued before this time are rejected.
    sessionsValidAfter: { type: Date },

    // ── Profile ─────────────────────────────────────────────────────────────
    avatar: {
      type: String,
      default:
        "https://ui-avatars.com/api/?name=Client&background=700CEB&color=fff",
    },

    role: { type: String, default: "client", enum: ["client"] },
    isActive: { type: Boolean, default: true },

    // Brute-force lockout (see utils/loginLockout.js)
    loginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

// ── Indexes ──────────────────────────────────────────────────────────────────
// NOTE: email index is already created by unique:true above — do NOT add
// clientSchema.index({ email: 1 }) as that causes a duplicate index warning.
clientSchema.index({ createdAt: -1 });

export default mongoose.models.Client || mongoose.model("Client", clientSchema);
