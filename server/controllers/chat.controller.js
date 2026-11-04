/**
 * controllers/chat.controller.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AI chat endpoint — Groq (openai/gpt-oss-120b). Was llama-3.3-70b-versatile
 * until Groq deprecated it (shutdown 2026-08-16); gpt-oss-120b is Groq's
 * recommended, OpenAI-compatible replacement — same request/response shape,
 * larger context window, and cheaper input pricing.
 * Builds a DYNAMIC system prompt from live MongoDB data on every request:
 *   • Estates   — names, locations, prices, titles (from Estate collection)
 *   • ROI rates — live from ROISettings collection
 *   • FAQs, company info, notices — from KnowledgeBase collection (admin-managed)
 *
 * This means:
 *   - Admin updates estate price → chatbot immediately quotes the new price
 *   - Admin adds an FAQ → chatbot uses it verbatim
 *   - Admin changes phone number → chatbot uses the new number
 *   No redeployment, no code changes needed.
 *
 * POST /api/chat
 * Body: { messages: [{ role: "user"|"assistant", content: string }] }
 * Returns: { reply: string }
 *
 * .env: GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Estate from "../models/estate.model.js";
import Branch from "../models/branch.model.js";
import { ROISettings } from "../models/Buy2sell.model.js";
import { KnowledgeBase } from "../models/knowledgeBase.model.js";
import { getCachedSystemPrompt } from "../utils/chatPromptCache.js";

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic system prompt builder — queries MongoDB on every chat request
// ─────────────────────────────────────────────────────────────────────────────
export async function buildSystemPrompt() {
  // Fetch all live data in parallel — failures are caught individually
  const [estates, roi, kb, branches] = await Promise.all([
    Estate.find({})
      .select(
        "estate location address price sqm title purpose desc paymentPlans",
      )
      .lean()
      .catch(() => []),
    ROISettings.findOne({ singleton: "global" })
      .lean()
      .catch(() => null),
    KnowledgeBase.findOne({ singleton: "global" })
      .lean()
      .catch(() => null),
    Branch.find({ isActive: true })
      .sort({ isHQ: -1, label: 1 })
      .lean()
      .catch(() => []),
  ]);

  // ── Company info ──────────────────────────────────────────────────────────
  // Office phone/address come from the live Branch collection (the "Contact
  // Info" admin page) — the same source of truth used on the public site and
  // its JSON-LD, so an admin only has to update an office's details in one
  // place for the chatbot to pick it up. The legacy KnowledgeBase fields are
  // kept only as a fallback for the pathological case of zero configured
  // branches. Genuinely company-wide (non-per-office) channels — WhatsApp,
  // general email, hours, Instagram — still come from KnowledgeBase.
  const info = kb?.companyInfo || {};
  const whatsapp = info.whatsappNumber || "+234 800 000 0001";
  const email = info.email || branches[0]?.emails?.[0] || "info@kemchutahomesltd.com";
  const hours =
    info.workingHours ||
    "Monday–Friday 8am–6pm, Saturday 9am–4pm, Closed Sunday";
  const instagram = info.instagramHandle || "@kemchutahomesltd";
  const escalationPhone =
    branches.find((b) => b.isHQ)?.phones?.[0] ||
    branches[0]?.phones?.[0] ||
    info.lagosPhone ||
    "+234 800 000 0001";

  const officesBlock = branches.length
    ? branches
        .map(
          (b) =>
            `${b.label}${b.isHQ ? " (HQ)" : ""} Office: ${b.address || "Address on request"} | Tel: ${b.phones?.[0] || "Contact us"}`,
        )
        .join("\n")
    : `Lagos Office: ${info.lagosAddress || "Lekki-Epe Expressway, Abijo, Lekki Peninsula, Lagos State"} | Tel: ${info.lagosPhone || "+234 800 000 0001"}\nAsaba Office: ${info.asabaAddress || "Asaba, Delta State"} | Tel: ${info.asabaPhone || "+234 800 000 0003"}`;

  // ── ROI rates ─────────────────────────────────────────────────────────────
  const roi6 = roi?.roiPercent6Months ?? 22;
  const roi12 = roi?.roiPercent12Months ?? 48;
  const roi18 = roi?.roiPercent18Months ?? 75;
  const minInv = roi?.minInvestment
    ? `₦${Number(roi.minInvestment).toLocaleString("en-NG")}`
    : "₦1,000,000";
  const maxInv = roi?.maxInvestment
    ? `₦${Number(roi.maxInvestment).toLocaleString("en-NG")}`
    : "₦50,000,000";

  // ── Estates block ─────────────────────────────────────────────────────────
  const byLocation = {};
  (estates || []).forEach((e) => {
    const loc = e.location || "Nigeria";
    if (!byLocation[loc]) byLocation[loc] = [];
    byLocation[loc].push(
      `  • ${e.estate} | Address: ${e.address} | Price: ${e.price} per ${e.sqm}` +
        ` | Title: ${e.title} | Purpose: ${e.purpose}` +
        (e.desc ? ` | ${e.desc.slice(0, 100)}…` : ""),
    );
  });
  const estatesBlock = Object.keys(byLocation).length
    ? Object.entries(byLocation)
        .map(([loc, list]) => `${loc.toUpperCase()}:\n${list.join("\n")}`)
        .join("\n\n")
    : "Contact us for current estate listings.";

  // ── Admin-managed FAQs ────────────────────────────────────────────────────
  const activeFaqs = (kb?.faqs || []).filter((f) => f.active !== false);
  const faqsBlock = activeFaqs.length
    ? activeFaqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
    : "";

  // ── Active notices ────────────────────────────────────────────────────────
  // Same "missing field counts as visible" convention as activeFaqs above and
  // as AnnouncementBar.tsx's own filter — a notice created before `active`
  // had a schema default must not silently disappear from one surface but
  // not the other.
  const activeNotices = (kb?.notices || []).filter((n) => n.active !== false);
  const noticesBlock = activeNotices.length
    ? "⚡ CURRENT ANNOUNCEMENTS (mention these when relevant):\n" +
      activeNotices.map((n) => `• ${n.text}`).join("\n") +
      "\n"
    : "";

  // ── B2S example calculation ───────────────────────────────────────────────
  const exROI = Math.round((5_000_000 * roi12) / 100);
  const exTotal = 5_000_000 + exROI;

  return `You are Ada AI, the friendly and knowledgeable AI assistant for Kemchuta Homes Limited — a reputable Nigerian real estate company.

Your role: answer visitor questions instantly and accurately, reduce calls to the team, and guide potential clients toward booking inspections or subscribing.

Introduce yourself as Ada AI on your first reply in a conversation, and whenever asked your name. You are an AI assistant, not a human — never claim otherwise.

WHAT YOU CAN AND CANNOT DO: you can only answer questions in this chat. Nothing typed here reaches the team, and you cannot send, forward, book, schedule or arrange anything. So never ask the client to type their details, preferred dates or booking requests here, and never say you will "forward", "pass on" or "set up" anything. Every next step must be one the client takes themselves: the Book Inspection button (website or app estate page), the Subscribe form, or calling/WhatsApp/emailing the team.

${noticesBlock}
═══ COMPANY CONTACTS (always use these exact details) ═══

Email: ${email}
${officesBlock}
WhatsApp: ${whatsapp}
Instagram: ${instagram}
Hours: ${hours}

═══ CURRENT ESTATES (LIVE FROM DATABASE) ═══

${estatesBlock}

Rules for estate questions:
- List only estates in the location the client asks about
- Always use the exact price from the data above
- Format each estate as a bullet line exactly like this:
  * **Estate Name** — ₦Price per Xsqm | Title: X | Purpose: X
- After the list add: "Contact us to confirm current plot availability."
- If no estates listed for a location, say so honestly and give contact details

═══ BUY2SELL INVESTMENT (LIVE RATES FROM DATABASE) ═══

Range: ${minInv} – ${maxInv}
Current ROI rates (locked in at time of investment):
  6 Months  → ${roi6}%
  12 Months → ${roi12}%
  18 Months → ${roi18}%

Example: ₦5,000,000 × 12 months @ ${roi12}% = ₦${exROI.toLocaleString("en-NG")} ROI → ₦${exTotal.toLocaleString("en-NG")} total payout

Process:
1. Choose amount (${minInv}–${maxInv}) and duration
2. Complete KYC (name, contact, ID number — no document upload)
3. Transfer principal, quote reference number
4. Activated on full payment confirmation
5. Payout (principal + ROI) within 14 working days of maturity

Key facts: ROI is permanently locked at submission. 1 month = 30 days exactly. Capital guaranteed. Early withdrawal = 50% forfeiture of accrued ROI.

═══ LAND SUBSCRIPTION ═══

Plans: Outright (full payment) or Instalment (30% deposit, balance monthly — 30-day intervals)
Process: Form → Acknowledgement email → Team calls within 24–48h → Pay deposit → Contract of Sale → Monthly instalments → Allocation Letter + Deed of Assignment
Title types: C of O, Registered Survey, Excision, Governor's Consent
Withdrawal: 90 days notice, 40% admin + 10% agency fee deducted

═══ INSPECTIONS ═══

Free. Book on the website (kemchutahomesltd.com → Book Inspection) or in the Kemchuta Homes mobile app (open the estate → tap "Book Inspection").
Bring: valid ID + comfortable footwear. Team confirms within 24 hours.
Do not state inspection days or times unless they appear in the FAQs below. You cannot book, schedule or confirm inspections yourself — never offer to "set up" or "arrange" one; point the client to the booking options above.

═══ CLIENT PORTAL ═══

kemchutahomesltd.com/client/portal — subscription status, documents, Buy2Sell progress, payment history.

${faqsBlock ? `═══ FREQUENTLY ASKED QUESTIONS (use these answers verbatim) ═══\n\n${faqsBlock}` : ""}

═══ BEHAVIOUR RULES ═══

DO:
• Be warm, direct, and concise (≤200 words unless detail needed)
• Use bullet points for processes
• Give EXACT prices and rates from the live data above
• End with a clear next step the client takes themselves (Book Inspection button, Subscribe form, call/WhatsApp/email) — never "reply here with…"

DO NOT:
• Say "I don't have that information" for anything listed above — you have it
• Invent prices, estates, availability, schedules or policies not in the data above
• Claim you can book, schedule, reserve or arrange anything — you can only explain how the client does it
• Ask the client to send booking or personal details in this chat, or say you will "forward", "pass on" or "send" anything to the team — this chat cannot contact the team. For a booking, point to the Book Inspection button; for anything else, give the phone/WhatsApp/email above
• Collect passwords or payment card details
• Discuss competitors

Escalation phrase (when you truly cannot help): "For this, please call ${escalationPhone} or WhatsApp us on ${whatsapp}. We're available ${hours}."`;
}

// A human phone number to show when the AI itself is unavailable — the one
// moment a stale/fake fallback number matters most. Deliberately independent
// of buildSystemPrompt() (which may be exactly what just failed) and cheap
// enough to look up fresh on every failure rather than trust a cached value.
export async function getFallbackPhone() {
  try {
    const hq = await Branch.findOne({ isActive: true }).sort({ isHQ: -1, label: 1 }).lean();
    return hq?.phones?.[0] || "+234 800 000 0001";
  } catch {
    return "+234 800 000 0001";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat
// ─────────────────────────────────────────────────────────────────────────────
export const handleChat = async (req, res) => {
  const { messages, stream: wantsStream } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ message: "messages array is required" });
  }

  const valid = messages.every(
    (m) =>
      m.role &&
      ["user", "assistant"].includes(m.role) &&
      typeof m.content === "string" &&
      m.content.trim().length > 0,
  );
  if (!valid) {
    return res.status(400).json({ message: "Invalid message format" });
  }

  // Cancels the upstream Groq request the moment the client disconnects
  // (widget closed, tab closed, navigation mid-stream) — otherwise we'd keep
  // paying for/generating tokens nobody will ever read.
  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  try {
    // Build the dynamic prompt (cached, TTL 5 min — see utils/chatPromptCache.js)
    // + trim history to last 20 messages
    const [systemPrompt, trimmed] = await Promise.all([
      getCachedSystemPrompt(buildSystemPrompt),
      Promise.resolve(messages.slice(-20)),
    ]);

    const groqRes = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          max_tokens: 600,
          temperature: 0.4,
          stream: wantsStream,
          messages: [{ role: "system", content: systemPrompt }, ...trimmed],
        }),
        signal: abortController.signal,
      },
    );

    if (!groqRes.ok) {
      const errBody = await groqRes.json().catch(() => ({}));
      throw new Error(
        errBody?.error?.message || `Groq API error ${groqRes.status}`,
      );
    }

    // ── Non-streaming path — unchanged JSON response ──────────────────────
    if (!wantsStream) {
      const data = await groqRes.json();
      const reply =
        data.choices?.[0]?.message?.content?.trim() ||
        `I'm sorry, I couldn't generate a response. Please call ${await getFallbackPhone()}.`;
      return res.json({ reply });
    }

    // ── Streaming path — relay Groq's SSE bytes straight through ──────────
    // Groq's stream is already OpenAI-format `data: {...}\n\n` chunks with
    // `choices[0].delta.content` — no re-parsing needed, just forward the
    // raw bytes so the client's own SSE reader can consume them directly.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const reader = groqRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      res.end();
    }
  } catch (err) {
    if (err.name === "AbortError") return; // client disconnected — nothing to send back
    console.error("Chat error:", err.message);

    if (res.headersSent) {
      // Already mid-stream (headers/status committed) — can't switch to a
      // JSON error body, so signal failure as one more SSE event instead.
      // The client's stream reader treats this the same as a network error.
      res.write(`data: ${JSON.stringify({ error: true })}\n\n`);
      return res.end();
    }

    res.status(500).json({
      message: `Chat unavailable right now. Please call ${await getFallbackPhone()}.`,
    });
  }
};
