import { isValidObjectId } from "mongoose";
import { ROISettings, Buy2SellLead } from "../models/Buy2sell.model.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { triggerRevalidate } from "../utils/revalidate.js";
import { invalidateChatPromptCache } from "../utils/chatPromptCache.js";
import { getCached, invalidateCache } from "../utils/dataCache.js";

const ROI_CACHE_KEY = "roi-settings";
const ROI_TTL_MS = 5 * 60 * 1000; // PRD FR-3: same 5 min window as the chat prompt cache
import Client from "../models/client.model.js";
import {
  generateInvestmentCertificate,
  generateInvestmentAgreement,
  generatePayoutConfirmation,
} from "../utils/pdfGenerator.js";
import { sendEmail, sendSMS } from "../utils/notifications.js";
import { getActiveBankAccounts } from "./Bankaccount.controller.js";
import { calculateBuy2SellCommissions } from "../utils/commissionCalculator.js";
import { parsePagination } from "../utils/pagination.js";
import { userHasPermission } from "../middlewares/authMiddleware.js";

// ── :id guard ────────────────────────────────────────────────────────────────
// Mirrors estate.controller.js's rejectedInvalidId — without it, a malformed
// id reaches findById/findByIdAndUpdate, throws a CastError, and gets reported
// as a generic 500 for what is plainly bad client input. Returns true when it
// has already sent the response.
const rejectedInvalidId = (req, res) => {
  if (isValidObjectId(req.params.id)) return false;
  res.status(400).json({ message: "Invalid investment ID" });
  return true;
};

const ADMIN_EMAIL = () =>
  process.env.ADMIN_EMAIL || "info@kemchutahomesltd.com";
const FRONTEND = () =>
  process.env.FRONTEND_URL || "https://kemchutahomesltd.com";
const pdfB64 = (buf) => buf.toString("base64");
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

// ── Maturity date — each month = exactly 30 days ──────────────────────────────
function calcMaturityDate(startDate, duration) {
  const d = new Date(startDate);
  const days =
    duration === "6 Months" ? 180 : duration === "12 Months" ? 360 : 540;
  d.setDate(d.getDate() + days);
  return d;
}

// ── Reference number ──────────────────────────────────────────────────────────
async function genRef() {
  const year = new Date().getFullYear();
  const count = await Buy2SellLead.countDocuments();
  return `KHL-B2S-${year}-${String(count + 1).padStart(5, "0")}`;
}

// Reference numbers are derived from a document count with no atomic lock, so
// two submissions arriving close together can compute the same value and
// collide against the unique referenceNumber index (same issue fixed in
// subscription.controller.js). Retries with a freshly generated ref rather
// than dropping the investor's submission with a raw duplicate-key error.
async function createLeadWithUniqueRef(body, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const referenceNumber = await genRef();
    try {
      return await Buy2SellLead.create({ ...body, referenceNumber });
    } catch (err) {
      const isDupRef = err.code === 11000 && err.keyPattern?.referenceNumber;
      if (!isDupRef || i === attempts - 1) throw err;
    }
  }
}

// ── Email wrapper ─────────────────────────────────────────────────────────────
const wrap = (content) => `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f3ff;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(112,12,235,0.1);">
  <div style="background:linear-gradient(135deg,#3F0C91,#700CEB);padding:36px;text-align:center;">
    <p style="color:rgba(255,255,255,0.7);font-size:12px;margin:0;letter-spacing:1px;text-transform:uppercase;">Kemchuta Homes · Buy2Sell</p>
  </div>
  <div style="padding:36px;">${content}</div>
  <div style="background:#0f0a1e;padding:20px 36px;text-align:center;">
    <p style="color:#6b7280;font-size:11px;margin:0;">© ${new Date().getFullYear()} Kemchuta Homes Limited · info@kemchutahomesltd.com</p>
  </div>
</div></body></html>`;

const infoBox = (rows) =>
  `<div style="background:#f9f6ff;border-radius:10px;padding:18px 20px;margin:20px 0;border-left:4px solid #700CEB;">
    ${rows.map(([l, v]) => `<p style="margin:5px 0;font-size:13px;color:#374151;"><strong>${l}:</strong> ${escapeHtml(v)}</p>`).join("")}
  </div>`;

