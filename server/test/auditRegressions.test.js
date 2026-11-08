/**
 * Regression tests for the November 2026 backend audit. Each block pins one
 * bug that was fixed, against the document shapes production actually holds
 * (older realtors with no birthDate/loginAttempts, clients with blank phones).
 */
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import "./setup.js";

const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/notifications.js", () => ({
  sendEmail,
  sendSMS: vi.fn().mockResolvedValue(undefined),
  notifyRealtorWelcomeSMS: vi.fn().mockResolvedValue(undefined),
  notifyUplineOfNewRecruit: vi.fn().mockResolvedValue(undefined),
  notifyRealtorCommissionPaid: vi.fn().mockResolvedValue(undefined),
  notifyRealtorCommissionClawedback: vi.fn().mockResolvedValue(undefined),
  notifyInspectionBooked: vi.fn().mockResolvedValue(undefined),
  notifyInspectionStatusChanged: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/pdfGenerator.js", () => {
  const pdf = vi.fn().mockResolvedValue(Buffer.from("pdf"));
  return {
    generateAcknowledgement: pdf,
    generateContractOfSale: pdf,
    generatePaymentInvoice: pdf,
    generateInstallmentSchedule: pdf,
    generateReceipt: pdf,
    generateAllocationLetter: pdf,
    generateDeedOfAssignment: pdf,
    generateInvestmentCertificate: pdf,
    generateInvestmentAgreement: pdf,
    generatePayoutConfirmation: pdf,
  };
});

import bcrypt from "bcryptjs";
import crypto from "crypto";
import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import { mockReq, mockRes } from "./mockExpress.js";
import { makeBuy2SellLead, makeClient, makeEstate, makeRealtor, makeSubscription } from "./fixtures.js";
import Realtor from "../models/realtor.model.js";
import Client from "../models/client.model.js";
import Admin from "../models/admin.js";
import { Commission, CommissionTier } from "../models/Commission.model.js";
import { realtorSignupSchema } from "../schemas/realtor.schema.js";
import { estateQuerySchema } from "../schemas/estate.schema.js";
import { parsePagination } from "../utils/pagination.js";
import { validate } from "../middlewares/validate.js";
import { withUploadErrors } from "../middlewares/upload.middleware.js";
import { z } from "zod";
import { signup, changeMyPassword } from "../controllers/realtor.controller.js";
import { registerClient, loginClient } from "../controllers/client.controller.js";
import { completeAdminSetup } from "../controllers/adminManagement.controller.js";
import {
  allocatePlot,
  confirmPayment,
  confirmSubscription,
  createSubscription,
  downloadDocument,
  recordPayment,
  updateSubscriptionStatus,
} from "../controllers/subscription.controller.js";
import {
  downloadDocument as downloadLeadDocument,
  markMatured,
  processPayout,
  recordPayment as recordLeadPayment,
} from "../controllers/Buy2sell.controller.js";
import { getMyCommissions } from "../controllers/commission.controller.js";
import { calculateCommissions } from "../utils/commissionCalculator.js";
import { buildSystemPrompt } from "../controllers/chat.controller.js";
import realtorRoutes from "../routes/realtor.routes.js";
import inspectionRoutes from "../routes/inspection.routes.js";

process.env.JWT_SECRET ||= "test-secret";

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const admin = { id: "admin", email: "a@example.com", role: "superadmin" };
const idOf = (doc) => doc._id.toString();

// Downloads end with res.set()/res.end(), which the shared double doesn't have.
const downloadRes = () => Object.assign(mockRes(), { set() {}, end() {} });

const signupBody = {
  firstName: "Ada",
  lastName: "Okafor",
  email: "ada@example.com",
  phone: "08012345678",
  birthDate: "1992-05-04",
  password: "Str0ngPassw0rd!",
};

async function doSignup(overrides = {}) {
  const res = mockRes();
  const body = realtorSignupSchema.parse({ ...signupBody, ...overrides });
  await signup(mockReq({ method: "POST", body }), res);
  return res;
}

