/**
 * utils/commissionCalculator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure commission calculation utilities.
 * Separated from commission.controller.js to avoid any import order issues.
 *
 * Usage in subscription.controller.js:
 *   import { calculateCommissions, clawbackCommissions } from "../utils/commissionCalculator.js";
 * Usage in Buy2sell.controller.js:
 *   import { calculateBuy2SellCommissions } from "../utils/commissionCalculator.js";
 */

import Realtor from "../models/realtor.model.js";
import Subscription from "../models/Subscription.model.js";
import { Buy2SellLead } from "../models/Buy2sell.model.js";
import { Commission, CommissionTier } from "../models/Commission.model.js";

// ── Get or seed commission tier settings ──────────────────────────────────────
// Atomic upsert — the previous findOne-then-create left a window where two
// concurrent first-ever sales could both miss the findOne and both attempt to
// create the unique "global" singleton; the loser threw E11000, was caught by
// calculateCommissions' blanket catch, and that sale's commissions were
// silently never created. findOneAndUpdate+upsert is a single atomic
// operation, so there is no window for two callers to both "win" a create.
export async function getTiers() {
  const tier = await CommissionTier.findOneAndUpdate(
    { singleton: "global" },
    { $setOnInsert: { singleton: "global" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return tier;
}

// ── Walk the recruitedBy chain up to 4 levels ─────────────────────────────────
// Guards against a cyclic or self-referential recruitedBy chain (e.g. a
// realtor record where recruitedBy points back to an ancestor already in the
// chain, whether from a data-entry mistake or deliberate abuse) — without the
// visited set, a 1-cycle lets the same realtor collect all 4 levels of
// commission on a single sale instead of just their own.
async function getHierarchy(startRealtorId) {
  const chain = [];
  const visited = new Set();
  let currentId = startRealtorId;

  for (let level = 1; level <= 4; level++) {
    if (!currentId) break;
    const key = String(currentId);
    if (visited.has(key)) break;
    visited.add(key);

    const realtor = await Realtor.findById(currentId)
      .select("firstName lastName email recruitedBy")
      .lean();
    if (!realtor) break;
    chain.push({ level, realtor });
    currentId = realtor.recruitedBy || null;
  }
  return chain;
}

// Shared math: gross/WHT/net for one hierarchy level. Identical formula for
// every commission-generating product — only the inputs (sale amount, tier
// percentages) differ.
function splitCommission(saleAmount, percent, whtPercent) {
  const grossAmount = Math.round((saleAmount * percent) / 100);
  // ?? not ||: an admin-configured rate of 0% must stay 0%.
  const whtAmount = Math.round((grossAmount * (whtPercent ?? 5)) / 100);
  const netAmount = grossAmount - whtAmount;
  return { grossAmount, whtAmount, netAmount };
}

// Creates one Commission document per hierarchy level for a sale, sharing the
// idempotency/cycle-guard/tier logic between products. `base` supplies the
// product-specific fields (sourceType + subscriptionId/buy2sellId + sale
// identifiers); `saleAmount` is the amount commission is computed against.
async function createCommissionChain({ realtorId, saleAmount, base }) {
  const tiers = await getTiers();
  const chain = await getHierarchy(realtorId);
  const directSellerId = chain[0]?.realtor._id;

  const percentMap = {
    1: tiers.level1Percent, // 10% — direct seller
    2: tiers.level2Percent, //  5% — recruiter
    3: tiers.level3Percent, //  3% — upline
    4: tiers.level4Percent, //  2% — top level
  };

  const finalAt = new Date();
  finalAt.setDate(finalAt.getDate() + (tiers.clawbackDays || 90));

  const created = [];

  for (const { level, realtor } of chain) {
    const percent = percentMap[level] ?? 0;
    if (percent === 0) continue;

    // Idempotent pre-check — the common case, avoids a needless duplicate-key
    // round trip. The partial unique indexes on the Commission model are the
    // real enforcement: two concurrent/retried calls can both pass this
    // check, so the create below still has to handle losing that race.
    const existing = await Commission.findOne({
      ...base,
      realtorId: realtor._id,
      level,
    });
    if (existing) {
      console.log(
        `ℹ️  Commission L${level} already exists for ${realtor.email} — skipped`,
      );
      continue;
    }

    const { grossAmount, whtAmount, netAmount } = splitCommission(
      saleAmount,
      percent,
      tiers.whtPercent,
    );

    try {
      const commission = await Commission.create({
        ...base,
        realtorId: realtor._id,
        realtorName: `${realtor.firstName} ${realtor.lastName}`,
        realtorEmail: realtor.email,
        saleAmount,
        level,
        percent,
        grossAmount,
        whtAmount,
        netAmount,
        directSellerId,
        status: "pending",
        finalAt,
      });
      created.push(commission);
      console.log(
        `✅ Commission L${level}: ${realtor.firstName} ${realtor.lastName}` +
          ` → NGN ${netAmount.toLocaleString("en-NG")} (${percent}% of ${saleAmount.toLocaleString("en-NG")})`,
      );
    } catch (err) {
      // A concurrent/retried call won the race and created this exact
      // {source, realtorId, level} commission between our pre-check and this
      // create — the unique index rejected the duplicate. That's the race
      // working as intended, not a real failure.
      if (err.code === 11000) {
        console.log(
          `ℹ️  Commission L${level} for ${realtor.email} created concurrently — skipped`,
        );
        continue;
      }
      throw err;
    }
  }

  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateCommissions — Lands / Subscriptions
// Called on the first confirmed payment against a subscription.
// Creates one Commission record per level in the hierarchy.
// ─────────────────────────────────────────────────────────────────────────────
export async function calculateCommissions(subscriptionId, realtorId) {
  try {
    if (!realtorId) {
      console.log(
        "ℹ️  No realtor linked to subscription — commissions skipped",
      );
      return [];
    }

    const sub = await Subscription.findById(subscriptionId).lean();
    if (!sub)
      throw new Error("Subscription not found for commission calculation");

    return await createCommissionChain({
      realtorId,
      saleAmount: sub.totalAmount,
      base: {
        sourceType: "subscription",
        subscriptionId,
        referenceNumber:
          sub.referenceNumber || sub._id.toString().slice(-8).toUpperCase(),
        saleLabel: sub.estateName,
        estateName: sub.estateName, // kept for back-compat with existing rows/queries
      },
    });
  } catch (err) {
    console.error("❌ calculateCommissions:", err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateBuy2SellCommissions — Buy2Sell investments
// Called when an investment reaches "active" (full principal received).
// Buy2Sell only activates once the full principal is in — unlike an
// instalment Subscription, there is no "commission on unpaid balance" risk
// here by construction. Mirrors calculateCommissions' math and hierarchy
// exactly, using the same shared CommissionTier settings.
// ─────────────────────────────────────────────────────────────────────────────
export async function calculateBuy2SellCommissions(leadId, realtorId) {
  try {
    if (!realtorId) {
      console.log(
        "ℹ️  No realtor linked to Buy2Sell investment — commissions skipped",
      );
      return [];
    }

    const lead = await Buy2SellLead.findById(leadId).lean();
    if (!lead)
      throw new Error("Buy2Sell investment not found for commission calculation");

    return await createCommissionChain({
      realtorId,
      saleAmount: lead.principalAmount,
      base: {
        sourceType: "buy2sell",
        buy2sellId: leadId,
        referenceNumber:
          lead.referenceNumber || lead._id.toString().slice(-8).toUpperCase(),
        saleLabel: `Buy2Sell — ${lead.duration}`,
      },
    });
  } catch (err) {
    console.error("❌ calculateBuy2SellCommissions:", err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// clawbackCommissions
// Called when subscription.status → "rejected"
// Voids all pending/approved commissions for the subscription.
// ─────────────────────────────────────────────────────────────────────────────
export async function clawbackCommissions(
  subscriptionId,
  reason = "Subscription reversed",
) {
  try {
    const result = await Commission.updateMany(
      { subscriptionId, status: { $in: ["pending", "approved"] } },
      {
        status: "clawedback",
        clawbackAt: new Date(),
        clawbackReason: reason,
      },
    );
    if (result.modifiedCount > 0) {
      console.log(
        `⚠️  ${result.modifiedCount} commission(s) clawed back for subscription ${subscriptionId} — reason: ${reason}`,
      );
    }
    return result;
  } catch (err) {
    console.error("❌ clawbackCommissions:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// clawbackCommissionById
// Manual, admin-triggered reversal of a single commission — the only
// reversal path for Buy2Sell (which has no rejected/cancelled state) and also
// covers Lands cases clawbackCommissions doesn't reach: a defaulted
// instalment plan, a duplicate, or a mis-attributed realtor. Guards against
// reversing an already-paid or already-clawed-back commission so a payout
// that already happened can never be silently undone.
// ─────────────────────────────────────────────────────────────────────────────
export async function clawbackCommissionById(commissionId, reason, clawedBackBy) {
  const commission = await Commission.findOneAndUpdate(
    { _id: commissionId, status: { $in: ["pending", "approved"] } },
    {
      status: "clawedback",
      clawbackAt: new Date(),
      clawbackReason: reason || "Manually reversed by admin",
      ...(clawedBackBy && { notes: `Clawed back by ${clawedBackBy}` }),
    },
    { new: true },
  );
  return commission;
}

// ─────────────────────────────────────────────────────────────────────────────
// finalisePendingCommissions  (daily cron — called from followUp.js)
// Approves any "pending" commissions whose clawback window has expired.
// ─────────────────────────────────────────────────────────────────────────────
export async function finalisePendingCommissions() {
  try {
    const result = await Commission.updateMany(
      { status: "pending", finalAt: { $lte: new Date() } },
      { status: "approved" },
    );
    if (result.modifiedCount > 0) {
      console.log(
        `✅ Cron: ${result.modifiedCount} commission(s) finalised (clawback window expired)`,
      );
    }
    return result;
  } catch (err) {
    console.error("❌ finalisePendingCommissions:", err.message);
    return null;
  }
}
