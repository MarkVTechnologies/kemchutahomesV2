/**
 * controllers/commission.controller.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles the 4-level MLM commission system for KHL realtors, across both
 * commission-generating products (Lands/Subscriptions and Buy2Sell).
 *
 * Commission chain:
 *   Level 1 → the realtor who made the direct sale
 *   Level 2 → Level 1's recruiter (recruitedBy)
 *   Level 3 → Level 2's recruiter
 *   Level 4 → Level 3's recruiter
 *
 * WHT (Withholding Tax) deducted from each commission before payout, at the
 * admin-configured rate. Clawback: automatic on subscription rejection
 * (clawbackCommissions), or manual via clawbackCommission below — the only
 * reversal path for Buy2Sell, which has no rejected/cancelled state.
 *
 * Calculation itself (calculateCommissions, calculateBuy2SellCommissions,
 * clawbackCommissions, clawbackCommissionById, finalisePendingCommissions,
 * getTiers) lives in ../utils/commissionCalculator.js — imported directly by
 * subscription.controller.js / Buy2sell.controller.js / followUp.js, not
 * re-exported from here.
 */

import { isValidObjectId, Types } from "mongoose";
import { Commission, CommissionTier } from "../models/Commission.model.js";
import { getTiers, clawbackCommissionById } from "../utils/commissionCalculator.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { parsePagination } from "../utils/pagination.js";
import {
  notifyRealtorCommissionPaid,
  notifyRealtorCommissionClawedback,
} from "../utils/notifications.js";

