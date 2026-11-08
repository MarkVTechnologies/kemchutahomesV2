/**
 * middlewares/validate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic zod validation gate (PRD FR-4). For "body" and "params", the parsed
 * (and coerced/defaulted) result REPLACES req[source] — this doubles as a
 * field whitelist, since zod strips any key not declared in the schema, e.g.
 * an update endpoint that used to forward req.body straight into Mongoose can
 * no longer be used to mass-assign passwordHash or role.
 *
 * "query" is validated for pass/fail only and is never written back: Express 5
 * exposes req.query as a getter recomputed fresh from the URL on every read,
 * so `req.query = ...` throws (see the same note in server/index.js next to
 * express-mongo-sanitize). Controllers keep doing their own Number()/coercion
 * on req.query after this middleware has rejected malformed input.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isValidObjectId } from "mongoose";

// Clients display `message` directly, so it carries the first real problem.
// zod's built-in wording doesn't name the field; our own messages already do.
const validationFailure = (issues) => {
  const errors = issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  const [first] = errors;
  const isGeneric = /^(Invalid input|Invalid option|Too (small|big))/.test(first.message);
  return {
    message: isGeneric && first.path ? `${first.path}: ${first.message}` : first.message,
    errors,
  };
};

// For router.param("id", ...): a malformed id is a 400, not a CastError 500.
export const rejectInvalidIdParam = (label) => (req, res, next, id) => {
  if (isValidObjectId(id)) return next();
  return res.status(400).json({ message: `Invalid ${label} ID` });
};

export const validate =
  (schema, source = "body") =>
  (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      return res.status(400).json(validationFailure(result.error.issues));
    }

    if (source !== "query") {
      req[source] = result.data;
    }

    next();
  };

/**
 * Estate create/update send their JSON payload inside a multipart "data"
 * field (see middlewares/upload.middleware.js) rather than as the raw JSON
 * body express.json() expects, so the generic `validate()` above can't be
 * pointed at req.body directly here. Parses that field, validates it, and
 * exposes the result as req.validatedBody for the controller to use instead
 * of re-parsing JSON.parse(req.body.data) itself.
 */
export const validateMultipart = (schema) => (req, res, next) => {
  let raw;
  try {
    raw = req.body?.data ? JSON.parse(req.body.data) : req.body;
  } catch {
    return res.status(400).json({ message: "Invalid JSON in 'data' field" });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return res.status(400).json(validationFailure(result.error.issues));
  }

  req.validatedBody = result.data;
  next();
};
