import multer from "multer";

const storage = multer.memoryStorage();

const imageFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    cb(Object.assign(new Error("Only image files are allowed"), { status: 400 }), false);
  } else {
    cb(null, true);
  }
};

// Oversized or non-image uploads are client errors; multer's errors carry no
// status, so the central handler was reporting them as 500s.
export const withUploadErrors = (upload) => (req, res, next) =>
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const tooLarge = err.code === "LIMIT_FILE_SIZE";
      return res
        .status(tooLarge ? 413 : 400)
        .json({ message: tooLarge ? "That file is too large." : err.message });
    }
    if (err?.status === 400) return res.status(400).json({ message: err.message });
    next(err);
  });

// ── Existing: single avatar upload ──────────────────────────────────────────
export const uploadSingleImage = withUploadErrors(
  multer({
    storage,
    fileFilter: imageFilter,
    limits: { fileSize: 25 * 1024 * 1024 },
  }).single("avatar"),
);

// ── New: estate images (1 featured + up to 15 gallery) ───────────────────────
export const uploadEstateImages = withUploadErrors(
  multer({
    storage,
    fileFilter: imageFilter,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
  }).fields([
    { name: "img", maxCount: 1 }, // featured / banner image
    { name: "gallery", maxCount: 15 }, // gallery array
  ]),
);