// Inserted past Mongoose, so required fields and defaults are really absent.
async function insertLegacyRealtor(fields) {
  const _id = new mongoose.Types.ObjectId();
  await Realtor.collection.insertOne({
    _id,
    firstName: "Old",
    lastName: "Timer",
    email: `old-${_id}@example.com`,
    phone: "0801",
    referralCode: `old${_id}`,
    role: "realtor",
    ...fields,
  });
  return _id;
}

describe("realtor birth date formats (the registration 400)", () => {
  const parse = (birthDate) =>
    realtorSignupSchema.safeParse({ ...signupBody, birthDate });
  const iso = (birthDate) => parse(birthDate).data.birthDate.toISOString().slice(0, 10);

  it("accepts day-first dates that used to be rejected", () => {
    expect(iso("25/12/1990")).toBe("1990-12-25");
    expect(iso("25-12-1990")).toBe("1990-12-25");
    expect(iso("25.12.1990")).toBe("1990-12-25");
  });

  it("still accepts ISO and unambiguous month-first dates", () => {
    expect(iso("1990-12-25")).toBe("1990-12-25");
    expect(iso("1990/12/25")).toBe("1990-12-25");
    expect(iso("12/25/1990")).toBe("1990-12-25");
  });

  it("reads an ambiguous date as day-first", () => {
    expect(iso("04/05/1990")).toBe("1990-05-04");
  });

  it("reads two-digit years without guessing month-first", () => {
    expect(iso("93-02-20")).toBe("1993-02-20");
    expect(iso("20-02-93")).toBe("1993-02-20");
    expect(iso("25/12/90")).toBe("1990-12-25");
    expect(iso("05-06-93")).toBe("1993-06-05");
    expect(iso("12/05/05")).toBe("2005-05-12");
  });

  it("accepts the other ways people type a date", () => {
    expect(iso("25121990")).toBe("1990-12-25");
    expect(iso("19901225")).toBe("1990-12-25");
    expect(iso("251290")).toBe("1990-12-25");
    expect(iso("25th December 1990")).toBe("1990-12-25");
    expect(iso("25th Dec, 1990")).toBe("1990-12-25");
    expect(iso("December 25, 1990")).toBe("1990-12-25");
    expect(iso("25 / 12 / 1990")).toBe("1990-12-25");
    expect(iso("25,12,1990")).toBe("1990-12-25");
    expect(iso("1990-25-12")).toBe("1990-12-25");
  });

  it("rejects impossible, future and unreadable dates with a clear message", () => {
    expect(parse("31/02/1990").success).toBe(false);
    expect(parse("2999-01-01").error.issues[0].message).toMatch(/future/);
    expect(parse("my birthday").error.issues[0].message).toMatch(/valid date of birth/);
  });
});

describe("validate() error body", () => {
  const run = (schema, body) => {
    const res = mockRes();
    validate(schema)(mockReq({ body }), res, () => {});
    return res;
  };

  it("puts the real field message in `message` and keeps `errors`", () => {
    const res = run(realtorSignupSchema, { ...signupBody, birthDate: "nope" });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/valid date of birth/);
    expect(res.body.errors[0].path).toBe("birthDate");
  });

  it("names the field when zod's own wording doesn't", () => {
    const res = run(z.object({ plan: z.enum(["a"]) }), { plan: "b" });
    expect(res.body.message).toMatch(/^plan: /);
  });
});

describe("realtor signup on an existing email", () => {
  it("succeeds without a new account when the password matches", async () => {
    expect((await doSignup()).statusCode).toBe(201);
    const res = await doSignup();
    expect(res.statusCode).toBe(200);
    expect(res.body.user.referralCode).toBeTruthy();
    expect(await Realtor.countDocuments({ email: signupBody.email })).toBe(1);
  });

  it("is a clear 400 and counts toward lockout when the password differs", async () => {
    await doSignup();
    const res = await doSignup({ password: "SomethingElse1!" });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/already registered/);
    const saved = await Realtor.findOne({ email: signupBody.email });
    expect(saved.loginAttempts).toBe(1);
  });

  it("will not confirm a password while the account is locked", async () => {
    await doSignup();
    await Realtor.updateOne(
      { email: signupBody.email },
      { lockUntil: new Date(Date.now() + 60_000) },
    );
    expect((await doSignup()).statusCode).toBe(400);
  });

  it("allows the same email on a client account", async () => {
    await makeClient({ email: signupBody.email });
    expect((await doSignup()).statusCode).toBe(201);
  });
});

