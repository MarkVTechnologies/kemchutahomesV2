/**
 * utils/followUp.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cron scheduler for all automated tasks.
 *
 * Jobs:
 *   1. 08:00 daily — Payment reminders (instalments, overdue, no deposit)
 *   2. 09:00 daily — Post-inspection follow-ups (3 days after, no subscription)
 *   3. 02:00 daily — Finalise pending commissions past clawback window
 *   4. 07:00 daily — Auto-mature Buy2Sell investments (maturityDate has passed)
 */

import { escapeHtml } from "./escapeHtml.js";
import cron from "node-cron";
import Inspection from "../models/inspection.model.js";
import { Buy2SellLead } from "../models/Buy2sell.model.js";
import {
  sendEmail,
  sendSMS,
  sendPostInspectionFollowUp,
} from "./notifications.js";
import { sendPaymentReminders } from "../controllers/subscription.controller.js";
import { finalisePendingCommissions } from "./commissionCalculator.js";
import { runOnce } from "./jobRunGuard.js";

const ADMIN_EMAIL = () =>
  process.env.ADMIN_EMAIL || "info@kemchutahomesltd.com";
const FRONTEND = () =>
  process.env.FRONTEND_URL || "https://kemchutahomesltd.com";

const fmtNGN = (n = 0) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 0,
  }).format(n);
