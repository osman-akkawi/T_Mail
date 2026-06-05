import multer from "multer";
import { Router } from "express";
import { AttachmentHandler } from "../../handlers/attachment";

const MB = 1024 * 1024;
const TELEGRAM_BOT_API_MAX_FILE_SIZE_BYTES = 50 * MB;

function getMaxAttachmentSizeBytes(): number {
  const raw = Number(process.env.MAX_ATTACHMENT_SIZE_MB ?? 20);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 20 * MB;
  }
  return Math.min(Math.floor(raw * MB), TELEGRAM_BOT_API_MAX_FILE_SIZE_BYTES);
}

const maxAttachmentSizeBytes = getMaxAttachmentSizeBytes();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxAttachmentSizeBytes,
    files: 1,
  },
});

function getPublicApiBaseUrl(req: { get(name: string): string | undefined; protocol: string }): string | null {
  const configured = (process.env.PUBLIC_API_BASE_URL ?? process.env.API_PUBLIC_BASE_URL ?? "").trim();
  if (configured) {
    try {
      const url = new URL(configured);
      return url.origin;
    } catch (_error) {
      return null;
    }
  }

  const host = req.get("host");
  if (!host || /[\r\n]/.test(host)) {
    return null;
  }

  return `${req.protocol}://${host}`;
}

export function createAttachmentsRouter(attachmentHandler: AttachmentHandler) {
  const router = Router();

  router.post("/upload", (req, res, next) => {
    upload.single("file")(req, res, async (uploadError: unknown) => {
      if (uploadError instanceof multer.MulterError) {
        if (uploadError.code === "LIMIT_FILE_SIZE") {
          const maxMb = Math.floor(maxAttachmentSizeBytes / MB);
          res
            .status(413)
            .json({ ok: false, error: `Attachment exceeds limit (${maxMb}MB max per file)` });
          return;
        }

        if (uploadError.code === "LIMIT_FILE_COUNT" || uploadError.code === "LIMIT_UNEXPECTED_FILE") {
          res.status(400).json({ ok: false, error: "Only one file can be uploaded at a time" });
          return;
        }

        res.status(400).json({ ok: false, error: uploadError.message });
        return;
      }

      if (uploadError) {
        next(uploadError);
        return;
      }

      try {
        const user = req.authUser;
        if (!user) {
          res.status(401).json({ ok: false, error: "Unauthorized" });
          return;
        }

        if (!req.file) {
          res.status(400).json({ ok: false, error: "File is required" });
          return;
        }

        const attachment = await attachmentHandler.upload(user, {
          buffer: req.file.buffer,
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size,
        });

        res.json({ ok: true, data: { attachment } });
      } catch (error) {
        next(error);
      }
    });
  });

  router.get("/file/:fileId", async (req, res, next) => {
    try {
      const rawUrl = await attachmentHandler.getFileUrl(req.params.fileId);
      if (/^https?:\/\//i.test(rawUrl)) {
        res.json({ ok: true, data: { url: rawUrl } });
        return;
      }

      const baseUrl = getPublicApiBaseUrl(req);
      const absoluteUrl = baseUrl ? `${baseUrl}${rawUrl}` : rawUrl;
      res.json({ ok: true, data: { url: absoluteUrl } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/raw/:fileId", async (req, res, next) => {
    try {
      const file = await attachmentHandler.getLocalAttachmentForDownload(
        req.params.fileId,
        req.query.expires as string | string[] | undefined,
        req.query.sig as string | string[] | undefined,
      );

      const safeName = file.fileName.replace(/[\r\n"]/g, "_");
      res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
      res.setHeader("Content-Length", String(file.size));
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
      res.sendFile(file.filePath);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
