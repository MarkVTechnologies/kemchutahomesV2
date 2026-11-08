/**
 * test/clientEmailVerification.test.js
 * Subscriptions, investments and inspections are matched to clients by email,
 * so a new account must prove it owns the address before seeing them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.js";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/notifications.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendEmail,
}));
vi.mock("../utils/email.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendClientWelcomeEmail: vi.fn().mockResolvedValue(undefined),
}));

import Client from "../models/client.model.js";
import RefreshToken from "../models/RefreshToken.model.js";
import {
  getClientDashboard,
  registerClient,
  resetPassword,
  showVerifyEmailPage,
  verifyEmail,
} from "../controllers/client.controller.js";
import {
  getMySubscriptionById,
  getMySubscriptions,
} from "../controllers/subscription.controller.js";
import { getMyInvestments } from "../controllers/Buy2sell.controller.js";
import { protectClient } from "../middlewares/authMiddleware.js";
import { mockReq, mockRes } from "./mockExpress.js";
import { makeSubscription } from "./fixtures.js";

process.env.JWT_SECRET ||= "test-secret";

const htmlRes = () => {
  const res = mockRes();
  res.send = function (body) {
    this.body = body;
    return this;
  };
  return res;
};

const makeClient = (email, extra = {}) =>
  Client.create({
    firstName: "T",
    lastName: "C",
    email,
    passwordHash: "x",
    ...extra,
  });

const tokenFromEmail = () => {
  const html = sendEmail.mock.calls.at(-1)[0].html;
  return html.match(/token=([a-f0-9]{64})/)[1];
};

const registerAndGetToken = async (email) => {
  sendEmail.mockClear();
  const res = mockRes();
  await registerClient(
    mockReq({ body: { firstName: "N", lastName: "C", email, password: "Abcd12345" } }),
    res,
  );
  expect(res.statusCode).toBe(201);
  await vi.waitFor(() => expect(sendEmail).toHaveBeenCalled());
  return { res, token: tokenFromEmail() };
};

describe("unverified client accounts", () => {
  it("see nothing matched to the email", async () => {
    const email = "victim-1@example.com";
    const sub = await makeSubscription({ email, status: "confirmed" });
    const user = { id: "000000000000000000000001", email, role: "client", emailVerified: false };

    const dash = mockRes();
    await getClientDashboard({ user }, dash);
    expect(dash.body.emailVerified).toBe(false);
    expect(dash.body.stats.totalSubscriptions).toBe(0);

    const list = mockRes();
    await getMySubscriptions({ user }, list);
    expect(list.body).toEqual([]);

    const one = mockRes();
    await getMySubscriptionById({ user, params: { id: String(sub._id) } }, one);
    expect(one.statusCode).toBe(404);

    const investments = mockRes();
    await getMyInvestments({ user }, investments);
    expect(investments.body).toEqual([]);
  });

  it("older accounts with no value keep working", async () => {
    const email = "legacy-1@example.com";
    await makeSubscription({ email, status: "confirmed" });
    const dash = mockRes();
    await getClientDashboard({ user: { email } }, dash);
    expect(dash.body.emailVerified).toBe(true);
    expect(dash.body.stats.totalSubscriptions).toBe(1);
  });
});

describe("verification link", () => {
  beforeEach(() => sendEmail.mockClear());

  it("registers unverified, and only POST verifies", async () => {
    const email = "new-1@example.com";
    const { res, token } = await registerAndGetToken(email);
    expect(res.body.user.emailVerified).toBe(false);

    const page = htmlRes();
    showVerifyEmailPage({ query: { token } }, page);
    expect(page.body).toContain("<form");
    expect((await Client.findOne({ email })).emailVerified).toBe(false);

    const done = htmlRes();
    await verifyEmail({ query: { token } }, done);
    expect(done.statusCode).toBe(200);
    const client = await Client.findOne({ email });
    expect(client.emailVerified).toBe(true);
    expect(client.emailVerifyToken).toBeUndefined();

    const replay = htmlRes();
    await verifyEmail({ query: { token } }, replay);
    expect(replay.statusCode).toBe(400);
  });

  it("rejects an expired link", async () => {
    const email = "new-2@example.com";
    const { token } = await registerAndGetToken(email);
    await Client.updateOne({ email }, { emailVerifyExpiry: new Date(Date.now() - 1000) });
    const res = htmlRes();
    await verifyEmail({ query: { token } }, res);
    expect(res.statusCode).toBe(400);
    expect((await Client.findOne({ email })).emailVerified).toBe(false);
  });

  it("rejects a malformed token on the page", () => {
    const res = htmlRes();
    showVerifyEmailPage({ query: { token: '"><script>' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("<script>");
  });
});

describe("real owner claiming an account by password reset", () => {
  const resetToken = "a".repeat(64);
  const prepare = (email, extra) =>
    makeClient(email, {
      emailVerified: false,
      resetPasswordToken: crypto.createHash("sha256").update(resetToken).digest("hex"),
      resetPasswordExpiry: new Date(Date.now() + 60000),
      ...extra,
    });

  it("verifies the account and ends the earlier sessions", async () => {
    const email = "squatted-1@example.com";
    const client = await prepare(email);
    const oldToken = jwt.sign(
      { id: client._id, role: "client", iat: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET,
    );
    await RefreshToken.create({
      tokenHash: "squatter-refresh",
      principalType: "client",
      principalId: client._id,
      expiresAt: new Date(Date.now() + 60000),
    });

    const res = mockRes();
    await resetPassword(mockReq({ body: { token: resetToken, password: "NewPass1234" } }), res);
    expect(res.statusCode).toBe(200);
    expect((await Client.findOne({ email })).emailVerified).toBe(true);
    expect((await RefreshToken.findOne({ tokenHash: "squatter-refresh" })).revokedAt).toBeTruthy();

    const authRes = mockRes();
    const next = vi.fn();
    await protectClient(
      mockReq({ headers: { authorization: `Bearer ${oldToken}` } }),
      authRes,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(authRes.statusCode).toBe(401);

    const fresh = jwt.sign({ id: client._id, role: "client" }, process.env.JWT_SECRET);
    const freshNext = vi.fn();
    await protectClient(
      mockReq({ headers: { authorization: `Bearer ${fresh}` } }),
      mockRes(),
      freshNext,
    );
    expect(freshNext).toHaveBeenCalled();
  });
});