// Mirrors subscription.controller.js's bankBox — same fallback, field set,
// and escaping, so a customer who touches both products (a Buy2Sell investor
// who is also a land subscriber) sees consistent payment instructions.
const bankBox = (ref, accounts = []) => {
  if (!accounts.length) {
    return `<div style="background:#f0fdf4;border-radius:10px;padding:18px 20px;margin:20px 0;border-left:4px solid #059669;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#059669;">Payment Details</p>
      <p style="margin:4px 0;font-size:13px;color:#374151;">Please contact us for bank payment details: <strong>info@kemchutahomesltd.com</strong></p>
      <p style="margin:4px 0;font-size:13px;color:#374151;"><strong>Payment Reference:</strong> <strong style="color:#700CEB;">${ref}</strong></p>
    </div>`;
  }
  const rows = accounts
    .map(
      (a) => `
    <div style="margin-bottom:${accounts.length > 1 ? "14px" : "0"};${accounts.length > 1 ? "padding-bottom:14px;border-bottom:1px solid #d1fae5;" : ""}">
      ${accounts.length > 1 ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#059669;text-transform:uppercase;letter-spacing:0.05em;">${a.isPrimary ? "★ Primary Account" : "Additional Account"}</p>` : ""}
      ${[
        ["Bank", a.bankName],
        ["Account Name", a.accountName],
        ["Account Number", a.accountNumber],
        ...(a.sortCode ? [["Sort Code", a.sortCode]] : []),
      ]
        .map(
          ([l, v]) =>
            `<p style="margin:3px 0;font-size:13px;color:#374151;"><strong>${l}:</strong> ${escapeHtml(v)}</p>`,
        )
        .join("")}
      ${a.note ? `<p style="margin:4px 0;font-size:11px;color:#6b7280;font-style:italic;">${escapeHtml(a.note)}</p>` : ""}
    </div>`,
    )
    .join("");

  return `<div style="background:#f0fdf4;border-radius:10px;padding:18px 20px;margin:20px 0;border-left:4px solid #059669;">
    <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#059669;">Payment Details</p>
    ${rows}
    <p style="margin:10px 0 4px;font-size:13px;color:#374151;"><strong>Payment Reference:</strong> <strong style="color:#700CEB;">${ref}</strong></p>
    <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">⚠ Always quote your reference on every transfer. Send proof to info@kemchutahomesltd.com</p>
  </div>`;
};

const btn = (text, url) =>
  `<div style="text-align:center;margin:24px 0;">
    <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#3F0C91,#700CEB);color:#fff;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">${text}</a>
  </div>`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/buy2sell/roi  (public)
// ─────────────────────────────────────────────────────────────────────────────
async function loadROISettings() {
  let s = await ROISettings.findOne({ singleton: "global" }).lean();
  if (!s) s = (await ROISettings.create({ singleton: "global" })).toObject();
  // Back-compat: if roiPercent1Year exists rename to 12Months
  if (s.roiPercent1Year !== undefined && s.roiPercent12Months === undefined) {
    s.roiPercent12Months = s.roiPercent1Year;
  }
  return s;
}

export const getROISettings = async (req, res) => {
  try {
    const s = await getCached(ROI_CACHE_KEY, ROI_TTL_MS, loadROISettings);
    res.set("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=600");
    res.json(s);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch ROI settings" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/buy2sell/roi  (admin)
// ─────────────────────────────────────────────────────────────────────────────
export const updateROISettings = async (req, res) => {
  try {
    const {
      roiPercent6Months,
      roiPercent12Months,
      roiPercent18Months,
      minInvestment,
      maxInvestment,
      description,
    } = req.body;
    const update = { updatedBy: req.user?.email || "admin" };
    if (roiPercent6Months !== undefined)
      update.roiPercent6Months = Number(roiPercent6Months);
    if (roiPercent12Months !== undefined)
      update.roiPercent12Months = Number(roiPercent12Months);
    if (roiPercent18Months !== undefined)
      update.roiPercent18Months = Number(roiPercent18Months);
    if (minInvestment !== undefined)
      update.minInvestment = Number(minInvestment);
    if (maxInvestment !== undefined)
      update.maxInvestment = Number(maxInvestment);
    if (description !== undefined) update.description = description;
    const settings = await ROISettings.findOneAndUpdate(
      { singleton: "global" },
      update,
      { new: true, upsert: true },
    );
    triggerRevalidate(["roi-settings"]);
    invalidateChatPromptCache();
    invalidateCache(ROI_CACHE_KEY);
    res.json({ message: "ROI settings updated", settings });
  } catch (err) {
    res.status(500).json({ message: "Failed to update ROI settings" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/buy2sell/leads  — multi-step form submission
// Body includes KYC + investment details. ROI is snapshotted at this moment.
// ─────────────────────────────────────────────────────────────────────────────
export const submitBuy2SellLead = async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      duration,
      principalAmount,
      dateOfBirth,
      gender,
      nationality,
      address,
      city,
      state,
      idType,
      idNumber,
      idDocumentUrl,
      realtorId,
    } = req.body;

    if (!fullName?.trim() || !email?.trim() || !phone?.trim())
      return res
        .status(400)
        .json({ message: "Full name, email and phone are required" });
    if (!principalAmount || Number(principalAmount) <= 0)
      return res.status(400).json({ message: "Investment amount is required" });
    if (!["6 Months", "12 Months", "18 Months"].includes(duration))
      return res.status(400).json({ message: "Invalid duration" });

    // Snapshot ROI at submission time
    const roi = await ROISettings.findOne({ singleton: "global" }).lean();
    const roiMap = {
      "6 Months": roi?.roiPercent6Months ?? 22,
      "12 Months": roi?.roiPercent12Months ?? 48,
      "18 Months": roi?.roiPercent18Months ?? 75,
    };
    const roiPercent = roiMap[duration];

    // minInvestment/maxInvestment are admin-configurable in ROI Settings but
    // were never actually checked anywhere — enforce them here so they're not
    // purely decorative.
    const principal = Number(principalAmount);
    const minInvestment = roi?.minInvestment ?? 0;
    const maxInvestment = roi?.maxInvestment ?? Infinity;
    if (principal < minInvestment || principal > maxInvestment) {
      return res.status(400).json({
        message: `Investment amount must be between ${fmtNGN(minInvestment)} and ${fmtNGN(maxInvestment)}.`,
      });
    }

    const banks = await getActiveBankAccounts();

    // ── Check if a client account already exists for this email ──────────
    const existingClient = await Client.findOne({
      email: email.trim().toLowerCase(),
    })
      .select("_id firstName")
      .lean();

    // Expected ROI/payout are pure percentage math off the locked-in rate —
    // computed and stored now (not left at the schema's 0 default until
    // recordPayment activates the investment) so a Certificate/Agreement
    // downloaded before activation shows the same numbers the investor was
    // actually emailed, instead of ₦0.
    const roi_amount = Math.round((principal * roiPercent) / 100);
    const total_payout = principal + roi_amount;

    const lead = await createLeadWithUniqueRef({
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim(),
      duration,
      principalAmount: principal,
      roiPercent, // ← snapshotted, never changes
      expectedROI: roi_amount,
      expectedPayout: total_payout,
      clientId: existingClient?._id || null, // ← link if account exists
      realtorId: realtorId || null,
      dateOfBirth: dateOfBirth || null,
      gender: gender || "",
      nationality: nationality || "Nigerian",
      address: address || "",
      city: city || "",
      state: state || "",
      idType: idType || "",
      idNumber: idNumber || "",
    });
    const referenceNumber = lead.referenceNumber;

    // ── Generate invoice PDF and send congratulatory email ────────────────
    try {
      // Build a temporary "lead" object with enough data for generateInvestmentAgreement
      const tempLead = {
        ...lead.toObject(),
        expectedROI: roi_amount,
        expectedPayout: total_payout,
        investmentDate: new Date(),
        maturityDate: calcMaturityDate(new Date(), duration),
      };
      const [agreementBuf] = await Promise.all([
        generateInvestmentAgreement(tempLead),
      ]);

      await sendEmail({
        to: lead.email,
        subject: `🎉 Buy2Sell Investment Received — ${referenceNumber}`,
        attachments: [
          {
            filename: `Buy2Sell-Invoice-${referenceNumber}.pdf`,
            content: pdfB64(agreementBuf),
            contentType: "application/pdf",
          },
        ],
        html: wrap(`
          <h2 style="color:#0f0a1e;font-size:22px;font-weight:900;margin:0 0 8px;">Congratulations, ${escapeHtml(lead.fullName)}! 🎉</h2>
          <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
            Your Buy2Sell investment application has been received. Here are your investment details:
          </p>
          ${infoBox([
            ["Reference", referenceNumber],
            ["Investment Amount", fmtNGN(lead.principalAmount)],
            ["Duration", duration],
            ["ROI Rate", `${roiPercent}% (locked in)`],
            ["Expected ROI", fmtNGN(roi_amount)],
            ["Expected Total Payout", fmtNGN(total_payout)],
            [
              "Estimated Maturity",
              fmtDate(calcMaturityDate(new Date(), duration)),
            ],
          ])}
          ${bankBox(referenceNumber, banks)}
          <p style="font-size:13px;color:#374151;margin:16px 0;">
            Please make your investment payment and quote reference <strong style="color:#700CEB;">${referenceNumber}</strong> on the transfer.
            Your ROI rate of <strong>${roiPercent}%</strong> is locked in at today's rate and will not change.
          </p>
          <p style="font-size:13px;color:#374151;">Your <strong>Investment Agreement</strong> is attached for your records.</p>
          ${btn("View My Portal", `${FRONTEND()}/client/portal`)}
        `),
      });
    } catch (emailErr) {
      console.error("Buy2Sell submission email failed:", emailErr.message);
    }

    // Admin notification
    sendEmail({
      to: ADMIN_EMAIL(),
      subject: `New Buy2Sell Investment — ${lead.fullName} [${referenceNumber}]`,
      html: wrap(`
        <h2 style="color:#0f0a1e;font-size:18px;font-weight:900;margin:0 0 16px;">New Buy2Sell Investment</h2>
        ${infoBox([
          ["Reference", referenceNumber],
          ["Investor", lead.fullName],
          ["Email", lead.email],
          ["Phone", lead.phone],
          ["Amount", fmtNGN(lead.principalAmount)],
          ["Duration", duration],
          ["ROI Rate", `${roiPercent}%`],
        ])}
      `),
    }).catch(() => null);

    // SMS to investor — investment received
    sendSMS(
      lead.phone,
      `Hi ${lead.fullName.split(" ")[0]}, your Buy2Sell investment of NGN ${lead.principalAmount.toLocaleString("en-NG")} for ${lead.duration} has been received (Ref: ${referenceNumber}). ROI: ${roiPercent}%. Check email for agreement. - KHL`,
    ).catch(() => null);

    // Save investment agreement doc record
    await Buy2SellLead.findByIdAndUpdate(lead._id, {
      $push: {
        documents: {
          type: "agreement",
          label: "Investment Agreement",
          generatedAt: new Date(),
        },
      },
    });

    res.status(201).json({
      message:
        "Investment application submitted! Check your email for confirmation.",
      clientExists: !!existingClient, // ← tells frontend whether to show login or register
      lead: {
        _id: lead._id,
        referenceNumber,
        fullName: lead.fullName,
        email: lead.email,
        duration,
        principalAmount: lead.principalAmount,
        roiPercent,
        expectedROI: roi_amount,
        expectedPayout: total_payout,
        status: "pending",
      },
    });
  } catch (err) {
    console.error("submitBuy2SellLead:", err);
    res.status(500).json({ message: "Failed to submit investment." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/buy2sell/leads  (admin)
// ─────────────────────────────────────────────────────────────────────────────
export const getAllLeads = async (req, res) => {
  try {
    const { status, search } = req.query;
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      const safeSearch = escapeRegex(String(search).slice(0, 100));
      filter.$or = [
        { fullName: { $regex: safeSearch, $options: "i" } },
        { email: { $regex: safeSearch, $options: "i" } },
        { referenceNumber: { $regex: safeSearch, $options: "i" } },
      ];
    }
    const [leads, total] = await Promise.all([
      Buy2SellLead.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Buy2SellLead.countDocuments(filter),
    ]);
    // Attach virtuals
    leads.forEach((l) => {
      if (l.investmentDate && l.maturityDate) {
        const total_ms = new Date(l.maturityDate) - new Date(l.investmentDate);
        const elapsed = Math.min(
          new Date() - new Date(l.investmentDate),
          total_ms,
        );
        l.maturityProgressPercent = Math.min(
          100,
          Math.max(0, Math.round((elapsed / total_ms) * 100)),
        );
        l.daysRemaining = Math.max(
          0,
          Math.ceil((new Date(l.maturityDate) - new Date()) / 86400000),
        );
      } else {
        l.maturityProgressPercent = 0;
        l.daysRemaining = null;
      }
      l.balanceOutstanding = Math.max(
        0,
        (l.principalAmount || 0) - (l.amountPaid || 0),
      );
    });
    res.json({
      leads,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch leads" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/buy2sell/leads/:id  (admin)
// ─────────────────────────────────────────────────────────────────────────────
export const getLeadById = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const lead = await Buy2SellLead.findById(req.params.id).populate(
      "realtorId",
      "firstName lastName referralCode",
    );
    if (!lead) return res.status(404).json({ message: "Investment not found" });
    res.json(lead); // virtuals included via toJSON
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch investment" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/buy2sell/my  (client)
// ─────────────────────────────────────────────────────────────────────────────
export const getMyInvestments = async (req, res) => {
  try {
    // Match by email OR clientId — covers investments made before account creation
    const query = {
      $or: [{ email: req.user.email }, { clientId: req.user.id }],
    };
    const leads = await Buy2SellLead.find(query).sort({ createdAt: -1 });
    res.json(leads);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch investments." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/buy2sell/leads/:id/record-payment  (admin — Step 1: log payment)
// ─────────────────────────────────────────────────────────────────────────────
const FINISHED_STATUSES = ["matured", "paid_out", "closed"];

export const recordPayment = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { amount, method, reference, note, paidAt } = req.body;
    if (!amount || Number(amount) <= 0)
      return res.status(400).json({ message: "Valid amount required" });

    // Without this, a payment logged against a matured/paid-out/closed
    // investment falls straight into the "balance <= 0 → activate" branch
    // below and re-fires the activation email, certificate, and SMS for an
    // investment that has already progressed past that stage.
    const existing = await Buy2SellLead.findById(req.params.id).select("status");
    if (!existing)
      return res.status(404).json({ message: "Investment not found" });
    if (FINISHED_STATUSES.includes(existing.status)) {
      return res.status(400).json({
        message: `Cannot record a payment on a ${existing.status} investment.`,
      });
    }

    const lead = await Buy2SellLead.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          payments: {
            amount: Number(amount),
            paidAt: paidAt ? new Date(paidAt) : new Date(),
            method: method || "Bank Transfer",
            reference: reference || "",
            note: note || "",
            type: "principal",
            confirmedBy: req.user?.email || "admin",
          },
        },
        $inc: { amountPaid: Number(amount) },
      },
      { new: true },
    );
    if (!lead) return res.status(404).json({ message: "Investment not found" });

    // Auto-advance status based on payment
    const balance = lead.principalAmount - lead.amountPaid;
    let newStatus = lead.status;
    if (balance <= 0 && lead.status !== "active") {
      // Full principal received → activate investment
      newStatus = "active";
    } else if (lead.amountPaid > 0 && lead.status === "pending") {
      newStatus = "partial_paid";
    }

    const update = { status: newStatus };
    // Extra payments on an active investment must not re-send its activation.
    const becameActive = newStatus === "active" && lead.status !== "active";

    // If fully paid, set investmentDate and maturityDate
    if (newStatus === "active" && !lead.investmentDate) {
      const invDate = new Date();
      update.investmentDate = invDate;
      update.maturityDate = calcMaturityDate(invDate, lead.duration);
      update.expectedROI = Math.round(
        (lead.principalAmount * lead.roiPercent) / 100,
      );
      update.expectedPayout =
        lead.principalAmount +
        Math.round((lead.principalAmount * lead.roiPercent) / 100);
    }

    const updatedLead = await Buy2SellLead.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true },
    );

    // Fires only on the transition into "active" (full principal received) —
    // Buy2Sell has no partial-payment commission risk the way an instalment
    // Subscription does, since activation already requires the full amount.
    // Placed after the lead write (not before) so a commission can never be
    // created for a payment that failed to persist.
    if (becameActive && updatedLead.realtorId) {
      calculateBuy2SellCommissions(updatedLead._id, updatedLead.realtorId).catch(
        (e) => console.error("Buy2Sell commission calc error:", e.message),
      );
    }

    const banks = await getActiveBankAccounts();

    // ── Send email based on status ─────────────────────────────────────────
    if (becameActive) {
      // Full payment confirmed — generate certificate + send activation email
      try {
        const certBuf = await generateInvestmentCertificate(updatedLead);
        const ref = updatedLead.referenceNumber;
        await sendEmail({
          to: updatedLead.email,
          subject: `✅ Investment Activated — ${ref}`,
          attachments: [
            {
              filename: `Investment-Certificate-${ref}.pdf`,
              content: pdfB64(certBuf),
              contentType: "application/pdf",
            },
          ],
          html: wrap(`
            <h2 style="color:#059669;font-size:22px;font-weight:900;margin:0 0 8px;">Investment Activated! ✅</h2>
            <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
              Dear <strong>${escapeHtml(updatedLead.fullName)}</strong>, your investment of <strong>${fmtNGN(updatedLead.principalAmount)}</strong>
              has been fully confirmed and your investment is now <strong>active</strong>.
            </p>
            ${infoBox([
              ["Reference", ref],
              ["Principal", fmtNGN(updatedLead.principalAmount)],
              ["ROI Rate", `${updatedLead.roiPercent}% (locked in)`],
              ["Expected ROI", fmtNGN(updatedLead.expectedROI)],
              ["Total Payout", fmtNGN(updatedLead.expectedPayout)],
              ["Investment Date", fmtDate(updatedLead.investmentDate)],
              ["Maturity Date", fmtDate(updatedLead.maturityDate)],
            ])}
            <p style="font-size:13px;color:#374151;">Your <strong>Investment Certificate</strong> is attached.</p>
            ${btn("View My Dashboard", `${FRONTEND()}/client/portal`)}
          `),
        });
        await Buy2SellLead.findByIdAndUpdate(updatedLead._id, {
          $push: {
            documents: {
              type: "certificate",
              label: "Investment Certificate",
              generatedAt: new Date(),
            },
          },
        });
        // SMS — investment activated
        sendSMS(
          updatedLead.phone,
          `Congratulations ${updatedLead.fullName.split(" ")[0]}! Your Buy2Sell investment (Ref: ${updatedLead.referenceNumber}) is ACTIVE. Maturity: ${updatedLead.maturityDate ? new Date(updatedLead.maturityDate).toLocaleDateString("en-NG") : "TBC"}. ROI: ${updatedLead.roiPercent}%. - KHL`,
        ).catch(() => null);
      } catch (e) {
        console.error("Activation email failed:", e.message);
      }
    } else if (newStatus === "partial_paid") {
      const ref = updatedLead.referenceNumber;
      const balance2 = updatedLead.principalAmount - updatedLead.amountPaid;
      // SMS — partial payment received
      sendSMS(
        updatedLead.phone,
        `Hi ${updatedLead.fullName.split(" ")[0]}, payment of NGN ${Number(amount).toLocaleString("en-NG")} received for your Buy2Sell investment (Ref: ${ref}). Balance: NGN ${balance2.toLocaleString("en-NG")}. - KHL`,
      ).catch(() => null);
      await sendEmail({
        to: updatedLead.email,
        subject: `Payment Received — Buy2Sell [${ref}]`,
        html: wrap(`
          <h2 style="color:#700CEB;font-size:22px;font-weight:900;margin:0 0 8px;">Payment Received</h2>
          <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
            Dear <strong>${escapeHtml(updatedLead.fullName)}</strong>, we have received a payment of
            <strong>${fmtNGN(Number(amount))}</strong> toward your Buy2Sell investment.
          </p>
          ${infoBox([
            ["Reference", ref],
            ["Amount Paid", fmtNGN(updatedLead.amountPaid)],
            ["Balance Due", fmtNGN(balance2)],
            ["Status", "Partial Payment — balance outstanding"],
          ])}
          ${bankBox(ref, banks)}
          <p style="font-size:13px;color:#374151;">Please pay the remaining balance to activate your investment.</p>
        `),
      }).catch(() => null);
    }

    res.json({ message: "Payment recorded.", lead: updatedLead });
  } catch (err) {
    console.error("recordPayment:", err);
    res.status(500).json({ message: "Failed to record payment." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/buy2sell/leads/:id/mature  (admin — mark investment matured)
// ─────────────────────────────────────────────────────────────────────────────
export const markMatured = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    // Only from active: marking a paid-out investment matured would reopen it
    // for a second payout.
    const lead = await Buy2SellLead.findOneAndUpdate(
      { _id: req.params.id, status: "active" },
      { status: "matured" },
      { new: true },
    );
    if (!lead) {
      const exists = await Buy2SellLead.exists({ _id: req.params.id });
      return exists
        ? res.status(400).json({ message: "Only an active investment can be marked matured." })
        : res.status(404).json({ message: "Investment not found" });
    }

    await sendEmail({
      to: lead.email,
      subject: `🎊 Investment Matured — ${lead.referenceNumber}`,
      html: wrap(`
        <h2 style="color:#059669;font-size:22px;font-weight:900;margin:0 0 8px;">Your Investment Has Matured! 🎊</h2>
        <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
          Dear <strong>${escapeHtml(lead.fullName)}</strong>, congratulations! Your Buy2Sell investment has reached maturity.
          Your payout of <strong>${fmtNGN(lead.expectedPayout)}</strong> is being processed.
        </p>
        ${infoBox([
          ["Reference", lead.referenceNumber],
          ["Principal", fmtNGN(lead.principalAmount)],
          ["ROI Earned", fmtNGN(lead.expectedROI)],
          ["Total Payout", fmtNGN(lead.expectedPayout)],
          ["Maturity Date", fmtDate(lead.maturityDate)],
        ])}
        <p style="font-size:13px;color:#374151;">Our team will process your payout shortly. We will notify you once payment is sent.</p>
        ${btn("View My Dashboard", `${FRONTEND()}/client/portal`)}
      `),
    }).catch(() => null);

    // SMS — investment matured
    sendSMS(
      lead.phone,
      `🎊 Hi ${lead.fullName.split(" ")[0]}, your Buy2Sell investment (Ref: ${lead.referenceNumber}) has MATURED! Payout of NGN ${(lead.expectedPayout || 0).toLocaleString("en-NG")} is being processed. - KHL`,
    ).catch(() => null);

    res.json({ message: "Investment marked as matured.", lead });
  } catch (err) {
    res.status(500).json({ message: "Failed to mark matured." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/buy2sell/leads/:id/process-payout  (admin)
// ─────────────────────────────────────────────────────────────────────────────
export const processPayout = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { actualPayout, payoutReference } = req.body;
    const lead = await Buy2SellLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Investment not found" });

    const payout = actualPayout || lead.expectedPayout;
    // The status filter makes this atomic: of two simultaneous requests, only
    // one can move the investment out of "matured" and record a payout.
    const updated = await Buy2SellLead.findOneAndUpdate(
      { _id: lead._id, status: "matured" },
      {
        actualPayout: payout,
        payoutDate: new Date(),
        status: "paid_out",
        $push: {
          payments: {
            amount: payout,
            paidAt: new Date(),
            method: req.body.method || "Bank Transfer",
            reference: payoutReference || "",
            type: "payout",
            confirmedBy: req.user?.email || "admin",
          },
        },
      },
      { new: true },
    );
    if (!updated) {
      return res.status(400).json({
        message: "Only a matured investment that hasn't been paid out can be paid.",
      });
    }

    try {
      const confirmBuf = await generatePayoutConfirmation(updated);
      await sendEmail({
        to: updated.email,
        subject: `🎉 Payout Sent — Buy2Sell [${updated.referenceNumber}]`,
        attachments: [
          {
            filename: `Payout-${updated.referenceNumber}.pdf`,
            content: pdfB64(confirmBuf),
            contentType: "application/pdf",
          },
        ],
        html: wrap(`
          <h2 style="color:#059669;font-size:22px;font-weight:900;margin:0 0 8px;">Payout Sent! 🎉</h2>
          <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
            Dear <strong>${escapeHtml(updated.fullName)}</strong>, your Buy2Sell investment payout of
            <strong>${fmtNGN(payout)}</strong> has been processed and sent!
          </p>
          ${infoBox([
            ["Reference", updated.referenceNumber],
            ["Principal", fmtNGN(updated.principalAmount)],
            ["ROI Earned", fmtNGN(updated.expectedROI)],
            ["Total Payout", fmtNGN(payout)],
            ["Payout Date", fmtDate(new Date())],
          ])}
          <p style="font-size:13px;color:#374151;">Thank you for investing with Kemchuta Homes. We hope to serve you again!</p>
          ${btn("View My Dashboard", `${FRONTEND()}/client/portal`)}
        `),
      });
      await Buy2SellLead.findByIdAndUpdate(updated._id, {
        $push: {
          documents: {
            type: "payout_confirmation",
            label: "Payout Confirmation",
            generatedAt: new Date(),
          },
        },
      });
      // SMS — payout sent
      sendSMS(
        updated.phone,
        `Hi ${updated.fullName.split(" ")[0]}, your Buy2Sell payout of NGN ${Number(payout || 0).toLocaleString("en-NG")} (Ref: ${updated.referenceNumber}) has been SENT. Thank you for investing with Kemchuta Homes! - KHL`,
      ).catch(() => null);
    } catch (e) {
      console.error("Payout email failed:", e.message);
    }

    res.json({ message: "Payout processed.", lead: updated });
  } catch (err) {
    res.status(500).json({ message: "Failed to process payout." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/buy2sell/leads/:id/documents/:docType  (admin + client)
// ─────────────────────────────────────────────────────────────────────────────
export const downloadDocument = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const lead = await Buy2SellLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Investment not found" });

    // protectAdminOrClient only checks the token is valid, not that a
    // client-role caller owns this particular investment — without this, any
    // logged-in client could download another investor's certificate,
    // agreement, or payout confirmation (all contain PII + financial data) by
    // guessing/enumerating lead IDs. Mirrors the same fix in
    // subscription.controller.js's downloadDocument. Ownership matches
    // getMyInvestments' own definition: by email or by linked clientId.
    if (
      req.user?.role === "client" &&
      lead.email?.toLowerCase() !== req.user.email?.toLowerCase() &&
      String(lead.clientId || "") !== String(req.user.id || "")
    ) {
      return res.status(403).json({ message: "Access denied." });
    }
    if (req.user?.role !== "client" && !userHasPermission(req.user, "buy2sell")) {
      return res
        .status(403)
        .json({ message: "You do not have permission to access this section." });
    }

    const { docType } = req.params;

    // An investor must not be able to pull a certificate before the money is
    // in, or a payout confirmation before the payout.
    const availableFrom = {
      certificate: ["active", "matured", "paid_out", "closed"],
      payout_confirmation: ["paid_out", "closed"],
    };
    if (req.user?.role === "client" && availableFrom[docType]?.includes(lead.status) === false) {
      return res.status(404).json({ message: "Document not available." });
    }

    let buf;
    if (docType === "certificate")
      buf = await generateInvestmentCertificate(lead);
    else if (docType === "agreement")
      buf = await generateInvestmentAgreement(lead);
    else if (docType === "payout_confirmation")
      buf = await generatePayoutConfirmation(lead);
    else return res.status(400).json({ message: "Invalid document type" });

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${docType}-${lead.referenceNumber}.pdf"`,
      "Content-Length": buf.length,
    });
    res.end(buf);
  } catch (err) {
    res.status(500).json({ message: "Failed to generate document." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/buy2sell/leads/:id/status  (admin — internal notes only)
//
// Every real B2S status transition already has a dedicated endpoint with the
// correct side effects: recordPayment (→ partial_paid/active), markMatured
// (→ matured), processPayout (→ paid_out). Unlike Subscriptions' pending/
// confirmed/rejected, there is no B2S status that is a pure admin decision
// independent of money movement — so unlike that page, this endpoint doesn't
// get a restricted-but-still-editable status subset, it drops status editing
// entirely. Letting it accept an arbitrary status let an admin mark an
// investment "paid_out" with no payout on record, or "active" with no
// principal ever received.
// ─────────────────────────────────────────────────────────────────────────────
export const updateLeadStatus = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { notes } = req.body;
    const lead = await Buy2SellLead.findByIdAndUpdate(
      req.params.id,
      { ...(notes !== undefined && { notes }) },
      { new: true },
    );
    if (!lead) return res.status(404).json({ message: "Investment not found" });
    res.json({ message: "Investment updated", lead });
  } catch (err) {
    res.status(500).json({ message: "Failed to update investment" });
  }
};
