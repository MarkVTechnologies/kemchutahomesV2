/**
 * test/contactController.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-line messages (e.g. the mobile app's AI chat reports) used to arrive
 * in the admin inbox as one run-on paragraph because the message sat inside a
 * <p> with its newlines intact. Line breaks are now turned into <br> — after
 * escaping, so a sender still can't inject markup.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/notifications.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

import { sendEmail } from "../utils/notifications.js";
import { submitContactForm } from "../controllers/contact.controller.js";
import { mockReq, mockRes } from "./mockExpress.js";

describe("submitContactForm — admin email body", () => {
  beforeEach(() => {
    sendEmail.mockClear();
  });

  it("keeps line breaks and still escapes HTML in the message", async () => {
    const req = mockReq({
      method: "POST",
      body: {
        name: "Tester",
        email: "tester@example.com",
        subject: "Hello",
        message: "Line one\nLine two\r\n<script>alert(1)</script>",
      },
    });
    const res = mockRes();

    await submitContactForm(req, res);

    expect(res.statusCode).toBe(200);
    const adminHtml = sendEmail.mock.calls[0][0].html;
    expect(adminHtml).toContain("Line one<br>Line two<br>&lt;script&gt;");
    expect(adminHtml).not.toContain("<script>");
  });
});
