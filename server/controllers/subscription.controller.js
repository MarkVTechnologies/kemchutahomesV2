import { isValidObjectId } from "mongoose";
import Subscription, { STATUSES } from "../models/Subscription.model.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import {
  generateAcknowledgement,
  generateContractOfSale,
  generatePaymentInvoice,
  generateInstallmentSchedule,
  generateReceipt,
  generateAllocationLetter,
  generateDeedOfAssignment,
} from "../utils/pdfGenerator.js";
import { sendEmail, sendSMS } from "../utils/notifications.js";
import {
  calculateCommissions,
  clawbackCommissions,
} from "../utils/commissionCalculator.js";
import { getActiveBankAccounts } from "./Bankaccount.controller.js";
import { parsePagination } from "../utils/pagination.js";
import { userHasPermission } from "../middlewares/authMiddleware.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const FRONTEND = () =>
  process.env.FRONTEND_URL || "https://kemchutahomesltd.com";
const YEAR = () => new Date().getFullYear();

// ── Formatters ────────────────────────────────────────────────────────────────
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
const pdfToBase64 = (buf) => buf.toString("base64");

// ── :id guard ────────────────────────────────────────────────────────────────
// Mirrors estate.controller.js's rejectedInvalidId — without it, a malformed
// id reaches findById/findByIdAndUpdate, throws a CastError, and gets reported
// as a generic 500 for what is plainly bad client input. Returns true when it
// has already sent the response.
const rejectedInvalidId = (req, res) => {
  if (isValidObjectId(req.params.id)) return false;
  res.status(400).json({ message: "Invalid subscription ID" });
  return true;
};

// ── Reference number ──────────────────────────────────────────────────────────
async function genRef() {
  const year = new Date().getFullYear();
  const count = await Subscription.countDocuments();
  return `KHL-${year}-${String(count + 1).padStart(5, "0")}`;
}

