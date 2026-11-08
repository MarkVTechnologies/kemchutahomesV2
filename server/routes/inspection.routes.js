import express from "express";
import {
  bookInspection,
  getAllInspections,
  getInspectionById,
  createInspectionAdmin,
  updateInspection,
  updateInspectionStatus,
  updateInspectionNotes,
  deleteInspection,
} from "../controllers/inspection.controller.js";
import { protect, isAdmin, hasPermission } from "../middlewares/authMiddleware.js";
import { publicFormLimiter } from "../middlewares/rateLimiters.js";
import { validate } from "../middlewares/validate.js";
import {
  bookInspectionSchema,
  createInspectionAdminSchema,
  updateInspectionAdminSchema,
  updateInspectionStatusSchema,
  updateInspectionNotesSchema,
} from "../schemas/inspection.schema.js";

const router = express.Router();

router.post("/", publicFormLimiter, validate(bookInspectionSchema), bookInspection); // Public
router.get("/", protect, isAdmin, hasPermission("manage_inspections"), getAllInspections); // Admin
router.post(
  "/admin",
  protect,
  isAdmin,
  hasPermission("manage_inspections"),
  validate(createInspectionAdminSchema),
  createInspectionAdmin,
); // Admin — manual create (e.g. phone booking)
router.get("/:id", protect, isAdmin, hasPermission("manage_inspections"), getInspectionById); // Admin
router.put(
  "/:id",
  protect,
  isAdmin,
  hasPermission("manage_inspections"),
  validate(updateInspectionAdminSchema),
  updateInspection,
); // Admin — full edit
router.patch(
  "/:id/status",
  protect,
  isAdmin,
  hasPermission("manage_inspections"),
  validate(updateInspectionStatusSchema),
  updateInspectionStatus,
); // Admin
router.patch(
  "/:id/notes",
  protect,
  isAdmin,
  hasPermission("manage_inspections"),
  validate(updateInspectionNotesSchema),
  updateInspectionNotes,
); // Admin
router.delete("/:id", protect, isAdmin, hasPermission("manage_inspections"), deleteInspection); // Admin

export default router;
