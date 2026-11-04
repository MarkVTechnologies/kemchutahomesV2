/**
 * test/realtorSignup.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Realtor signup: the optional `country` (added for the mobile app's
 * country → state picker) is stored and returned in the profile snapshot,
 * and a referral code sent as `ref` links the new realtor to the recruiter.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/notifications.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSMS: vi.fn().mockResolvedValue(undefined),
  notifyRealtorWelcomeSMS: vi.fn().mockResolvedValue(undefined),
  notifyUplineOfNewRecruit: vi.fn().mockResolvedValue(undefined),
}));

import "./setup.js";
import { mockReq, mockRes } from "./mockExpress.js";
import { makeRealtor } from "./fixtures.js";
import Realtor from "../models/realtor.model.js";
import { signup, updateMyBank } from "../controllers/realtor.controller.js";
import { realtorSignupSchema } from "../schemas/realtor.schema.js";

const baseBody = {
  firstName: "Ada",
  lastName: "Okafor",
  email: "ada.okafor@example.com",
  phone: "08012345678",
  state: "Greater Accra",
  bank: "Kuda Bank",
  accountName: "Ada Okafor",
  accountNumber: "0123456789",
  password: "Str0ngPassw0rd!",
  birthDate: "1992-05-04",
};

describe("realtor signup", () => {
  it("accepts and stores an optional country", async () => {
    const body = realtorSignupSchema.parse({ ...baseBody, country: "Ghana" });
    const res = mockRes();
    await signup(mockReq({ method: "POST", body }), res);

    expect(res.statusCode).toBe(201);
    const saved = await Realtor.findOne({ email: baseBody.email }).lean();
    expect(saved.country).toBe("Ghana");
    expect(saved.state).toBe("Greater Accra");
    expect(saved.bank).toBe("Kuda Bank");
  });

  it("still works without a country (web form, older app builds)", async () => {
    const body = realtorSignupSchema.parse(baseBody);
    const res = mockRes();
    await signup(mockReq({ method: "POST", body }), res);

    expect(res.statusCode).toBe(201);
    const saved = await Realtor.findOne({ email: baseBody.email }).lean();
    expect(saved.country).toBeUndefined();
  });

  it("links the recruiter when the referral code is sent as `ref`", async () => {
    const recruiter = await makeRealtor({ referralCode: "kemREF01" });
    const body = realtorSignupSchema.parse({ ...baseBody, ref: "kemREF01" });
    const res = mockRes();
    await signup(mockReq({ method: "POST", body }), res);

    expect(res.statusCode).toBe(201);
    const saved = await Realtor.findOne({ email: baseBody.email }).lean();
    expect(String(saved.recruitedBy)).toBe(String(recruiter._id));
  });

  it("includes country in the self-service profile snapshot", async () => {
    const realtor = await makeRealtor({ country: "Nigeria", state: "Lagos" });
    const res = mockRes();
    await updateMyBank(
      mockReq({
        method: "PUT",
        user: { id: String(realtor._id), role: "realtor" },
        body: { bank: "OPay", accountName: "Test", accountNumber: "0123456789" },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.user?.country ?? res.body.country).toBe("Nigeria");
  });
});
