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
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthNumber = (name) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

// 93 is 1993, 05 is 2005, and anything that would make someone under about 16
// belongs to the previous century.
const fullYear = (text) => {
  const year = +text;
  if (text.length === 4) return year;
  const recent = 2000 + year;
  return recent > new Date().getUTCFullYear() - 16 ? 1900 + year : recent;
};

const yearFirstDate = (year, a, b) =>
  a > 12 ? realCalendarDate(year, b, a) : realCalendarDate(year, a, b);
const yearLastDate = (year, a, b) =>
  b > 12 ? realCalendarDate(year, a, b) : realCalendarDate(year, b, a);

export function parseDateOfBirth(value) {
  if (typeof value !== "string") return value;
  const text = value
    .trim()
    .replace(/(\d)(st|nd|rd|th)\b/gi, "$1")
    .replace(/\s*,\s*/g, " ")
    .replace(/\s*([/.\-])\s*/g, "$1")
    .replace(/\s+/g, " ");

  if (/^\d{8}$/.test(text)) {
    const year = +text.slice(0, 4);
    const asYearFirst = realCalendarDate(year, +text.slice(4, 6), +text.slice(6));
    if (!isNaN(asYearFirst) && year >= 1900 && asYearFirst.getTime() <= Date.now()) {
      return asYearFirst;
    }
    return realCalendarDate(+text.slice(4), +text.slice(2, 4), +text.slice(0, 2));
  }
  if (/^\d{6}$/.test(text)) {
    return realCalendarDate(fullYear(text.slice(4)), +text.slice(2, 4), +text.slice(0, 2));
  }

  const numeric = text.match(/^(\d{1,4})[/.\- ](\d{1,2})[/.\- ](\d{1,4})$/);
  if (numeric) {
    const [, first, second, third] = numeric;
    // A first number over 31 can only be a year (93-02-20, 1993-02-20).
    if (first.length === 4 || (first.length === 2 && +first > 31)) {
      if (third.length > 2) return new Date(NaN);
      return yearFirstDate(fullYear(first), +second, +third);
    }
    if (first.length > 2 || (third.length !== 4 && third.length !== 2)) return new Date(NaN);
    return yearLastDate(fullYear(third), +first, +second);
  }

  const dayMonthYear = text.match(/^(\d{1,2})[ \-/.]([a-z]{3,9})\.?[ \-/.](\d{4}|\d{2})$/i);
  if (dayMonthYear && monthNumber(dayMonthYear[2])) {
    return realCalendarDate(fullYear(dayMonthYear[3]), monthNumber(dayMonthYear[2]), +dayMonthYear[1]);
  }
  const monthDayYear = text.match(/^([a-z]{3,9})\.? (\d{1,2}) (\d{4}|\d{2})$/i);
  if (monthDayYear && monthNumber(monthDayYear[1])) {
    return realCalendarDate(fullYear(monthDayYear[3]), monthNumber(monthDayYear[1]), +monthDayYear[2]);
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