describe("referral codes", () => {
  it("match regardless of case", async () => {
    const recruiter = await makeRealtor({ referralCode: "kem00734" });
    expect((await doSignup({ ref: "KEM00734" })).statusCode).toBe(201);
    const saved = await Realtor.findOne({ email: signupBody.email });
    expect(String(saved.recruitedBy)).toBe(idOf(recruiter));
  });

  it("are not treated as a pattern", async () => {
    await makeRealtor({ referralCode: "kem00734" });
    const res = await doSignup({ ref: "kem.*" });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/referral code/);
  });
});

describe("older documents", () => {
  it("lets a realtor with no birthDate change password", async () => {
    const passwordHash = await bcrypt.hash("OldPassword1!", 4);
    const id = await insertLegacyRealtor({ passwordHash });
    const res = mockRes();
    await changeMyPassword(
      mockReq({
        user: { id: String(id) },
        body: { currentPassword: "OldPassword1!", newPassword: "NewPassword1!" },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });

  it("does not treat a client with no isActive as disabled", async () => {
    const passwordHash = await bcrypt.hash("OldPassword1!", 4);
    await Client.collection.insertOne({
      firstName: "Old",
      lastName: "Client",
      email: "old-client@example.com",
      phone: "0801",
      passwordHash,
    });
    const res = mockRes();
    await loginClient(
      mockReq({ body: { email: "old-client@example.com", password: "OldPassword1!" } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("registers a client who left phone blank", async () => {
    const res = mockRes();
    await registerClient(
      mockReq({
        body: { firstName: "A", lastName: "B", email: "nophone@example.com", password: "Passw0rd!!" },
      }),
      res,
    );
    expect(res.statusCode).toBe(201);
  });
});

describe("admin setup link", () => {
  it("cannot reactivate a suspended admin", async () => {
    const token = "reset-token";
    const suspended = await Admin.create({
      email: "s@example.com",
      password: "Passw0rd!!",
      status: "suspended",
      resetPasswordToken: crypto.createHash("sha256").update(token).digest("hex"),
      resetPasswordExpiry: Date.now() + 60_000,
    });
    const res = mockRes();
    await completeAdminSetup(mockReq({ body: { token, password: "NewPassw0rd!" } }), res);
    expect(res.statusCode).toBe(400);
    expect((await Admin.findById(suspended._id)).status).toBe("suspended");
  });
});

describe("subscription workflow", () => {
  const params = (sub, extra = {}) => ({ id: idOf(sub), ...extra });
  const paid = (amount, confirmed = false) => ({ amount, paidAt: new Date(), confirmed });

  it("keeps a valid status past six confirmed payments", async () => {
    const sub = await makeSubscription({
      paymentPlan: "Instalment",
      instalmentMonths: 6,
      status: "inst_6_paid",
      payments: [...Array(6).fill(0).map(() => paid(100, true)), paid(100)],
    });
    const res = mockRes();
    await confirmPayment(
      { params: params(sub, { paymentId: idOf(sub.payments[6]) }), user: admin },
      res,
    );
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.body.subscription.status).toBe("inst_6_paid");
  });

  it("does not undo an allocation when a late payment is confirmed", async () => {
    const sub = await makeSubscription({
      status: "allocated",
      totalAmount: 100,
      amountPaid: 100,
      payments: [paid(100, true), paid(10)],
    });
    const res = mockRes();
    await confirmPayment(
      { params: params(sub, { paymentId: idOf(sub.payments[1]) }), user: admin },
      res,
    );
    await flush();
    expect(res.body.subscription.status).toBe("allocated");
  });

  it("answers 400 for a malformed payment id", async () => {
    const sub = await makeSubscription();
    const res = mockRes();
    await confirmPayment({ params: params(sub, { paymentId: "nope" }), user: admin }, res);
    expect(res.statusCode).toBe(400);
  });

  it("refuses payments on a rejected subscription", async () => {
    const sub = await makeSubscription({ status: "rejected", payments: [paid(10)] });
    const logged = mockRes();
    await recordPayment({ params: params(sub), body: { amount: 10 }, user: admin }, logged);
    expect(logged.statusCode).toBe(400);
    const confirmed = mockRes();
    await confirmPayment(
      { params: params(sub, { paymentId: idOf(sub.payments[0]) }), user: admin },
      confirmed,
    );
    expect(confirmed.statusCode).toBe(400);
  });

  it("cannot allocate an unpaid subscription", async () => {
    const sub = await makeSubscription({ status: "pending" });
    const res = mockRes();
    await allocatePlot({ params: params(sub), body: { plotNumber: "B-1" } }, res);
    expect(res.statusCode).toBe(400);
  });

  it("cannot move a paying subscription back to confirmed or pending", async () => {
    const sub = await makeSubscription({ status: "inst_2_paid" });
    const viaConfirm = mockRes();
    await confirmSubscription({ params: params(sub), user: admin }, viaConfirm);
    expect(viaConfirm.statusCode).toBe(400);
    const viaStatus = mockRes();
    await updateSubscriptionStatus(
      { params: params(sub), body: { status: "pending" }, user: admin },
      viaStatus,
    );
    expect(viaStatus.statusCode).toBe(400);
  });

  it("still lets an admin reject and confirm a new subscription", async () => {
    const sub = await makeSubscription();
    const res = mockRes();
    await confirmSubscription({ params: params(sub), user: admin }, res);
    await flush();
    expect(res.body.subscription.status).toBe("confirmed");
  });

  it("escapes public form values in the emails they reach", async () => {
    sendEmail.mockClear();
    const sub = await makeSubscription();
    const { _id, referenceNumber, __v, createdAt, updatedAt, id, ...body } = sub.toObject();
    const res = mockRes();
    await createSubscription(
      { body: { ...body, firstName: '<a href="http://evil">Win</a>' } },
      res,
    );
    await flush();
    expect(res.statusCode).toBe(201);
    const html = sendEmail.mock.calls.map(([mail]) => mail.html).join("");
    expect(html).toContain("&lt;a href=");
    expect(html).not.toContain('<a href="http://evil"');
  });
});

describe("subscription document downloads", () => {
  const download = async (sub, docType, user) => {
    const res = downloadRes();
    await downloadDocument({ params: { id: idOf(sub), docType }, user }, res);
    return res;
  };
  const clientFor = (sub) => ({ role: "client", email: sub.email });

  it("hides a deed that hasn't been issued from its owner", async () => {
    const sub = await makeSubscription();
    expect((await download(sub, "deed", clientFor(sub))).statusCode).toBe(404);
    expect((await download(sub, "contract", clientFor(sub))).statusCode).toBe(404);
  });

  it("serves issued and always-available documents to the owner", async () => {
    const sub = await makeSubscription({
      documents: [{ type: "contract", label: "Contract of Sale" }],
    });
    expect((await download(sub, "contract", clientFor(sub))).statusCode).toBe(200);
    expect((await download(sub, "invoice", clientFor(sub))).statusCode).toBe(200);
  });

  it("applies section permissions to regular admins", async () => {
    const sub = await makeSubscription();
    const denied = await download(sub, "invoice", { role: "admin", permissions: [] });
    expect(denied.statusCode).toBe(403);
    const allowed = await download(sub, "deed", {
      role: "admin",
      permissions: ["manage_subscriptions"],
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("Buy2Sell lifecycle", () => {
  const paramsOf = (lead) => ({ id: idOf(lead) });

  it("pays out a matured investment exactly once", async () => {
    const lead = await makeBuy2SellLead({ status: "matured", expectedPayout: 500 });
    const run = async () => {
      const res = mockRes();
      await processPayout({ params: paramsOf(lead), body: {}, user: admin }, res);
      return res;
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);
  });

  it("will not pay out an investment that hasn't matured", async () => {
    const lead = await makeBuy2SellLead({ status: "pending" });
    const res = mockRes();
    await processPayout({ params: paramsOf(lead), body: {}, user: admin }, res);
    expect(res.statusCode).toBe(400);
  });

  it("will not mature an investment that is already paid out", async () => {
    const lead = await makeBuy2SellLead({ status: "paid_out" });
    const res = mockRes();
    await markMatured({ params: paramsOf(lead) }, res);
    expect(res.statusCode).toBe(400);
  });

  it("does not re-send activation for an extra payment", async () => {
    const lead = await makeBuy2SellLead({
      status: "active",
      principalAmount: 100,
      amountPaid: 100,
      investmentDate: new Date(),
    });
    sendEmail.mockClear();
    const res = mockRes();
    await recordLeadPayment({ params: paramsOf(lead), body: { amount: 5 }, user: admin }, res);
    expect(res.statusCode).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("withholds certificates until the investment is active", async () => {
    const lead = await makeBuy2SellLead({ status: "pending" });
    const user = { role: "client", email: lead.email };
    const fetchDoc = async (docType) => {
      const res = downloadRes();
      await downloadLeadDocument({ params: { ...paramsOf(lead), docType }, user }, res);
      return res.statusCode;
    };
    expect(await fetchDoc("certificate")).toBe(404);
    expect(await fetchDoc("payout_confirmation")).toBe(404);
    expect(await fetchDoc("agreement")).toBe(200);
  });
});

describe("commissions", () => {
  it("honours a 0% withholding tax rate", async () => {
    await CommissionTier.findOneAndUpdate(
      { singleton: "global" },
      { whtPercent: 0 },
      { upsert: true },
    );
    const realtor = await makeRealtor();
    const sub = await makeSubscription({ realtorId: realtor._id, totalAmount: 1000 });
    await calculateCommissions(sub._id, realtor._id);
    const commission = await Commission.findOne({ subscriptionId: sub._id });
    expect(commission.whtAmount).toBe(0);
    expect(commission.netAmount).toBe(commission.grossAmount);
  });

  it("survives a non-numeric limit", async () => {
    const realtor = await makeRealtor();
    const res = mockRes();
    await getMyCommissions(
      mockReq({ user: { id: idOf(realtor), role: "realtor" }, query: { limit: "abc" } }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });
});

describe("pagination and query limits", () => {
  it("clamps bad values", () => {
    expect(parsePagination({ page: "-3", limit: "abc" })).toEqual({ page: 1, limit: 20, skip: 0 });
    expect(parsePagination({ limit: "0" }).limit).toBe(20);
    expect(parsePagination({ limit: "99999" }).limit).toBe(1000);
    expect(parsePagination({ page: "3", limit: "10" }).skip).toBe(20);
  });

  it("allows the limit the web sitemap asks for", () => {
    expect(estateQuerySchema.safeParse({ limit: "1000" }).success).toBe(true);
  });
});

describe("AI chat prompt", () => {
  it("leaves out deactivated estates", async () => {
    await makeEstate({ estate: "Live Gardens", isActive: true });
    await makeEstate({ estate: "Retired Gardens", isActive: false });
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("Live Gardens");
    expect(prompt).not.toContain("Retired Gardens");
  });
});

describe("upload errors", () => {
  const run = (error) => {
    const res = mockRes();
    const next = vi.fn();
    withUploadErrors((req, r, cb) => cb(error))({}, res, next);
    return { res, next };
  };

  it("reports oversized files as 413 and wrong types as 400", () => {
    expect(run(new multer.MulterError("LIMIT_FILE_SIZE")).res.statusCode).toBe(413);
    expect(run(Object.assign(new Error("Only image files are allowed"), { status: 400 })).res.statusCode).toBe(400);
  });

  it("passes other errors on", () => {
    expect(run(new Error("boom")).next).toHaveBeenCalled();
  });
});

describe("routes over HTTP", () => {
  let server;
  let base;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/realtors", realtorRoutes);
    app.use("/api/inspections", inspectionRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("answers 400 for a malformed realtor id", async () => {
    const res = await fetch(`${base}/api/realtors/not-an-id`);
    expect(res.status).toBe(400);
  });

  it("rate limits the public inspection form", async () => {
    const post = () =>
      fetch(`${base}/api/inspections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await post()).status);
    expect(statuses[0]).toBe(400);
    expect(statuses[30]).toBe(429);
  });
});
