import { z } from "zod";
import { dateOfBirth, email, password } from "./common.js";

export const realtorSignupSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  email,
  phone: z.string().trim().min(7, "Valid phone number is required"),
  country: z.string().trim().max(100).optional(),
  state: z.string().trim().optional(),
  bank: z.string().trim().optional(),
  accountName: z.string().trim().optional(),
  accountNumber: z.string().trim().optional(),
  password,
  ref: z.string().trim().optional(),
  birthDate: dateOfBirth("Enter a valid date of birth, for example 1990-12-25"),
  avatar: z.string().trim().optional(),
});

export const realtorLoginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
});

export const realtorForgotPasswordSchema = z.object({
  email,
});

export const realtorResetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password,
});

// Query gate for GET /api/realtors/export (admin). `field` names the column
// that gets projected straight into a Mongoose .select(), so it must be an
// exact enum member — never a caller-supplied string — or the endpoint turns
// into an arbitrary field reader (passwordHash, resetPasswordToken, …).
export const realtorExportQuerySchema = z.object({
  field: z.enum(["email", "phone"], { error: "field must be 'email' or 'phone'" }),
  search: z.string().max(100).optional(),
});

// Whitelist for PUT /api/realtors/:id (admin). The legacy dashboard spreads
// the full fetched realtor doc into its edit-form state and sends it back
// wholesale, but only ever mutates these fields — everything else (passwordHash,
// referralCode, recruitedBy, _id, ...) must never be mass-assignable here.
export const updateRealtorSchema = z.object({
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  email: email.optional(),
  phone: z.string().trim().min(7).optional(),
  state: z.string().trim().optional(),
  bank: z.string().trim().optional(),
  accountName: z.string().trim().optional(),
  accountNumber: z.string().trim().optional(),
});

// PUT /api/realtors/me — self-service profile edit (mobile app). Never
// includes email here: email is the login identifier and isn't editable
// through this endpoint (matches the mobile UI, which shows it read-only).
export const updateMyProfileSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").optional(),
  lastName: z.string().trim().min(1, "Last name is required").optional(),
  phone: z.string().trim().min(7, "Valid phone number is required").optional(),
  state: z.string().trim().optional(),
});

// PUT /api/realtors/me/bank
export const updateMyBankSchema = z.object({
  bank: z.string().trim().min(1, "Bank is required"),
  accountName: z.string().trim().min(1, "Account name is required"),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, "Must be a 10-digit account number"),
});

// PUT /api/realtors/me/password
export const changeMyPasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: password,
});

// GET/PUT /api/realtors/me/preferences
export const updateMyPreferencesSchema = z.object({
  pushEnabled: z.boolean(),
  emailEnabled: z.boolean(),
});