const fmtDate = (d) =>
  d
    ? new Date(d).toLocaleDateString("en-NG", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "—";

const emailWrap = (content) => `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f3ff;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(112,12,235,0.1);">
  <div style="background:linear-gradient(135deg,#3F0C91,#700CEB);padding:32px;text-align:center;">
    <p style="color:rgba(255,255,255,0.75);font-size:12px;margin:0;letter-spacing:1px;text-transform:uppercase;">Kemchuta Homes Limited · Buy2Sell</p>
  </div>
  <div style="padding:36px;">${content}</div>
  <div style="background:#0f0a1e;padding:20px 36px;text-align:center;">
    <p style="color:#6b7280;font-size:11px;margin:0;">© ${new Date().getFullYear()} Kemchuta Homes Limited · info@kemchutahomesltd.com</p>
  </div>
</div></body></html>`;

// Job bodies keyed by their runOnce() name. Shared by startScheduler() (the
// long-lived worker) and scripts/runJob.js (one-shot runner for hosts where
// a system cron triggers each job instead, e.g. DirectAdmin/cPanel).
export const jobs = {
  // ── Job 1: Payment reminders — 8:00am daily ────────────────────────────
  "payment-reminders": async () => {
        console.log("📅 Cron: running payment reminders...");
        try {
          const count = await sendPaymentReminders();
          console.log(`📅 Cron: ${count} payment reminder(s) sent`);
        } catch (err) {
          console.error("📅 Cron payment reminders error:", err.message);
        }
  },

  // ── Job 2: Post-inspection follow-ups — 9:00am daily ──────────────────
  "post-inspection-followups": async () => {
      console.log("📅 Cron: running post-inspection follow-ups...");
      try {
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        const inspections = await Inspection.find({
          status: "completed",
          inspectionDate: { $lte: threeDaysAgo },
          followUpSent: { $ne: true },
        }).lean();

        for (const insp of inspections) {
          const firstName = insp.firstName || "Valued Client";
          const estateName = insp.estateName || "our estate";

          await sendEmail({
            to: insp.email,
            subject: `How was your site visit at ${estateName}?`,
            html: `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px;">
              <div style="background:linear-gradient(135deg,#3F0C91,#700CEB);padding:28px 32px;border-radius:10px;margin-bottom:24px;">
                <h1 style="color:#fff;margin:0;font-size:20px;font-weight:900;">How Was Your Visit?</h1>
              </div>
              <p style="color:#374151;font-size:15px;line-height:1.75;">
                Dear ${escapeHtml(firstName)},<br><br>
                We hope you enjoyed your site inspection at <strong>${escapeHtml(estateName)}</strong>.
                We would love to hear your thoughts and help you take the next step toward land ownership.<br><br>
                Our team is available to answer any questions and guide you through the subscription process.
              </p>
              <div style="text-align:center;margin:24px 0;">
                <a href="${FRONTEND()}"
                   style="background:#700CEB;color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;display:inline-block;">
                  Subscribe Now
                </a>
              </div>
              <p style="color:#374151;font-size:14px;">
                Call us: <strong>+234 800 000 0001</strong> (Lagos) · <strong>+234 800 000 0003</strong> (Asaba)
              </p>
            </div>`,
          }).catch(() => null);

          await Inspection.findByIdAndUpdate(insp._id, { followUpSent: true });
        }

        if (inspections.length > 0) {
          console.log(
            `📅 Cron: ${inspections.length} post-inspection follow-up(s) sent`,
          );
        }
      } catch (err) {
        console.error("📅 Cron post-inspection error:", err.message);
      }
  },

  // ── Job 3: Finalise commissions — 2:00am daily ────────────────────────
  "commission-finalise": async () => {
        try {
          await finalisePendingCommissions();
        } catch (err) {
          console.error("📅 Cron commission finalise error:", err.message);
        }
  },

  // ── Job 4: Auto-mature Buy2Sell investments — 7:00am daily ────────────
  // Checks all active investments whose maturityDate has passed,
  // marks them as "matured", sends client notification + admin alert.
  "buy2sell-maturity": async () => {
      console.log("📅 Cron: checking Buy2Sell maturities...");
      try {
        const now = new Date();

        const dueInvestments = await Buy2SellLead.find({
          status: "active",
          maturityDate: { $lte: now },
        }).lean();

        if (dueInvestments.length === 0) {
          console.log("📅 Cron: no Buy2Sell investments due for maturity");
          return;
        }

        for (const inv of dueInvestments) {
          // Mark as matured
          await Buy2SellLead.findByIdAndUpdate(inv._id, { status: "matured" });

          // ── Client notification ────────────────────────────────────────
          await sendEmail({
            to: inv.email,
            subject: `🎊 Your Buy2Sell Investment Has Matured — ${inv.referenceNumber}`,
            html: emailWrap(`
            <h2 style="color:#059669;font-size:22px;font-weight:900;margin:0 0 8px;">Your Investment Has Matured! 🎊</h2>
            <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
              Dear <strong>${escapeHtml(inv.fullName)}</strong>, congratulations!
              Your Buy2Sell investment has reached its maturity date of <strong>${fmtDate(inv.maturityDate)}</strong>.
            </p>
            <div style="background:#f9f6ff;border-radius:10px;padding:18px 20px;margin:20px 0;border-left:4px solid #700CEB;">
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Reference:</strong> ${inv.referenceNumber}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Principal:</strong> ${fmtNGN(inv.principalAmount)}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>ROI Earned:</strong> ${fmtNGN(inv.expectedROI || 0)}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Total Payout Due:</strong> <strong style="color:#059669;font-size:15px;">${fmtNGN(inv.expectedPayout || 0)}</strong></p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Maturity Date:</strong> ${fmtDate(inv.maturityDate)}</p>
            </div>
            <p style="font-size:13px;color:#374151;margin:0 0 16px;">
              Our team is processing your payout of <strong>${fmtNGN(inv.expectedPayout || 0)}</strong>.
              You will receive a confirmation email once payment has been sent, typically within <strong>14 working days</strong>.
            </p>
            <div style="text-align:center;margin:24px 0;">
              <a href="${FRONTEND()}/client/portal/investments"
                 style="display:inline-block;background:linear-gradient(135deg,#3F0C91,#700CEB);color:#fff;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">
                View My Dashboard
              </a>
            </div>
          `),
          }).catch((e) =>
            console.error(
              `Maturity email failed for ${inv.referenceNumber}:`,
              e.message,
            ),
          );

          // ── Admin notification ─────────────────────────────────────────
          await sendEmail({
            to: ADMIN_EMAIL(),
            subject: `⏰ Investment Matured — Action Required: ${inv.referenceNumber}`,
            html: emailWrap(`
            <h2 style="color:#0f0a1e;font-size:18px;font-weight:900;margin:0 0 16px;">Investment Matured — Payout Required</h2>
            <p style="color:#374151;font-size:14px;margin:0 0 16px;">
              The following Buy2Sell investment has automatically matured. Please process the payout within 14 working days.
            </p>
            <div style="background:#f9f6ff;border-radius:10px;padding:18px 20px;margin:20px 0;border-left:4px solid #700CEB;">
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Reference:</strong> ${inv.referenceNumber}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Investor:</strong> ${escapeHtml(inv.fullName)}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Email:</strong> ${inv.email}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Phone:</strong> ${inv.phone}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Duration:</strong> ${inv.duration}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>Principal:</strong> ${fmtNGN(inv.principalAmount)}</p>
              <p style="margin:5px 0;font-size:13px;color:#374151;"><strong>ROI:</strong> ${fmtNGN(inv.expectedROI || 0)} (${inv.roiPercent}%)</p>
              <p style="margin:5px 0;font-size:15px;font-weight:900;color:#059669;"><strong>Payout Due: ${fmtNGN(inv.expectedPayout || 0)}</strong></p>
            </div>
            <div style="text-align:center;margin:24px 0;">
              <a href="${FRONTEND()}/dashboard/buy2sell"
                 style="display:inline-block;background:linear-gradient(135deg,#3F0C91,#700CEB);color:#fff;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">
                Process Payout in Dashboard →
              </a>
            </div>
          `),
          }).catch((e) =>
            console.error(`Admin maturity email failed:`, e.message),
          );

          console.log(
            `📅 Cron: matured ${inv.referenceNumber} — ${inv.fullName}`,
          );
          // SMS to client
          sendSMS(
            inv.phone,
            `🎊 Hi ${inv.fullName.split(" ")[0]}, your Buy2Sell investment (Ref: ${inv.referenceNumber}) has MATURED! Payout of NGN ${(inv.expectedPayout || 0).toLocaleString("en-NG")} is being processed. - KHL`,
          ).catch(() => null);
        }

        console.log(
          `📅 Cron: ${dueInvestments.length} investment(s) auto-matured`,
        );
      } catch (err) {
        console.error("📅 Cron Buy2Sell maturity error:", err.message);
      }
  },
};

export function startScheduler() {
  const schedule = (expression, jobName) =>
    cron.schedule(expression, () => runOnce(jobName, jobs[jobName]), {
      timezone: "Africa/Lagos",
    });

  schedule("0 8 * * *", "payment-reminders");
  schedule("0 9 * * *", "post-inspection-followups");
  schedule("0 2 * * *", "commission-finalise");
  schedule("0 7 * * *", "buy2sell-maturity");

  console.log("📅 Follow-up scheduler started");
}
