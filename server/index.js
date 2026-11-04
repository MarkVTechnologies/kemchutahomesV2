import "./config/env.js";
// Must load before any other instrumented module — Sentry Node SDK requirement.
import Sentry from "./utils/sentry.js";

import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import compression from "compression";
import mongoSanitize from "express-mongo-sanitize";
import pinoHttp from "pino-http";
import logger from "./utils/logger.js";

// ── Route imports ──────────────────────────────────────────────────────────────
import realtorRoutes from "./routes/realtor.routes.js";
import adminRoutes from "./routes/adminRoutes.js";
import adminManagementRoutes from "./routes/adminManagement.routes.js";
import estateRoutes from "./routes/estate.routes.js";
import subscriptionRoutes from "./routes/subscription.routes.js";
import inspectionRoutes from "./routes/inspection.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import buy2sellRoutes from "./routes/Buy2sell.routes.js";
import branchRoutes from "./routes/branch.routes.js";
import contactRoutes from "./routes/contact.routes.js";
import clientRoutes from "./routes/client.routes.js";
import commissionRoutes from "./routes/commission.routes.js";
import bankAccountRoutes from "./routes/Bankaccount.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import knowledgeBaseRoutes from "./routes/knowledgeBase.routes.js";
import { readFileSync } from "node:fs";
import authRoutes from "./routes/auth.routes.js";

// ── Utilities ─────────────────────────────────────────────────────────────────
import cloudinary from "./utils/cloudinary.config.js";

const app = express();

// LiteSpeed (go54 DirectAdmin) sits in front of the app as a single
// reverse-proxy hop — trust exactly that hop's X-Forwarded-For so
// express-rate-limit keys requests by real client IP instead of the proxy's.
app.set("trust proxy", 1);

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ── Compression ───────────────────────────────────────────────────────────────
// /api/chat streams Server-Sent Events (see chat.controller.js) — compression
// buffers chunks internally to build its gzip window, which defeats
// incremental delivery (the client would see nothing until the whole
// response finished, exactly what streaming is meant to avoid). Excluded by
// path; every other route still gets the default filter's normal gzip'ing.
app.use(
  compression({
    filter: (req, res) => (req.path === "/api/chat" ? false : compression.filter(req, res)),
  }),
);

// ── Structured request logging (PRD FR-6) ────────────────────────────────────
// Registered early so even a request rejected by CORS or auth still gets
// logged. /healthz is excluded — uptime monitors poll it frequently
// enough that logging every hit would just be noise.
app.use(
  pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === "/healthz" },
  }),
);

// ── CORS ───────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://kemchutahomes.netlify.app",
  "https://kemchutahomesltd.com",
  "https://www.kemchutahomesltd.com",
  // client-legacy's post-cutover home (PRD §4.6: subdomain split) — serves
  // /dashboard/* and /client/portal/* until Phases 5-6 port them to `client`.
  "https://app.kemchutahomesltd.com",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
    // Spelled out rather than left to cors()'s defaults: the dashboard sends
    // PUT/PATCH/DELETE and the X-CSRF-Token header (lib/dashboardFetch.ts) on
    // every write. If the web server in front of this app (LiteSpeed on go54)
    // overrides these headers with a narrower list — e.g. an .htaccess
    // `Header set Access-Control-Allow-Methods "GET,POST"` — browsers reject
    // the preflight and every dashboard edit/delete silently fails.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ── NoSQL operator-injection guard ───────────────────────────────────────────
// req.body/req.params are plain writable objects — safe to sanitize in place.
// req.query is intentionally NOT touched here: Express 5 exposes it as a
// getter-only property recomputed fresh from the URL on every access, so
// express-mongo-sanitize's default `req.query = ...` middleware throws on
// any request with a querystring. Query-string safety is handled at the
// point of use instead (see estate.controller.js regex escaping).
app.use((req, res, next) => {
  if (req.body) req.body = mongoSanitize.sanitize(req.body);
  if (req.params) req.params = mongoSanitize.sanitize(req.params);
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
// REVISION is written by scripts/deploy/deploy.sh, so /healthz shows which
// commit is live (absent on hand-uploaded deploys).
const REVISION = (() => {
  try {
    return readFileSync(new URL("./REVISION", import.meta.url), "utf8").trim();
  } catch {
    return undefined;
  }
})();
app.get("/healthz", (req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;
  res.status(mongoUp ? 200 : 503).json({
    status: mongoUp ? "ok" : "degraded",
    mongo: mongoUp ? "connected" : "disconnected",
    uptime: process.uptime(),
    revision: REVISION ?? null,
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/realtors", realtorRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminManagementRoutes);
app.use("/api/admin", analyticsRoutes);
app.use("/api/estates", estateRoutes);
app.use("/api/inspections", inspectionRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/buy2sell", buy2sellRoutes);
app.use("/api/branches", branchRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/commissions", commissionRoutes);
app.use("/api/bank-accounts", bankAccountRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/knowledge-base", knowledgeBaseRoutes);
app.use("/api/auth", authRoutes);

// ── Sentry error capture ─────────────────────────────────────────────────────
// No-ops when SENTRY_DSN is unset. Must be registered after routes, before
// the centralised error handler below, so it sees every unhandled error but
// still lets the generic-message response go out to the client.
Sentry.setupExpressErrorHandler(app);

// ── Centralised error handler ────────────────────────────────────────────────
// Must be registered last. Never leaks err.message/stack to clients.
app.use((err, req, res, next) => {
  (req.log || logger).error({ err }, "Unhandled error");
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ message: "Something went wrong." });
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  // Cloudinary is only needed for media uploads — a transient outage must
  // never prevent the API from booting and serving everything else.
  cloudinary.api
    .ping()
    .then((result) => logger.info({ cloudinary: result.status }, "Cloudinary reachable"))
    .catch((err) =>
      logger.warn({ err: err.message }, "Cloudinary unreachable at boot (non-fatal)"),
    );

  // Scheduled jobs run in a separate process — see worker.js /
  // scripts/runJob.js — so a web restart or scale-out can no longer
  // duplicate or drop a cron run.
  connectMongo();

  app.listen(process.env.PORT || 3000, () =>
    logger.info({ port: process.env.PORT || 3000 }, "Server is running"),
  );
}

// Mongoose only auto-reconnects after a *successful* first connection — if
// the initial connect fails, every query in this process buffers for 10s and
// throws forever. On go54, LiteSpeed spawns extra Node processes under load,
// so one unlucky boot (Atlas blip, DNS hiccup) left a process that failed
// every request it was routed (realtor login/signup, estates, branches)
// until restarted. Keep retrying in the background instead; /healthz reports
// degraded meanwhile.
const MONGO_RETRY_MS = 10_000;

async function connectMongo() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    logger.info("Connected to MongoDB");
  } catch (err) {
    logger.error(
      { err: err.message, retryInMs: MONGO_RETRY_MS },
      "MongoDB connection error (server keeps running; /healthz reports degraded)",
    );
    setTimeout(connectMongo, MONGO_RETRY_MS);
  }
}

start();