// Reference numbers are derived from a document count with no atomic lock, so
// two submissions arriving close together can compute the same value and
// collide against the unique referenceNumber index. Retries with a freshly
// generated ref rather than letting the whole submission fail with a raw
// duplicate-key error.
async function createWithUniqueRef(body, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const referenceNumber = await genRef();
    try {
      return await Subscription.create({ ...body, referenceNumber });
    } catch (err) {
      const isDupRef =
        err.code === 11000 && err.keyPattern?.referenceNumber;
      if (!isDupRef || i === attempts - 1) throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build instalment schedule
// Each instalment is exactly 30 days apart from the subscription date.
// instalmentNumber 1 = deposit (30%), 2..N = equal monthly amounts
// ─────────────────────────────────────────────────────────────────────────────
function buildInstalmentSchedule(totalAmount, months, startDate = new Date()) {
  const deposit = Math.round(totalAmount * 0.3);
  const balance = totalAmount - deposit;
  const perMonth = Math.round(balance / months);
  const start = new Date(startDate);

  const schedule = [];

  // Instalment 1 — deposit due immediately
  schedule.push({
    instalmentNumber: 1,
    dueDate: new Date(start),
    amount: deposit,
    isPaid: false,
  });

  // Instalments 2..months+1 — balance split equally, every 30 days
  for (let i = 1; i <= months; i++) {
    const due = new Date(start);
    due.setDate(due.getDate() + i * 30);
    schedule.push({
      instalmentNumber: i + 1,
      dueDate: due,
      amount:
        i === months
          ? totalAmount - deposit - perMonth * (months - 1) // last captures any rounding
          : perMonth,
      isPaid: false,
    });
  }

  return schedule;
}

// ── Status after Nth instalment confirmed ─────────────────────────────────────
// STATUSES stops at inst_6_paid, but split payments can exceed six confirmed
// payments; inst_7_paid would fail validation and block the confirmation.
function instalmentStatus(n) {
  return `inst_${Math.min(n, 6)}_paid`;
}

// ── Email base wrapper ────────────────────────────────────────────────────────
const emailWrap = (content) => `
<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f3ff;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(112,12,235,0.1);">
  <div style="background:linear-gradient(135deg,#3F0C91,#700CEB);padding:36px 36px 28px;text-align:center;">
    <img src="https://kemchutahomesltd.com/assets/logoWhite.png" alt="Kemchuta Homes" height="40" style="margin-bottom:12px;" onerror="this.style.display='none'">
    <p style="color:rgba(255,255,255,0.7);font-size:12px;margin:0;letter-spacing:1px;text-transform:uppercase;">Kemchuta Homes Limited</p>
  </div>
  <div style="padding:36px;">
    ${content}
  </div>
  <div style="background:#0f0a1e;padding:20px 36px;text-align:center;">
    <p style="color:#6b7280;font-size:11px;margin:0;">© ${YEAR()} Kemchuta Homes Limited &nbsp;·&nbsp; info@kemchutahomesltd.com &nbsp;·&nbsp; +234 800 000 0001</p>
  </div>
</div>
</body></html>`;

const btn = (text, url) =>
  `<div style="text-align:center;margin:24px 0;">
    <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#3F0C91,#700CEB);color:#fff;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">${text}</a>
  </div>`;

const infoBox = (rows) =>
  `<div style="background:#f9f6ff;border-radius:10px;padding:18px 20px;margin:20px 0;border-left:4px solid #700CEB;">
    ${rows.map(([l, v]) => `<p style="margin:5px 0;font-size:13px;color:#374151;"><strong>${l}:</strong> ${escapeHtml(v)}</p>`).join("")}
  </div>`;

// bankBox — accepts live accounts array fetched from DB
// Falls back to a "contact us" message if no accounts configured
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
    <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#059669;">Bank Payment Details</p>
    ${rows}
    <p style="margin:10px 0 4px;font-size:13px;color:#374151;"><strong>Payment Reference:</strong> <strong style="color:#700CEB;">${ref}</strong></p>
    <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">⚠ Always quote your reference on every transfer. Send proof to info@kemchutahomesltd.com</p>
  </div>`;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscriptions  — client submits form
// ─────────────────────────────────────────────────────────────────────────────
export const createSubscription = async (req, res) => {
  try {
    const body = { ...req.body };
    const banks = await getActiveBankAccounts(); // fetch live bank accounts

    // Build instalment schedule immediately on creation
    if (body.paymentPlan === "Instalment" && body.instalmentMonths) {
      body.instalmentSchedule = buildInstalmentSchedule(
        Number(body.totalAmount),
        Number(body.instalmentMonths),
        new Date(),
      );
    }

    const sub = await createWithUniqueRef(body);
    const fullName = `${sub.title} ${sub.firstName} ${sub.lastName}`;
    const ref = sub.referenceNumber;
    const isInst = sub.paymentPlan === "Instalment";
    const deposit = isInst
      ? sub.instalmentSchedule[0]?.amount || Math.round(sub.totalAmount * 0.3)
      : sub.totalAmount;
    const schedule = sub.instalmentSchedule;

    // ── Build schedule HTML for email ────────────────────────────────────
    const scheduleHtml =
      isInst && schedule.length
        ? `
      <p style="font-size:14px;font-weight:700;color:#374151;margin:20px 0 10px;">Payment Schedule:</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <tr style="background:#700CEB;color:#fff;">
          <th style="padding:8px 12px;text-align:left;">Instalment</th>
          <th style="padding:8px 12px;text-align:left;">Due Date</th>
          <th style="padding:8px 12px;text-align:right;">Amount</th>
        </tr>
        ${schedule
          .map(
            (s, i) => `
          <tr style="background:${i % 2 === 0 ? "#f9f6ff" : "#fff"};">
            <td style="padding:8px 12px;">${i === 0 ? "Deposit (30%)" : `Month ${i}`}</td>
            <td style="padding:8px 12px;">${fmtDate(s.dueDate)}</td>
            <td style="padding:8px 12px;text-align:right;font-weight:700;">${fmtNGN(s.amount)}</td>
          </tr>`,
          )
          .join("")}
        <tr style="background:#f0fdf4;font-weight:700;">
          <td style="padding:8px 12px;" colspan="2">Total</td>
          <td style="padding:8px 12px;text-align:right;color:#059669;">${fmtNGN(sub.totalAmount)}</td>
        </tr>
      </table>`
        : "";

    const reminderNote = isInst
      ? `<p style="font-size:13px;color:#6b7280;margin:16px 0;">
          📅 <strong>Payment reminders</strong> will be sent 3 days before each instalment is due.
          Your first payment reminder begins immediately until your deposit is received.
        </p>`
      : `<p style="font-size:13px;color:#6b7280;margin:16px 0;">
          📅 <strong>Payment reminders</strong> will be sent daily until your payment is received.
        </p>`;

    // ── Generate acknowledgement + invoice PDFs ───────────────────────────
    Promise.all([
      generateAcknowledgement(sub),
      generatePaymentInvoice(sub, banks),
    ])
      .then(async ([ackBuf, invBuf]) => {
        await sendEmail({
          to: sub.email,
          subject: `🎉 Welcome to Kemchuta Homes — Your Land Journey Begins! [${ref}]`,
          attachments: [
            {
              filename: `Acknowledgement-${ref}.pdf`,
              content: pdfToBase64(ackBuf),
              contentType: "application/pdf",
            },
            {
              filename: `Invoice-${ref}.pdf`,
              content: pdfToBase64(invBuf),
              contentType: "application/pdf",
            },
          ],
          html: emailWrap(`
            <h2 style="color:#0f0a1e;font-size:22px;font-weight:900;margin:0 0 8px;">Congratulations, ${escapeHtml(sub.firstName)}! 🎉</h2>
            <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
              You have taken a <strong>bold step towards land ownership</strong> by subscribing to
              <strong>${escapeHtml(sub.estateName)}</strong>. This is a milestone worth celebrating!
            </p>
            ${infoBox([
              ["Reference", ref],
              ["Estate", sub.estateName],
              ["Plot Type", sub.plotType],
              ["Plot Size", `${sub.plotSize} × ${sub.numberOfPlots}`],
              [
                "Payment Plan",
                isInst
                  ? `Instalment — ${sub.instalmentMonths} months`
                  : "Outright",
              ],
              ["Total Amount", fmtNGN(sub.totalAmount)],
              ["Amount Due Now", fmtNGN(deposit)],
            ])}
            <p style="font-size:14px;font-weight:700;color:#374151;margin:20px 0 6px;">Contract Terms Summary:</p>
            <ul style="font-size:13px;color:#374151;line-height:1.9;padding-left:20px;margin:0 0 16px;">
              <li>Subscription is subject to admin confirmation within 24–48 hours</li>
              <li>Payment must quote reference <strong>${ref}</strong> on all transfers</li>
              <li>${isInst ? `Instalments are due every 30 days. Late payment attracts 5% monthly penalty on overdue amount` : "Full payment secures immediate plot allocation processing"}</li>
              <li>If you wish to withdraw, 90 days notice is required (40% admin + 10% agency fees apply)</li>
              <li>Title documents are processed within 90 days of full payment</li>
            </ul>
            ${scheduleHtml}
            ${bankBox(ref, banks)}
            ${reminderNote}
            <p style="font-size:13px;color:#374151;margin:16px 0;">
              Your <strong>Acknowledgement</strong> and <strong>Payment Invoice</strong> are attached.
              Our team will contact you within 24–48 hours to confirm your subscription.
            </p>
            ${btn("View Your Portal", `${FRONTEND()}/client/portal`)}
          `),
        });

        // Admin notification
        await sendEmail({
          to: process.env.ADMIN_EMAIL || "info@kemchutahomesltd.com",
          subject: `New Subscription — ${sub.estateName} [${ref}]`,
          html: emailWrap(`
            <h2 style="color:#0f0a1e;font-size:18px;font-weight:900;margin:0 0 16px;">New Subscription Received</h2>
            ${infoBox([
              ["Reference", ref],
              ["Subscriber", fullName],
              ["Email", sub.email],
              ["Phone", sub.phone],
              ["Estate", sub.estateName],
              [
                "Plot",
                `${sub.plotType} — ${sub.plotSize} × ${sub.numberOfPlots}`,
              ],
              ["Amount", fmtNGN(sub.totalAmount)],
              [
                "Plan",
                isInst
                  ? `Instalment (${sub.instalmentMonths} months)`
                  : "Outright",
              ],
            ])}
            <p style="color:#374151;font-size:13px;">Please contact the subscriber within 24 hours to confirm the subscription and record your notes.</p>
          `),
        });

        // Save documents
        await Subscription.findByIdAndUpdate(sub._id, {
          $push: {
            documents: {
              $each: [
                {
                  type: "acknowledgement",
                  label: "Subscription Acknowledgement",
                  generatedAt: new Date(),
                },
                {
                  type: "invoice",
                  label: "Payment Invoice",
                  generatedAt: new Date(),
                },
              ],
            },
          },
        });

        console.log(
          `✅ Subscription created ${ref} — docs emailed to ${sub.email}`,
        );
        // SMS to client — fires alongside email confirmation
        sendSMS(
          sub.phone,
          `Hi ${sub.firstName}, your KHL land subscription for ${sub.estateName} (Ref: ${ref}) is received. Check your email for invoice & payment details. - Kemchuta Homes`,
        ).catch(() => null);
      })
      .catch((err) =>
        console.error("❌ Subscription email failed:", err.message),
      );

    res.status(201).json({
      message:
        "Subscription submitted! Check your email for confirmation and payment details.",
      subscription: {
        _id: sub._id,
        referenceNumber: ref,
        estateName: sub.estateName,
        status: sub.status,
      },
    });
  } catch (err) {
    console.error("createSubscription:", err);
    res.status(500).json({ message: "Failed to submit subscription." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions — admin list
// ─────────────────────────────────────────────────────────────────────────────
export const getAllSubscriptions = async (req, res) => {
  try {
    const { status, search, plotType } = req.query;
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (status) filter.status = status;
    if (plotType) filter.plotType = plotType;
    if (search) {
      const safeSearch = escapeRegex(String(search).slice(0, 100));
      filter.$or = [
        { estateName: { $regex: safeSearch, $options: "i" } },
        { firstName: { $regex: safeSearch, $options: "i" } },
        { lastName: { $regex: safeSearch, $options: "i" } },
        { email: { $regex: safeSearch, $options: "i" } },
        { referenceNumber: { $regex: safeSearch, $options: "i" } },
      ];
    }
    const [subscriptions, total] = await Promise.all([
      Subscription.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Subscription.countDocuments(filter),
    ]);
    res.json({
      subscriptions,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch subscriptions." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions/:id — single subscription (admin)
// ─────────────────────────────────────────────────────────────────────────────
export const getSubscriptionById = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const sub = await Subscription.findById(req.params.id)
      .populate("realtorId", "firstName lastName referralCode")
      .lean();
    if (!sub)
      return res.status(404).json({ message: "Subscription not found." });
    // Attach virtuals manually since .lean() strips them
    sub.balanceRemaining = Math.max(0, sub.totalAmount - (sub.amountPaid || 0));
    sub.paymentProgressPercent = sub.totalAmount
      ? Math.min(
          100,
          Math.round(((sub.amountPaid || 0) / sub.totalAmount) * 100),
        )
      : 0;
    sub.nextInstalmentDue =
      sub.instalmentSchedule?.find?.((s) => !s.isPaid) || null;
    sub.isPaymentComplete = (sub.amountPaid || 0) >= sub.totalAmount;
    res.json(sub);
  } catch (err) {
    console.error("getSubscriptionById:", err.message);
    res.status(500).json({ message: "Failed to fetch subscription." });
  }
};

export const getMySubscriptions = async (req, res) => {
  try {
    const subs = await Subscription.find({ email: req.user.email })
      .sort({ createdAt: -1 })
      .lean();
    res.json(subs);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch subscriptions." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions/my/:id — single subscription (client-owned)
// A dedicated lookup instead of making the client portal's detail page fetch
// getMySubscriptions' entire list (every subscription's full document —
// payments, instalmentSchedule, documents, notes) just to Array.find() one
// by id client-side. The email filter doubles as the ownership check: a
// subscription belonging to another client 404s here exactly as it would
// have silently not appeared in the old full-list-then-find.
// ─────────────────────────────────────────────────────────────────────────────
export const getMySubscriptionById = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const sub = await Subscription.findOne({
      _id: req.params.id,
      email: req.user.email,
    }).lean();
    if (!sub)
      return res.status(404).json({ message: "Subscription not found." });
    res.json(sub);
  } catch (err) {
    console.error("getMySubscriptionById:", err.message);
    res.status(500).json({ message: "Failed to fetch subscription." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscriptions/:id/notes — admin adds a follow-up note
// ─────────────────────────────────────────────────────────────────────────────
export const addNote = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { content, type = "note" } = req.body;
    if (!content?.trim())
      return res.status(400).json({ message: "Note content required" });

    const sub = await Subscription.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          notes: {
            content: content.trim(),
            type,
            addedBy: req.user?.email || "admin",
          },
        },
      },
      { new: true },
    );
    if (!sub)
      return res.status(404).json({ message: "Subscription not found." });
    res.json({ message: "Note added.", notes: sub.notes });
  } catch (err) {
    res.status(500).json({ message: "Failed to add note." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/subscriptions/:id/status — Admin inline status dropdown
// Only the statuses an admin actually decides (pending/confirmed/rejected)
// are settable here. The rest of STATUSES — partial_paid, outright_paid,
// inst_N_paid, completed, allocated — are derived from real money movement
// or a real plot assignment (confirmPayment / allocatePlot) and must never
// be reachable by picking an option in a dropdown: doing so would let an
// admin mark a subscription "completed" or "allocated" with zero payments
// or documents behind it.
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_SETTABLE_STATUSES = ["pending", "confirmed", "rejected"];

const sendMissingOrWrongState = async (
  res,
  id,
  message = "This subscription already has payments or an allocation, so its status can't be changed here.",
) => {
  const exists = await Subscription.exists({ _id: id });
  return exists
    ? res.status(400).json({ message })
    : res.status(404).json({ message: "Subscription not found." });
};

export const updateSubscriptionStatus = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const banks = await getActiveBankAccounts();
    const { status } = req.body;
    if (!ADMIN_SETTABLE_STATUSES.includes(status))
      return res.status(400).json({
        message: `This status can only be set by the payment/allocation workflow. Valid manual values: ${ADMIN_SETTABLE_STATUSES.join(", ")}`,
      });

    // Build the update payload — add extra fields for specific transitions
    const update = { status };

    if (status === "confirmed") {
      update.confirmedByAdmin = req.user?.email || "admin";
      update.confirmedAt = new Date();
    }

    // Going back to pending/confirmed would erase real payment progress.
    const sub = await Subscription.findOneAndUpdate(
      {
        _id: req.params.id,
        ...(status !== "rejected" && { status: { $in: ADMIN_SETTABLE_STATUSES } }),
      },
      update,
      { new: true },
    );
    if (!sub) return sendMissingOrWrongState(res, req.params.id);

    const ref =
      sub.referenceNumber || sub._id.toString().slice(-8).toUpperCase();
    const fullName = `${sub.title} ${sub.firstName} ${sub.lastName}`;
    const isInst = sub.paymentPlan === "Instalment";

    // ── Send email notification for every status transition ──────────────────
    const emailByStatus = async () => {
      switch (status) {
        case "confirmed": {
          const amtDue = isInst
            ? sub.instalmentSchedule?.[0]?.amount ||
              Math.round(sub.totalAmount * 0.3)
            : sub.totalAmount;
          try {
            const invBuf = await generatePaymentInvoice(sub, banks);
            await sendEmail({
              to: sub.email,
              subject: `✅ Subscription Confirmed — ${sub.estateName} [${ref}]`,
              attachments: [
                {
                  filename: `Invoice-${ref}.pdf`,
                  content: pdfToBase64(invBuf),
                  contentType: "application/pdf",
                },
              ],
              html: emailWrap(`
                <h2 style="color:#059669;font-size:22px;font-weight:900;margin:0 0 8px;">Subscription Confirmed! ✅</h2>
                <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
                  Dear <strong>${escapeHtml(fullName)}</strong>,<br><br>
                  Congratulations! Your land subscription for <strong>${escapeHtml(sub.estateName)}</strong> has been confirmed.
                  Please proceed to making your payment to secure your plot.
                </p>
                ${infoBox([
                  ["Reference", ref],
                  ["Estate", sub.estateName],
                  [
                    "Plan",
                    isInst
                      ? `Instalment — ${sub.instalmentMonths} months`
                      : "Outright",
                  ],
                  ["Total Amount", fmtNGN(sub.totalAmount)],
                  ["Amount Due Now", fmtNGN(amtDue)],
                ])}
                ${bankBox(ref, banks)}
                <p style="font-size:13px;color:#374151;margin:12px 0;">
                  Your <strong>Payment Invoice</strong> is attached. Quote reference <strong style="color:#700CEB;">${ref}</strong> on all transfers.
                </p>
                ${btn("View My Portal", `${FRONTEND()}/client/portal`)}
              `),
            });
          } catch (e) {
            console.error("Confirm email failed:", e.message);
          }
          break;
        }

        case "rejected": {
          // Clawback commissions
          if (sub.realtorId) {
            clawbackCommissions(sub._id, "Subscription rejected").catch(
              () => null,
            );
          }
          await sendEmail({
            to: sub.email,
            subject: `Subscription Update — ${sub.estateName} [${ref}]`,
            html: emailWrap(`
              <h2 style="color:#dc2626;font-size:20px;font-weight:900;margin:0 0 8px;">Subscription Not Approved</h2>
              <p style="color:#374151;font-size:15px;line-height:1.75;">
                Dear <strong>${escapeHtml(fullName)}</strong>,<br><br>
                We regret to inform you that your subscription for <strong>${escapeHtml(sub.estateName)}</strong> could not be approved at this time.
                Please contact us for more information.
              </p>
              ${btn("Contact Us", `${FRONTEND()}/contact`)}
            `),
          }).catch(() => null);
          break;
        }

        default:
          break;
      }
    };

    emailByStatus().catch((e) =>
      console.error("Status email error:", e.message),
    );

    res.json({ message: "Status updated.", subscription: sub });
  } catch (err) {
    console.error("updateSubscriptionStatus:", err);
    res.status(500).json({ message: "Failed to update status." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/subscriptions/:id/confirm — admin confirms subscription with client
// Triggers: confirmation email + invoice to client
// ─────────────────────────────────────────────────────────────────────────────
export const confirmSubscription = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const banks = await getActiveBankAccounts();
    const sub = await Subscription.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ADMIN_SETTABLE_STATUSES } },
      {
        status: "confirmed",
        confirmedByAdmin: req.user?.email || "admin",
        confirmedAt: new Date(),
      },
      { new: true },
    );
    if (!sub) return sendMissingOrWrongState(res, req.params.id);

    const ref =
      sub.referenceNumber || sub._id.toString().slice(-8).toUpperCase();
    const isInst = sub.paymentPlan === "Instalment";
    const amtDue = isInst
      ? sub.instalmentSchedule[0]?.amount || Math.round(sub.totalAmount * 0.3)
      : sub.totalAmount;

    // Generate fresh invoice
    generatePaymentInvoice(sub, banks)
      .then(async (invBuf) => {
        await sendEmail({
          to: sub.email,
          subject: `✅ Land Purchase Confirmed — ${sub.estateName} [${ref}]`,
          attachments: [
            {
              filename: `Invoice-${ref}.pdf`,
              content: pdfToBase64(invBuf),
              contentType: "application/pdf",
            },
          ],
          html: emailWrap(`
            <h2 style="color:#059669;font-size:22px;font-weight:900;margin:0 0 8px;">Congratulations! Your Purchase is Confirmed ✅</h2>
            <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
              Dear <strong>${escapeHtml(sub.title)} ${escapeHtml(sub.firstName)} ${escapeHtml(sub.lastName)}</strong>,<br><br>
              We are pleased to confirm your land subscription for <strong>${escapeHtml(sub.estateName)}</strong>.
              Please proceed to making your payment to secure your plot.
            </p>
            ${infoBox([
              ["Reference", ref],
              ["Estate", sub.estateName],
              [
                "Plan",
                isInst
                  ? `Instalment — ${sub.instalmentMonths} months`
                  : "Outright",
              ],
              ["Total Amount", fmtNGN(sub.totalAmount)],
              ["Amount Due Now", fmtNGN(amtDue)],
            ])}
            ${bankBox(ref, banks)}
            <p style="font-size:13px;color:#374151;margin:16px 0;">
              Your <strong>Payment Invoice</strong> is attached. Please make payment and send proof to
              <strong>info@kemchutahomesltd.com</strong> or WhatsApp us.
            </p>
            ${btn("View Your Portal", `${FRONTEND()}/client/portal`)}
          `),
        });
        console.log(`✅ Confirmation email sent to ${sub.email}`);
        // SMS to client
        sendSMS(
          sub.phone,
          `Hi ${sub.title} ${sub.firstName}, your ${sub.estateName} subscription is CONFIRMED (Ref: ${ref}). Check email for invoice. Quote ${ref} on all transfers. - KHL`,
        ).catch(() => null);
      })
      .catch((err) =>
        console.error("❌ Confirmation email failed:", err.message),
      );

    res.json({ message: "Subscription confirmed.", subscription: sub });
  } catch (err) {
    res.status(500).json({ message: "Failed to confirm subscription." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/subscriptions/:id/payments — Step 1: log incoming payment
// ─────────────────────────────────────────────────────────────────────────────
export const recordPayment = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { amount, method, reference, note, paidAt } = req.body;
    if (!amount || amount <= 0)
      return res.status(400).json({ message: "Valid amount required" });

    const sub = await Subscription.findOneAndUpdate(
      { _id: req.params.id, status: { $ne: "rejected" } },
      {
        $push: {
          payments: {
            amount: Number(amount),
            paidAt: paidAt ? new Date(paidAt) : new Date(),
            method: method || "Bank Transfer",
            reference: reference || "",
            note: note || "",
            recordedBy: req.user?.email || "admin",
            confirmed: false,
          },
        },
      },
      { new: true },
    );
    if (!sub)
      return sendMissingOrWrongState(
        res,
        req.params.id,
        "Payments can't be recorded on a rejected subscription.",
      );

    res.json({
      message:
        "Payment logged. Confirm the payment to issue the official receipt.",
      pendingPaymentId: sub.payments[sub.payments.length - 1]._id,
      subscription: sub,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to record payment." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/subscriptions/:id/payments/:paymentId/confirm — Step 2
// Confirms payment, advances status, generates receipt + next invoice, sends email
// ─────────────────────────────────────────────────────────────────────────────
export const confirmPayment = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  if (!isValidObjectId(req.params.paymentId))
    return res.status(400).json({ message: "Invalid payment ID" });
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub)
      return res.status(404).json({ message: "Subscription not found." });
    if (sub.status === "rejected")
      return res
        .status(400)
        .json({ message: "Payments can't be confirmed on a rejected subscription." });

    const payment = sub.payments.id(req.params.paymentId);
    if (!payment)
      return res.status(404).json({ message: "Payment not found." });
    if (payment.confirmed)
      return res.status(400).json({ message: "Already confirmed." });

    const wasAllocated = sub.status === "allocated";

    // Confirm
    payment.confirmed = true;
    payment.confirmedBy = req.user?.email || "admin";
    payment.confirmedAt = new Date();
    sub.amountPaid = (sub.amountPaid || 0) + payment.amount;

    const isInst = sub.paymentPlan === "Instalment";
    const ref =
      sub.referenceNumber || sub._id.toString().slice(-8).toUpperCase();
    const confirmedN = sub.payments.filter((p) => p.confirmed).length; // nth confirmed payment
    const balance = Math.max(0, sub.totalAmount - sub.amountPaid);
    const fullName = `${sub.title} ${sub.firstName} ${sub.lastName}`;

    // ── Advance status ────────────────────────────────────────────────────
    if (isInst) {
      // Mark matching instalment paid
      const unpaid = sub.instalmentSchedule.find((s) => !s.isPaid);
      if (unpaid) {
        unpaid.isPaid = true;
        unpaid.paidAt = payment.paidAt;
        unpaid.paymentId = payment._id;
      }

      if (sub.amountPaid >= sub.totalAmount) {
        sub.status = "completed";
      } else {
        sub.status = instalmentStatus(confirmedN);
      }

      // Recalculate remaining instalments
      const remaining = sub.instalmentSchedule.filter((s) => !s.isPaid);
      const remainingCount = remaining.length;
      if (remainingCount > 0 && balance > 0) {
        const newMonthly = Math.round(balance / remainingCount);
        remaining.forEach((s, i) => {
          s.amount =
            i === remainingCount - 1
              ? balance - newMonthly * (remainingCount - 1)
              : newMonthly;
        });
      }
    } else {
      // Outright
      if (sub.amountPaid >= sub.totalAmount) {
        sub.status = "completed";
      } else {
        sub.status = "partial_paid";
      }
    }

    // A late payment must not undo an allocation that already happened.
    if (wasAllocated) sub.status = "allocated";

    await sub.save();

    // After the save, so a failed confirmation can't leave commissions behind.
    if (confirmedN === 1 && sub.realtorId) {
      calculateCommissions(sub._id, sub.realtorId).catch((e) =>
        console.error("Commission calc error:", e.message),
      );
    }

    // ── Next instalment info ───────────────────────────────────────────────
    const nextInst = sub.instalmentSchedule?.find((s) => !s.isPaid);

    // ── Generate documents ─────────────────────────────────────────────────
    const docsToGenerate = [generateReceipt(sub, payment)];
    if (isInst) docsToGenerate.push(generateInstallmentSchedule(sub));
    if (confirmedN === 1) docsToGenerate.push(generateContractOfSale(sub));
    if (sub.status === "completed")
      docsToGenerate.push(generateAllocationLetter(sub));

    Promise.all(docsToGenerate)
      .then(async ([receiptBuf, ...rest]) => {
        const attachments = [
          {
            filename: `Receipt-${ref}-${String(confirmedN).padStart(2, "0")}.pdf`,
            content: pdfToBase64(receiptBuf),
            contentType: "application/pdf",
          },
        ];

        let schedBuf, contractBuf, allocBuf;
        if (isInst) {
          schedBuf = rest.shift();
        }
        if (confirmedN === 1) {
          contractBuf = rest.shift();
        }
        if (sub.status === "completed") {
          allocBuf = rest.shift();
        }

        if (schedBuf)
          attachments.push({
            filename: `Schedule-${ref}.pdf`,
            content: pdfToBase64(schedBuf),
            contentType: "application/pdf",
          });
        if (contractBuf)
          attachments.push({
            filename: `Contract-${ref}.pdf`,
            content: pdfToBase64(contractBuf),
            contentType: "application/pdf",
          });
        if (allocBuf)
          attachments.push({
            filename: `Allocation-${ref}.pdf`,
            content: pdfToBase64(allocBuf),
            contentType: "application/pdf",
          });

        // Build payment email
        const isComplete = sub.status === "completed";
        const statusLabel = isInst
          ? isComplete
            ? "All instalments received"
            : `Instalment ${confirmedN} confirmed`
          : isComplete
            ? "Full payment received"
            : "Partial payment received";

        await sendEmail({
          to: sub.email,
          subject: isComplete
            ? `🎉 Payment Complete — ${sub.estateName} [${ref}]`
            : `Payment Confirmed — ${sub.estateName} [${ref}]`,
          attachments,
          html: emailWrap(`
            <h2 style="color:${isComplete ? "#059669" : "#700CEB"};font-size:22px;font-weight:900;margin:0 0 8px;">
              ${isComplete ? "🎉 Payment Complete!" : "✅ Payment Confirmed"}
            </h2>
            <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
              Dear <strong>${escapeHtml(fullName)}</strong>,<br><br>
              ${
                isComplete
                  ? `Congratulations! You have completed all payments for your land at <strong>${escapeHtml(sub.estateName)}</strong>. Your plot allocation is being processed.`
                  : `We have confirmed your payment of <strong>${fmtNGN(payment.amount)}</strong> for <strong>${escapeHtml(sub.estateName)}</strong>.`
              }
            </p>
            ${infoBox([
              ["Reference", ref],
              ["Status", statusLabel],
              ["Amount Paid", fmtNGN(payment.amount)],
              ["Total Paid", fmtNGN(sub.amountPaid)],
              ["Balance", fmtNGN(balance)],
              ...(nextInst && !isComplete
                ? [
                    [
                      "Next Due",
                      `${fmtNGN(nextInst.amount)} on ${fmtDate(nextInst.dueDate)}`,
                    ],
                  ]
                : []),
            ])}
            ${
              isComplete
                ? `
              <div style="background:#f0fdf4;border-radius:10px;padding:16px 20px;margin:20px 0;border-left:4px solid #059669;">
                <p style="margin:0;font-size:14px;color:#059669;font-weight:700;">🏆 What happens next?</p>
                <ul style="font-size:13px;color:#374151;line-height:1.9;padding-left:20px;margin:8px 0 0;">
                  <li>Your <strong>Allocation Letter</strong> has been attached to this email</li>
                  <li>Your <strong>Deed of Assignment</strong> will be processed within 90 days</li>
                  <li>All documents are available in your <strong>Client Portal</strong></li>
                </ul>
              </div>`
                : `
              <p style="font-size:13px;color:#6b7280;margin:16px 0;">
                📅 You will receive a payment reminder 3 days before your next instalment is due.
              </p>`
            }
            <p style="font-size:13px;color:#374151;margin:16px 0;">
              Documents attached: <strong>Receipt</strong>${schedBuf ? ", Instalment Schedule" : ""}${contractBuf ? ", Contract of Sale" : ""}${allocBuf ? ", Allocation Letter" : ""}
            </p>
            ${btn("View Your Portal", `${FRONTEND()}/client/portal`)}
          `),
        });

        // Save doc records
        const newDocs = [
          {
            type: "receipt",
            label: `Payment Receipt #${confirmedN}`,
            generatedAt: new Date(),
          },
        ];
        if (schedBuf)
          newDocs.push({
            type: "schedule",
            label: "Updated Instalment Schedule",
            generatedAt: new Date(),
          });
        if (contractBuf)
          newDocs.push({
            type: "contract",
            label: "Contract of Sale",
            generatedAt: new Date(),
          });
        if (allocBuf)
          newDocs.push({
            type: "allocation",
            label: "Letter of Allocation",
            generatedAt: new Date(),
          });
        await Subscription.findByIdAndUpdate(sub._id, {
          $push: { documents: { $each: newDocs } },
        });

        console.log(
          `✅ Payment #${confirmedN} confirmed [${ref}] → ${sub.email} (${sub.status})`,
        );
        // SMS to client
        const _smsBalance = Math.max(0, sub.totalAmount - sub.amountPaid);
        const _smsMsg =
          sub.status === "completed"
            ? `Congrats ${sub.firstName}! All payments received for ${sub.estateName} (Ref: ${ref}). Plot allocation in progress. - KHL`
            : `Hi ${sub.firstName}, payment of NGN ${Number(payment.amount).toLocaleString("en-NG")} confirmed for ${sub.estateName} (Ref: ${ref}). Balance: NGN ${_smsBalance.toLocaleString("en-NG")}. - KHL`;
        sendSMS(sub.phone, _smsMsg).catch(() => null);
      })
      .catch((err) => console.error("❌ Payment docs failed:", err.message));

    res.json({
      message: "Payment confirmed. Receipt and documents are being generated.",
      subscription: sub,
    });
  } catch (err) {
    // Two admins confirming at once: Mongoose's version check stops the second.
    if (err.name === "VersionError") {
      return res.status(409).json({
        message: "This subscription was just updated by someone else. Refresh and try again.",
      });
    }
    console.error("confirmPayment:", err);
    res.status(500).json({ message: "Failed to confirm payment." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/subscriptions/:id/allocate — assign plot, issue final docs
// ─────────────────────────────────────────────────────────────────────────────
export const allocatePlot = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { plotNumber, titleDocument, plotDescription } = req.body;
    if (!plotNumber?.trim())
      return res.status(400).json({ message: "Plot number is required" });

    // Same statuses the dashboard offers the Allocate action on. Allocation
    // issues a deed, so an unpaid subscription must never reach it.
    const sub = await Subscription.findOneAndUpdate(
      {
        _id: req.params.id,
        status: { $in: ["completed", "outright_paid", "allocated"] },
      },
      {
        plotNumber,
        plotDescription: plotDescription?.trim() || "",
        titleDocument: titleDocument || "",
        allocationDate: new Date(),
        status: "allocated",
      },
      { new: true },
    );
    if (!sub)
      return sendMissingOrWrongState(
        res,
        req.params.id,
        "A plot can only be allocated once the subscription is fully paid.",
      );

    const ref =
      sub.referenceNumber || sub._id.toString().slice(-8).toUpperCase();

    // Generate allocation letter + deed of assignment
    const generators = [generateAllocationLetter(sub)];
    if (typeof generateDeedOfAssignment === "function") {
      generators.push(generateDeedOfAssignment(sub));
    }

    Promise.all(generators)
      .then(async ([allocBuf, deedBuf]) => {
        const attachments = [
          {
            filename: `Allocation-Letter-${ref}.pdf`,
            content: pdfToBase64(allocBuf),
            contentType: "application/pdf",
          },
        ];
        if (deedBuf) {
          attachments.push({
            filename: `Deed-of-Assignment-${ref}.pdf`,
            content: pdfToBase64(deedBuf),
            contentType: "application/pdf",
          });
        }

        await sendEmail({
          to: sub.email,
          subject: `🏡 Plot Allocated — ${sub.estateName} [${ref}]`,
          attachments,
          html: emailWrap(`
            <h2 style="color:#700CEB;font-size:22px;font-weight:900;margin:0 0 8px;">Your Plot Has Been Allocated! 🏡</h2>
            <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
              Dear <strong>${escapeHtml(sub.title)} ${escapeHtml(sub.firstName)} ${escapeHtml(sub.lastName)}</strong>,<br><br>
              Congratulations! After completing your land purchase journey with Kemchuta Homes,
              we are delighted to officially allocate your plot at <strong>${escapeHtml(sub.estateName)}</strong>.
            </p>
            ${infoBox([
              ["Reference", ref],
              ["Estate", sub.estateName],
              ["Plot Number", plotNumber],
              ...(sub.plotDescription
                ? [["Plot Description", sub.plotDescription]]
                : []),
              ["Plot Size", sub.plotSize],
              ["Plot Type", sub.plotType],
              ["Title Type", titleDocument || sub.surveyType],
              ["Allocation Date", fmtDate(new Date())],
            ])}
            <div style="background:#f9f6ff;border-radius:10px;padding:16px 20px;margin:20px 0;border-left:4px solid #700CEB;">
              <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#700CEB;">Documents Attached:</p>
              <p style="margin:3px 0;font-size:13px;color:#374151;">📄 <strong>Letter of Allocation</strong> — your official ownership confirmation</p>
              ${deedBuf ? '<p style="margin:3px 0;font-size:13px;color:#374151;">📄 <strong>Deed of Assignment</strong> — legal transfer document</p>' : ""}
              <p style="margin:12px 0 0;font-size:12px;color:#6b7280;">
                Keep these documents safe. Deed of Assignment processing takes 90 working days.
              </p>
            </div>
            ${btn("Download All Documents", `${FRONTEND()}/client/portal/documents`)}
          `),
        });

        const newDocs = [
          {
            type: "allocation",
            label: "Letter of Allocation",
            generatedAt: new Date(),
          },
        ];
        if (deedBuf)
          newDocs.push({
            type: "deed",
            label: "Deed of Assignment",
            generatedAt: new Date(),
          });
        await Subscription.findByIdAndUpdate(sub._id, {
          $push: { documents: { $each: newDocs } },
        });

        // SMS to client
        sendSMS(
          sub.phone,
          `Congratulations ${sub.title} ${sub.firstName}! Your plot at ${sub.estateName} has been ALLOCATED (Plot: ${plotNumber}, Ref: ${ref}). Check email for docs. - KHL`,
        ).catch(() => null);
        console.log(`✅ Plot allocated [${ref}] → ${sub.email}`);
      })
      .catch((err) => console.error("❌ Allocation docs failed:", err.message));

    res.json({
      message:
        "Plot allocated. Allocation letter and deed are being generated.",
      subscription: sub,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to allocate plot." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/subscriptions/:id/documents/:docType — download PDF
// ─────────────────────────────────────────────────────────────────────────────
export const downloadDocument = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub)
      return res.status(404).json({ message: "Subscription not found." });

    // protectAdminOrClient only checks the token is valid, not that a
    // client-role caller owns this particular subscription — without this,
    // any logged-in client could download another client's documents
    // (acknowledgement, contract, invoice, receipt) by guessing/enumerating
    // subscription IDs. Admins are unaffected: this only gates role "client".
    if (
      req.user?.role === "client" &&
      sub.email?.toLowerCase() !== req.user.email?.toLowerCase()
    ) {
      return res.status(403).json({ message: "Access denied." });
    }
    if (
      req.user?.role !== "client" &&
      !userHasPermission(req.user, "manage_subscriptions")
    ) {
      return res
        .status(403)
        .json({ message: "You do not have permission to access this section." });
    }

    const { docType } = req.params;
    const map = {
      acknowledgement: () => generateAcknowledgement(sub),
      contract: () => generateContractOfSale(sub),
      invoice: async () => {
        const b = await getActiveBankAccounts();
        return generatePaymentInvoice(sub, b);
      },
      schedule: () => generateInstallmentSchedule(sub),
      receipt: () => {
        const confirmed = sub.payments.filter((p) => p.confirmed);
        const latest = confirmed[confirmed.length - 1];
        return latest ? generateReceipt(sub, latest) : null;
      },
      allocation: () => generateAllocationLetter(sub),
      deed: () =>
        typeof generateDeedOfAssignment === "function"
          ? generateDeedOfAssignment(sub)
          : null,
    };

    const gen = map[docType];
    if (!gen)
      return res.status(400).json({ message: "Invalid document type." });

    // Clients only get what has been issued to them: otherwise anyone could
    // download a contract or Deed of Assignment for an unpaid subscription.
    if (
      req.user?.role === "client" &&
      !["acknowledgement", "invoice"].includes(docType) &&
      !sub.documents?.some((d) => d.type === docType)
    ) {
      return res.status(404).json({ message: "Document not available." });
    }

    const buf = await gen();
    if (!buf)
      return res.status(404).json({ message: "Document not available." });

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${docType}-${sub.referenceNumber}.pdf"`,
      "Content-Length": buf.length,
    });
    res.end(buf);
  } catch (err) {
    console.error("downloadDocument:", err);
    res.status(500).json({ message: "Failed to generate document." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CRON — sendPaymentReminders
// Called daily by followUp.js scheduler.
// Sends reminder emails 3 days before each instalment due date.
// For unconfirmed subscriptions (no deposit yet), sends daily reminders.
// ─────────────────────────────────────────────────────────────────────────────
export async function sendPaymentReminders() {
  try {
    const banks = await getActiveBankAccounts();
    const now = new Date();
    const in3Days = new Date(now);
    in3Days.setDate(now.getDate() + 3);

    // Find subscriptions with upcoming instalments
    const subs = await Subscription.find({
      status: {
        $in: [
          "confirmed",
          "inst_1_paid",
          "inst_2_paid",
          "inst_3_paid",
          "inst_4_paid",
          "inst_5_paid",
          "inst_6_paid", // a 6-month plan has 7 instalments, deposit included
          "partial_paid",
        ],
      },
      "instalmentSchedule.isPaid": false,
    });

    let sent = 0;
    for (const sub of subs) {
      const ref = sub.referenceNumber;
      const fullName = `${sub.firstName} ${sub.lastName}`;

      // Find the next unpaid instalment
      const next = sub.instalmentSchedule?.find((s) => !s.isPaid);
      if (!next) continue;

      const dueDate = new Date(next.dueDate);
      const daysUntil = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
      const isOverdue = daysUntil < 0;
      const isDueIn3 = daysUntil >= 0 && daysUntil <= 3;
      const noPaid = sub.amountPaid === 0; // no payment at all yet — daily reminder

      if (!isDueIn3 && !isOverdue && !noPaid) continue;

      // Rate limit — don't send more than once per day
      if (next.lastReminderAt) {
        const hoursSince =
          (now - new Date(next.lastReminderAt)) / (1000 * 60 * 60);
        if (hoursSince < 22) continue;
      }

      await generatePaymentInvoice(sub, banks)
        .then(async (invBuf) => {
          const subject = isOverdue
            ? `⚠ Overdue Payment — ${sub.estateName} [${ref}]`
            : noPaid
              ? `Reminder: Initial Payment Due — ${sub.estateName} [${ref}]`
              : `📅 Payment Due in ${daysUntil} day${daysUntil !== 1 ? "s" : ""} — ${sub.estateName} [${ref}]`;

          await sendEmail({
            to: sub.email,
            subject,
            attachments: [
              {
                filename: `Invoice-${ref}.pdf`,
                content: pdfToBase64(invBuf),
                contentType: "application/pdf",
              },
            ],
            html: emailWrap(`
              <h2 style="color:${isOverdue ? "#dc2626" : "#700CEB"};font-size:20px;font-weight:900;margin:0 0 8px;">
                ${isOverdue ? "⚠ Payment Overdue" : "📅 Payment Reminder"}
              </h2>
              <p style="color:#374151;font-size:15px;line-height:1.75;margin:0 0 16px;">
                Dear <strong>${escapeHtml(fullName)}</strong>,<br><br>
                ${
                  isOverdue
                    ? `Your instalment payment for <strong>${escapeHtml(sub.estateName)}</strong> was due on <strong>${fmtDate(dueDate)}</strong> and is now overdue.`
                    : noPaid
                      ? `This is a reminder that your initial deposit for <strong>${escapeHtml(sub.estateName)}</strong> is due. Please make payment to secure your plot.`
                      : `Your next instalment for <strong>${escapeHtml(sub.estateName)}</strong> is due in <strong>${daysUntil} day${daysUntil !== 1 ? "s" : ""}</strong>.`
                }
              </p>
              ${infoBox([
                ["Reference", ref],
                ["Amount Due", fmtNGN(next.amount)],
                ["Due Date", fmtDate(dueDate)],
                ["Total Paid", fmtNGN(sub.amountPaid)],
                ["Balance", fmtNGN(sub.totalAmount - sub.amountPaid)],
              ])}
              ${bankBox(ref, banks)}
              ${isOverdue ? `<p style="color:#dc2626;font-size:13px;font-weight:600;margin:12px 0;">⚠ Late payment attracts a 5% monthly penalty on the overdue amount. Please pay as soon as possible.</p>` : ""}
              ${btn("View Your Portal", `${FRONTEND()}/client/portal`)}
            `),
          });

          // Update reminder tracking
          await Subscription.updateOne(
            { _id: sub._id, "instalmentSchedule._id": next._id },
            {
              $inc: { "instalmentSchedule.$.remindersSent": 1 },
              $set: { "instalmentSchedule.$.lastReminderAt": now },
            },
          );
          sent++;
        })
        .catch((e) =>
          console.error(`Reminder email failed for ${ref}:`, e.message),
        );
    }

    if (sent > 0) console.log(`✅ Cron: ${sent} payment reminder(s) sent`);
    return sent;
  } catch (err) {
    console.error("sendPaymentReminders cron error:", err.message);
    return 0;
  }
}
