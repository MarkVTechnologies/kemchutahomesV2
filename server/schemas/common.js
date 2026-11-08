/**
 * schemas/common.js — shared zod primitives reused across resource schemas.
 */
import { z } from "zod";

export const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Invalid ID");

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email address");

export const password = z
  .string()
  .min(8, "Password must be at least 8 characters");

export const nonEmptyString = z.string().trim().min(1, "Required");

const realCalendarDate = (year, month, day) => {
  const d = new Date(Date.UTC(year, month - 1, day));
  const isReal =
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day;
  return isReal ? d : new Date(NaN);
};

// The app's date of birth box is free text, and Nigerian users type day first
// (25/12/1990), which new Date() rejects. It also read 04/05/1990 as April 5th.
// Day-first wins unless the first number can only be a month (12/25/1990).
// Anything else falls through to new Date() so ISO timestamps keep working.
export function parseDateOfBirth(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();

  const yearFirst = text.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/);
  if (yearFirst) {
    return realCalendarDate(+yearFirst[1], +yearFirst[2], +yearFirst[3]);
  }

  const yearLast = text.match(/^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{4})$/);
  if (yearLast) {
    const [first, second, year] = [+yearLast[1], +yearLast[2], +yearLast[3]];
    return second > 12
      ? realCalendarDate(year, first, second)
      : realCalendarDate(year, second, first);
  }

  return text ? new Date(text) : value;
}

export const dateOfBirth = (message) =>
  z.preprocess(
    parseDateOfBirth,
    z
      .date({ error: message })
      .refine((d) => d.getTime() <= Date.now(), "Date of birth cannot be in the future"),
  );

// Admin-controlled URL fields (map links, social links) get rendered as raw
// hrefs/iframe src on the public site — restrict to http(s) so a compromised
// admin session can't plant a "javascript:" URI that executes in a visitor's
// browser when clicked.
export const safeUrl = z
  .string()
  .trim()
  .refine((v) => v === "" || /^https:\/\//i.test(v), {
    message: "Must be a valid https:// URL",
  });

// Query-string pagination — validated for shape only (see middlewares/validate.js
// for why this is never written back to req.query).
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().max(100).optional(),
});
