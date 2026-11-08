import rateLimit from "express-rate-limit";

// express-rate-limit reads req.ip; keep default keying (trust proxy is set
// in index.js — LiteSpeed on go54 sits in front as a reverse proxy).

// ── Auth endpoints (login/signup/register/forgot/reset across all 3 principals) ──
// Brute-force / credential-stuffing guard.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again in a few minutes." },
});

// ── Public AI chat — paid Groq calls per message ──────────────────────────────
export const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "You're sending messages too fast. Please slow down." },
});

// ── Public booking/subscription/investment forms — each sends email + paid SMS
// to an address the caller chooses. Generous, since mobile carriers share IPs.
export const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many submissions. Please try again later." },
});

// ── Public contact form — sends email ──────────────────────────────────────────
export const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many messages sent. Please try again in an hour.",
  },
});
