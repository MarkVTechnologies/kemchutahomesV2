// ─────────────────────────────────────────────────────────────────────────────
// controllers/contact.controller.js
// ─────────────────────────────────────────────────────────────────────────────
import { sendEmail } from "../utils/notifications.js";
import { escapeHtml, stripCrlf } from "../utils/escapeHtml.js";

const ADMIN_EMAIL = () =>
  process.env.ADMIN_EMAIL || process.env.EMAIL_USER || "";

export const submitContactForm = async (req, res) => {
  try {
    const { name, email, phone, subject, message, branch } = req.body;

    if (
      !name?.trim() ||
      !email?.trim() ||
      !subject?.trim() ||
      !message?.trim()
    ) {
      return res
        .status(400)
        .json({ message: "Name, email, subject and message are required." });
    }

    // Escape everything user-controlled before it goes into an HTML email —
    // these fields are attacker-controlled and land in the admin's inbox.
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone || "Not provided");
    const safeBranch = escapeHtml(branch || "Not specified");
    const safeSubject = escapeHtml(subject);
    // Keep the sender's line breaks: inside a <p> they'd otherwise collapse
    // into one paragraph. Escaping first means no user-supplied tags survive.
    const safeMessage = escapeHtml(message).replace(/\r?\n/g, "<br>");

    // ── Admin notification ───────────────────────────────────────────────────
    const adminHtml = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f9f9fb;border-radius:12px;">
        <div style="background:linear-gradient(135deg,#3F0C91,#700CEB);padding:28px 32px;border-radius:10px;margin-bottom:28px;">
          <h1 style="color:#fff;margin:0;font-size:20px;font-weight:900;">New Contact Enquiry</h1>
          <p style="color:rgba(255,255,255,0.65);margin:6px 0 0;font-size:13px;">Via kemchutahomesltd.com — ${safeBranch} enquiry</p>
        </div>
        <table style="width:100%;border-collapse:collapse;">
          ${[
            ["Name", safeName],
            ["Email", safeEmail],
            ["Phone", safePhone],
            ["Branch", safeBranch],
            ["Subject", safeSubject],
          ]
            .map(
              ([l, v]) => `
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:12px;color:#6b7280;font-weight:700;width:32%;text-transform:uppercase;letter-spacing:.05em;">${l}</td>
              <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;color:#0f0a1e;font-weight:600;">${v}</td>
            </tr>`,
            )
            .join("")}
        </table>
        <div style="margin-top:20px;padding:16px 20px;background:rgba(112,12,235,0.05);border-radius:10px;border-left:3px solid #700CEB;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#700CEB;text-transform:uppercase;letter-spacing:.08em;">Message</p>
          <p style="margin:0;font-size:15px;color:#262626;line-height:1.75;">${safeMessage}</p>
        </div>
        <div style="margin-top:20px;text-align:center;">
          <a href="mailto:${safeEmail}?subject=Re: ${encodeURIComponent(subject)}"
             style="display:inline-block;background:#700CEB;color:#fff;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;text-decoration:none;">
            Reply to ${safeName}
          </a>
        </div>
      </div>
    `;

    // ── Client auto-reply ────────────────────────────────────────────────────
    const clientHtml = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f9f9fb;border-radius:12px;">
        <div style="background:linear-gradient(135deg,#3F0C91,#700CEB);padding:36px 32px;border-radius:10px;margin-bottom:28px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;font-weight:900;text-transform:uppercase;letter-spacing:-0.03em;">Kemchuta Homes</h1>
          <span style="display:inline-block;background:rgba(255,255,255,0.18);color:#fff;font-size:11px;font-weight:700;padding:4px 14px;border-radius:20px;margin-top:10px;letter-spacing:1px;">MESSAGE RECEIVED</span>
        </div>
        <h2 style="font-size:20px;font-weight:800;color:#0f0a1e;margin-top:0;">Hi ${safeName}, we got your message! 👋</h2>
        <p style="color:#525252;font-size:15px;line-height:1.75;">
          Thank you for reaching out to Kemchuta Homes. We've received your enquiry about
          <strong>"${safeSubject}"</strong> and our team will get back to you within <strong>24 hours</strong>.
        </p>
        <div style="background:rgba(112,12,235,0.05);border-radius:10px;padding:16px 20px;margin:20px 0;border:1px solid rgba(112,12,235,0.12);">
          <p style="margin:0;font-size:13px;color:#700CEB;font-weight:700;">
            While you wait, explore our latest estate developments and investment opportunities on our website.
          </p>
        </div>
        <div style="text-align:center;margin:28px 0;">
          <a href="https://kemchutahomesltd.com/developments"
             style="display:inline-block;background:#700CEB;color:#fff;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;box-shadow:0 4px 14px rgba(112,12,235,0.3);">
            Explore Estates →
          </a>
        </div>
        <div style="border-top:1px solid #eee;padding-top:20px;text-align:center;">
          <p style="color:#9ca3af;font-size:13px;margin:0 0 4px;">Lagos HQ: +234 800 000 0001 &nbsp;|&nbsp; Asaba: +234 800 000 0003</p>
          <p style="color:#9ca3af;font-size:13px;margin:0;">info@kemchutahomesltd.com</p>
        </div>
        <div style="background:#171717;padding:20px;text-align:center;border-radius:0 0 10px 10px;margin:24px -32px -32px;">
          <p style="color:#a3a3a3;font-size:12px;margin:0;">© ${new Date().getFullYear()} Kemchuta Homes Ltd. All rights reserved.</p>
        </div>
      </div>
    `;

    // Fire both emails in parallel — fire-and-forget safe
    await Promise.allSettled([
      sendEmail({
        to: ADMIN_EMAIL(),
        subject: `Contact Enquiry: ${stripCrlf(subject)} — ${stripCrlf(name)} (${stripCrlf(branch) || "General"})`,
        html: adminHtml,
      }),
      sendEmail({
        to: email.trim(),
        subject: `We received your message — Kemchuta Homes`,
        html: clientHtml,
      }),
    ]);

    res.status(200).json({
      message: "Message sent successfully! We'll respond within 24 hours.",
    });
  } catch (err) {
    console.error("Contact form error:", err);
    res
      .status(500)
      .json({ message: "Failed to send message. Please try again." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// routes/contact.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Paste the content below into a separate file: routes/contact.routes.js
/*
import express from "express";
import { submitContactForm } from "../controllers/contact.controller.js";

const router = express.Router();

// POST /api/contact — public, no auth required
router.post("/", submitContactForm);

export default router;
*/

// ─────────────────────────────────────────────────────────────────────────────
// ADD TO server/index.js:
// ─────────────────────────────────────────────────────────────────────────────
/*
import contactRoutes from "./routes/contact.routes.js";
app.use("/api/contact", contactRoutes);
*/