// ── :id guard ────────────────────────────────────────────────────────────────
const rejectedInvalidId = (req, res) => {
  if (isValidObjectId(req.params.id)) return false;
  res.status(400).json({ message: "Invalid commission ID" });
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP CONTROLLERS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/commissions — admin: all commissions with filters
export const getAllCommissions = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, realtorId, level, sourceType, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (realtorId && isValidObjectId(realtorId)) filter.realtorId = realtorId;
    if (level && [1, 2, 3, 4].includes(Number(level))) filter.level = Number(level);
    if (sourceType === "subscription" || sourceType === "buy2sell") filter.sourceType = sourceType;
    if (search) {
      const safeSearch = escapeRegex(String(search).slice(0, 100));
      filter.$or = [
        { realtorName: { $regex: safeSearch, $options: "i" } },
        { realtorEmail: { $regex: safeSearch, $options: "i" } },
        { referenceNumber: { $regex: safeSearch, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [commissions, total] = await Promise.all([
      Commission.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate(
          "realtorId",
          "firstName lastName email phone bank accountName accountNumber",
        )
        .lean(),
      Commission.countDocuments(filter),
    ]);

    // Summary aggregates now respect the active realtor/level/product/search
    // scope (status itself is deliberately excluded from the scope so all
    // four status buckets remain visible together) — previously these were
    // always system-wide regardless of what the admin had filtered to,
    // so the stat cards could never be made to agree with the table below
    // them. whtAmount is aggregated across the same scope for tax-remittance
    // reporting, which previously had no rollup anywhere.
    const { status: _ignoredStatus, ...scopedFilter } = filter;
    const sumBy = (extra) => [
      { $match: { ...scopedFilter, ...extra } },
      { $group: { _id: null, total: { $sum: "$netAmount" } } },
    ];
    const [pending, approved, paid, clawedback, wht] = await Promise.all([
      Commission.aggregate(sumBy({ status: "pending" })),
      Commission.aggregate(sumBy({ status: "approved" })),
      Commission.aggregate(sumBy({ status: "paid" })),
      Commission.aggregate(sumBy({ status: "clawedback" })),
      Commission.aggregate([
        { $match: scopedFilter },
        { $group: { _id: null, total: { $sum: "$whtAmount" } } },
      ]),
    ]);

    res.json({
      commissions,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      summary: {
        pendingAmount: pending[0]?.total || 0,
        approvedAmount: approved[0]?.total || 0,
        paidAmount: paid[0]?.total || 0,
        clawedbackAmount: clawedback[0]?.total || 0,
        whtAmount: wht[0]?.total || 0,
      },
    });
  } catch (err) {
    console.error("getAllCommissions:", err);
    res.status(500).json({ message: "Failed to fetch commissions" });
  }
};

// GET /api/commissions/my — realtor: their own commissions
export const getMyCommissions = async (req, res) => {
  try {
    if (req.user?.role !== "realtor") {
      return res.status(403).json({ message: "Realtor account required." });
    }
    const realtorId = req.user?._id || req.user?.id;
    const { status, sourceType } = req.query;
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { realtorId };
    if (status) filter.status = status;
    if (sourceType === "subscription" || sourceType === "buy2sell") filter.sourceType = sourceType;

    const [commissions, total] = await Promise.all([
      Commission.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Commission.countDocuments(filter),
    ]);

    const oid = new Types.ObjectId(String(realtorId));
    const sourceMatch = filter.sourceType ? { sourceType: filter.sourceType } : {};

    const [totals, levelTotals] = await Promise.all([
      Commission.aggregate([
        { $match: { realtorId: oid, ...sourceMatch } },
        {
          $group: {
            _id: "$status",
            totalNet: { $sum: "$netAmount" },
            totalGross: { $sum: "$grossAmount" },
            count: { $sum: 1 },
          },
        },
      ]),
      // Server-side per-level breakdown — the client previously computed
      // this from whatever page happened to be loaded (15 rows), silently
      // wrong the moment there was more than one page. Clawed-back
      // commissions are excluded, matching "Total Earned" excluding them too:
      // money that was reversed was never actually earned. Respects the same
      // product filter as the list itself, so switching to "Buy2Sell" also
      // updates this breakdown instead of leaving it Lands-inclusive.
      Commission.aggregate([
        { $match: { realtorId: oid, ...sourceMatch, status: { $ne: "clawedback" } } },
        { $group: { _id: "$level", total: { $sum: "$netAmount" }, count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      commissions,
      total,
      page,
      pages: Math.ceil(total / limit),
      totals,
      levelTotals,
    });
  } catch (err) {
    console.error("getMyCommissions:", err);
    res.status(500).json({ message: "Failed to fetch commissions" });
  }
};

// PATCH /api/commissions/:id/pay — admin marks a single commission as paid
export const markCommissionPaid = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { paymentRef, note } = req.body;
    // Requiring status: "approved" here is the fix — without it this endpoint
    // could mark a pending commission paid (skipping the clawback window
    // entirely), resurrect an already-clawed-back one, or silently overwrite
    // the paidAt/paidBy/paymentRef audit trail of an already-paid one. The
    // batch endpoint below already had this guard; the single-pay path didn't.
    const commission = await Commission.findOneAndUpdate(
      { _id: req.params.id, status: "approved" },
      {
        status: "paid",
        paidAt: new Date(),
        paidBy: req.user?.email || "admin",
        paymentRef: paymentRef || "",
        ...(note && { notes: note }),
      },
      { new: true },
    );
    if (!commission) {
      const exists = await Commission.exists({ _id: req.params.id });
      if (!exists) return res.status(404).json({ message: "Commission not found" });
      return res.status(400).json({
        message: "Only approved commissions can be marked paid.",
      });
    }

    // Fire-and-forget — never let a slow/failed email hold up the response.
    notifyRealtorCommissionPaid({
      realtorEmail: commission.realtorEmail,
      realtorName: commission.realtorName,
      netAmount: commission.netAmount,
      saleLabel: commission.saleLabel || commission.estateName,
      paymentRef: commission.paymentRef,
    }).catch(() => null);

    res.json({ message: "Commission marked as paid", commission });
  } catch (err) {
    res.status(500).json({ message: "Failed to update commission" });
  }
};

// PATCH /api/commissions/:id/clawback — admin manually reverses a commission
// The only reversal path for Buy2Sell (no rejected/cancelled state to hang an
// automatic clawback off), and also covers Lands cases the automatic
// subscription-rejection clawback doesn't reach: a defaulted instalment plan,
// a duplicate, or a mis-attributed realtor.
export const clawbackCommission = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { reason } = req.body;
    const commission = await clawbackCommissionById(req.params.id, reason, req.user?.email);
    if (!commission) {
      const exists = await Commission.exists({ _id: req.params.id });
      if (!exists) return res.status(404).json({ message: "Commission not found" });
      return res.status(400).json({
        message: "Only pending or approved commissions can be clawed back.",
      });
    }

    notifyRealtorCommissionClawedback({
      realtorEmail: commission.realtorEmail,
      realtorName: commission.realtorName,
      netAmount: commission.netAmount,
      saleLabel: commission.saleLabel || commission.estateName,
      reason: commission.clawbackReason,
    }).catch(() => null);

    res.json({ message: "Commission clawed back", commission });
  } catch (err) {
    res.status(500).json({ message: "Failed to claw back commission" });
  }
};

// POST /api/commissions/pay-batch — admin pays multiple commissions at once
export const payCommissionBatch = async (req, res) => {
  try {
    const { ids, paymentRef } = req.body;
    if (!ids?.length)
      return res.status(400).json({ message: "No commission IDs provided" });

    // Snapshot which of the requested ids are actually payable *before* the
    // update — updateMany doesn't return the matched documents, and this is
    // what tells each realtor about their own payout afterward. The small
    // race window (a concurrent request changing one of these between this
    // read and the update below) is the same one the existing skip-count
    // reporting below already tolerates.
    const toPay = await Commission.find(
      { _id: { $in: ids }, status: "approved" },
      "realtorEmail realtorName netAmount saleLabel estateName",
    ).lean();

    const result = await Commission.updateMany(
      { _id: { $in: ids }, status: "approved" },
      {
        status: "paid",
        paidAt: new Date(),
        paidBy: req.user?.email || "admin",
        paymentRef: paymentRef || "",
      },
    );

    Promise.allSettled(
      toPay.map((c) =>
        notifyRealtorCommissionPaid({
          realtorEmail: c.realtorEmail,
          realtorName: c.realtorName,
          netAmount: c.netAmount,
          saleLabel: c.saleLabel || c.estateName,
          paymentRef,
        }),
      ),
    ).catch(() => null);

    // Some ids can legitimately fail to match (already paid/clawed back by
    // another admin, or by a concurrent request, between selection and
    // confirm) — report the real outcome instead of a blanket success
    // message so the admin doesn't reconcile against a payout that didn't
    // fully happen.
    const skipped = ids.length - result.modifiedCount;
    res.json({
      message:
        skipped > 0
          ? `${result.modifiedCount} of ${ids.length} commissions marked as paid — ${skipped} were no longer approved and were skipped.`
          : `${result.modifiedCount} commission${result.modifiedCount === 1 ? "" : "s"} marked as paid`,
      modifiedCount: result.modifiedCount,
      requestedCount: ids.length,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to batch-pay commissions" });
  }
};

// GET /api/commissions/tiers — get tier settings (admin: full read/write;
// realtors get read-only access via the same handler, gated in the route)
export const getCommissionTiers = async (req, res) => {
  try {
    const tiers = await getTiers();
    res.json(tiers);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch tier settings" });
  }
};

// PUT /api/commissions/tiers — admin updates tier settings
export const updateCommissionTiers = async (req, res) => {
  try {
    const {
      level1Percent,
      level2Percent,
      level3Percent,
      level4Percent,
      whtPercent,
      clawbackDays,
    } = req.body;

    const tiers = await CommissionTier.findOneAndUpdate(
      { singleton: "global" },
      {
        ...(level1Percent !== undefined && {
          level1Percent: Number(level1Percent),
        }),
        ...(level2Percent !== undefined && {
          level2Percent: Number(level2Percent),
        }),
        ...(level3Percent !== undefined && {
          level3Percent: Number(level3Percent),
        }),
        ...(level4Percent !== undefined && {
          level4Percent: Number(level4Percent),
        }),
        ...(whtPercent !== undefined && { whtPercent: Number(whtPercent) }),
        ...(clawbackDays !== undefined && {
          clawbackDays: Number(clawbackDays),
        }),
        updatedBy: req.user?.email || "admin",
      },
      { new: true, upsert: true },
    );
    res.json({ message: "Tier settings updated", tiers });
  } catch (err) {
    res.status(500).json({ message: "Failed to update tier settings" });
  }
};
