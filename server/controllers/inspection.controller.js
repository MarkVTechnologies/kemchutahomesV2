import { isValidObjectId } from "mongoose";
import Inspection from "../models/inspection.model.js";
import {
  notifyInspectionBooked,
  notifyInspectionStatusChanged,
} from "../utils/notifications.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { parsePagination } from "../utils/pagination.js";

// ── :id guard ────────────────────────────────────────────────────────────────
// Mirrors estate.controller.js's rejectedInvalidId — without it, a malformed
// id reaches findByIdAndUpdate/findById, throws a CastError, and gets reported
// as a generic 500 for what is plainly bad client input. Returns true when it
// has already sent the response.
const rejectedInvalidId = (req, res) => {
  if (isValidObjectId(req.params.id)) return false;
  res.status(400).json({ message: "Invalid inspection ID" });
  return true;
};

// ── POST /api/inspections ────────────────────────────────────────────────────
// Books an inspection and fires email + SMS to admin and client simultaneously.
export const bookInspection = async (req, res) => {
  try {
    const {
      estateName,
      estateId,
      firstName,
      lastName,
      email,
      phone,
      inspectionDate,
      persons,
      notes,
    } = req.body;

    if (
      !estateName ||
      !firstName ||
      !lastName ||
      !email ||
      !phone ||
      !inspectionDate ||
      !persons
    ) {
      return res
        .status(400)
        .json({ message: "All required fields must be filled." });
    }

    const date = new Date(inspectionDate);
    if (date < new Date()) {
      return res
        .status(400)
        .json({ message: "Inspection date cannot be in the past." });
    }

    const inspection = await Inspection.create({
      estateName,
      estateId: estateId || null,
      firstName,
      lastName,
      email,
      phone,
      inspectionDate: date,
      persons,
      notes,
    });

    // Fire dual-channel notification (email + SMS) — non-blocking
    notifyInspectionBooked(inspection).catch((err) =>
      console.error("Inspection notification failed:", err.message),
    );

    res.status(201).json({
      message: "Inspection booked successfully!",
      inspection: {
        _id: inspection._id,
        estateName: inspection.estateName,
        firstName: inspection.firstName,
        lastName: inspection.lastName,
        email: inspection.email,
        phone: inspection.phone,
        inspectionDate: inspection.inspectionDate,
        persons: inspection.persons,
        status: inspection.status,
      },
    });
  } catch (err) {
    console.error("bookInspection:", err);
    res.status(500).json({ message: "Failed to book inspection." });
  }
};

// ── GET /api/inspections — Admin: get all ────────────────────────────────────
export const getAllInspections = async (req, res) => {
  try {
    const { status, search } = req.query;
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      const safeSearch = escapeRegex(String(search).slice(0, 100));
      filter.$or = [
        { estateName: { $regex: safeSearch, $options: "i" } },
        { firstName: { $regex: safeSearch, $options: "i" } },
        { lastName: { $regex: safeSearch, $options: "i" } },
        { email: { $regex: safeSearch, $options: "i" } },
      ];
    }
    const [inspections, total] = await Promise.all([
      Inspection.find(filter)
        .sort({ inspectionDate: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Inspection.countDocuments(filter),
    ]);
    res.json({
      inspections,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch inspections." });
  }
};

// ── PATCH /api/inspections/:id/status — Admin: update status ─────────────────
// Fires email + SMS to the client for confirmed, cancelled, and completed.
// Was previously silent — clients received nothing on status change.
export const updateInspectionStatus = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { status } = req.body;
    const valid = ["pending", "confirmed", "cancelled", "completed"];
    if (!valid.includes(status)) {
      return res.status(400).json({ message: "Invalid status value." });
    }

    const inspection = await Inspection.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true },
    );
    if (!inspection)
      return res.status(404).json({ message: "Inspection not found." });

    // Notify client on every meaningful status change (fire and forget)
    if (["confirmed", "cancelled", "completed"].includes(status)) {
      notifyInspectionStatusChanged(inspection).catch((err) =>
        console.error("Inspection status notification failed:", err.message),
      );
    }

    res.json({ message: "Status updated.", inspection });
  } catch (err) {
    res.status(500).json({ message: "Failed to update status." });
  }
};

// ── PATCH /api/inspections/:id/notes — Admin: update notes ───────────────────
export const updateInspectionNotes = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const { notes } = req.body;
    const inspection = await Inspection.findByIdAndUpdate(
      req.params.id,
      { notes: notes || "" },
      { new: true },
    );
    if (!inspection)
      return res.status(404).json({ message: "Inspection not found." });
    res.json({ message: "Notes updated.", inspection });
  } catch (err) {
    res.status(500).json({ message: "Failed to update notes." });
  }
};

// ── GET /api/inspections/:id — Admin: get one ─────────────────────────────────
export const getInspectionById = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const inspection = await Inspection.findById(req.params.id).lean();
    if (!inspection)
      return res.status(404).json({ message: "Inspection not found." });
    res.json(inspection);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch inspection." });
  }
};

// ── POST /api/inspections/admin — Admin: log an inspection manually ──────────
// For bookings taken over the phone/in person rather than through the public
// form. Reuses the same booked-notification email/SMS as the public flow so
// the client still gets a confirmation regardless of which channel booked it.
export const createInspectionAdmin = async (req, res) => {
  try {
    const {
      estateName,
      estateId,
      firstName,
      lastName,
      email,
      phone,
      inspectionDate,
      persons,
      status,
      notes,
    } = req.body;

    const inspection = await Inspection.create({
      estateName,
      estateId: estateId || null,
      firstName,
      lastName,
      email,
      phone,
      inspectionDate,
      persons,
      status: status || "pending",
      notes: notes || "",
    });

    notifyInspectionBooked(inspection).catch((err) =>
      console.error("Inspection notification failed:", err.message),
    );

    res.status(201).json({
      message: "Inspection created successfully.",
      inspection,
    });
  } catch (err) {
    console.error("createInspectionAdmin:", err);
    res.status(500).json({ message: "Failed to create inspection." });
  }
};

// ── PUT /api/inspections/:id — Admin: full edit ───────────────────────────────
export const updateInspection = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const existing = await Inspection.findById(req.params.id);
    if (!existing)
      return res.status(404).json({ message: "Inspection not found." });

    const updates = { ...req.body };
    if ("estateId" in updates) updates.estateId = updates.estateId || null;

    const previousStatus = existing.status;
    const inspection = await Inspection.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true },
    );

    // The edit form can change status alongside every other field — fire the
    // same client notification the dedicated status-only endpoint sends, so
    // an admin editing status here doesn't silently skip it.
    if (
      updates.status &&
      updates.status !== previousStatus &&
      ["confirmed", "cancelled", "completed"].includes(updates.status)
    ) {
      notifyInspectionStatusChanged(inspection).catch((err) =>
        console.error("Inspection status notification failed:", err.message),
      );
    }

    res.json({ message: "Inspection updated successfully.", inspection });
  } catch (err) {
    console.error("updateInspection:", err);
    res.status(500).json({ message: "Failed to update inspection." });
  }
};

// ── DELETE /api/inspections/:id — Admin: delete ───────────────────────────────
export const deleteInspection = async (req, res) => {
  if (rejectedInvalidId(req, res)) return;
  try {
    const inspection = await Inspection.findByIdAndDelete(req.params.id);
    if (!inspection)
      return res.status(404).json({ message: "Inspection not found." });
    res.json({ message: "Inspection deleted successfully." });
  } catch (err) {
    console.error("deleteInspection:", err);
    res.status(500).json({ message: "Failed to delete inspection." });
  }
};
