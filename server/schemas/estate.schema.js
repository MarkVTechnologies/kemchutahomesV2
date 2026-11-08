import { z } from "zod";

const videoInput = z.union([
  z.string(),
  z.object({
    videoId: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
  }),
]);

const amenitySchema = z.object({ name: z.string().trim().min(1) });
const neighborhoodSchema = z.object({ name: z.string().trim().min(1) });
const paymentPlanSchema = z.object({
  plot: z.string().trim().min(1),
  outright: z.string().trim().min(1),
  initialDeposit: z.string().trim().min(1),
});
const galleryItemSchema = z.object({
  url: z.string().trim().min(1),
  publicId: z.string().trim().min(1),
  caption: z.string().trim().optional(),
});

// Matches models/estate.model.js required/enum fields exactly. Applied to the
// JSON payload inside multipart "data" field — see validateMultipart in
// middlewares/validate.js, since req.body here is form-data, not raw JSON.
export const createEstateSchema = z.object({
  estate: z.string().trim().min(1, "Estate name is required"),
  address: z.string().trim().min(1, "Address is required"),
  location: z.enum(["Lagos", "Asaba", "Anambra", "Abuja"]),
  purpose: z.enum(["Residential", "Commercial", "Investment"]),
  title: z.enum([
    "CofO",
    "Gazette",
    "Excision",
    "Freehold",
    "Registered survey",
    "CofO in-view",
  ]),
  price: z.string().trim().min(1, "Price is required"),
  sqm: z.string().trim().min(1, "Size is required"),
  desc: z.string().trim().min(1, "Description is required"),
  category: z.enum(["Land", "House", "Duplex", "Flat", "Commercial"]).optional(),
  depositPercentage: z.string().trim().optional(),
  sytemap: z.string().trim().optional(),
  videos: z.array(videoInput).optional(),
  amenities: z.array(amenitySchema).optional(),
  neighborhood: z.array(neighborhoodSchema).optional(),
  paymentPlan: z.array(paymentPlanSchema).optional(),
});

export const updateEstateSchema = createEstateSchema.partial().extend({
  // Client-kept gallery items sent alongside newly uploaded files on update.
  gallery: z.array(galleryItemSchema).optional(),
});

export const estateQuerySchema = z.object({
  location: z.string().max(50).optional(),
  purpose: z.string().max(50).optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  // The web sitemap and estate static params ask for 500-1000 at once.
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  active: z.string().max(10).optional(),
});
