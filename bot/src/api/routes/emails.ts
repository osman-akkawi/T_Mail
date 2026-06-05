import { Router } from "express";
import { ValidationError } from "../../errors";
import type { TMailFolder } from "../../types";
import { EmailService } from "../../services/email";
import { MasterIndexService } from "../../services/index";

function parseFolder(value: string): TMailFolder {
  const folder = value.toLowerCase();
  if (["inbox", "sent", "drafts", "trash", "starred"].includes(folder)) {
    return folder as TMailFolder;
  }
  throw new ValidationError(`Invalid folder: ${value}`);
}

function isLoopbackIp(value: string): boolean {
  const normalized = value.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function getClientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  return req.ip || req.socket?.remoteAddress || "";
}

function readOptionalString(
  body: Record<string, unknown>,
  field: "subject" | "body" | "bodyHtml",
  maxLength: number,
): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${field} is too long.`);
  }
  return value;
}

function parseEmailUpdates(bodyRaw: unknown) {
  const body = bodyRaw && typeof bodyRaw === "object" ? bodyRaw as Record<string, unknown> : {};
  const updates: {
    status?: "unread" | "read" | "draft";
    starred?: boolean;
    labels?: string[];
    subject?: string;
    body?: string;
    bodyHtml?: string;
  } = {};

  if (body.status !== undefined) {
    if (body.status !== "unread" && body.status !== "read" && body.status !== "draft") {
      throw new ValidationError("Invalid status.");
    }
    updates.status = body.status;
  }

  if (body.starred !== undefined) {
    if (typeof body.starred !== "boolean") {
      throw new ValidationError("starred must be a boolean.");
    }
    updates.starred = body.starred;
  }

  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels)) {
      throw new ValidationError("labels must be an array.");
    }
    updates.labels = body.labels.slice(0, 20).map((label) => {
      if (typeof label !== "string") {
        throw new ValidationError("labels must only contain strings.");
      }
      return label.trim().slice(0, 40);
    }).filter(Boolean);
  }

  updates.subject = readOptionalString(body, "subject", 300);
  updates.body = readOptionalString(body, "body", 100_000);
  updates.bodyHtml = readOptionalString(body, "bodyHtml", 100_000);
  if (updates.body !== undefined && updates.bodyHtml === undefined) {
    updates.bodyHtml = updates.body;
  }

  return Object.fromEntries(
    Object.entries(updates).filter((entry) => entry[1] !== undefined),
  );
}

export function createEmailsRouter(emailService: EmailService, indexService: MasterIndexService) {
  const router = Router();

  router.get("/dev/list", (req, res, next) => {
    try {
      if (process.env.NODE_ENV === "production") {
        res.status(403).json({ ok: false, error: "Disabled in production." });
        return;
      }

      if (!isLoopbackIp(getClientIp(req))) {
        res.status(403).json({ ok: false, error: "Only localhost is allowed." });
        return;
      }

      const address = String(req.query.address ?? "").trim().toLowerCase();
      if (!address) {
        throw new ValidationError("address is required");
      }

      const folder = parseFolder(String(req.query.folder ?? "inbox"));
      const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20)));
      const user = indexService.lookupByAddress(address);
      if (!user) {
        res.status(404).json({ ok: false, error: "User not found." });
        return;
      }

      const emails = emailService.listEmails(user, folder, limit, 0);
      res.json({
        ok: true,
        data: {
          address,
          folder,
          count: emails.length,
          emails,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/", (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const folder = parseFolder(String(req.query.folder ?? "inbox"));
      const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
      const offset = Math.max(0, Number(req.query.offset ?? 0));

      const emails = emailService.listEmails(user, folder, limit, offset);
      res.json({ ok: true, data: { emails, folder, limit, offset } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/search/query", (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const q = String(req.query.q ?? "");
      const emails = emailService.search(user, q);
      res.json({ ok: true, data: { emails, query: q } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:folder/:id", (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const folder = parseFolder(req.params.folder);
      const email = emailService.getEmail(user, folder, req.params.id);
      const thread = emailService.getThread(user, email.threadId);
      res.json({ ok: true, data: { email, thread } });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:folder/:id", (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const folder = parseFolder(req.params.folder);
      const updated = emailService.updateEmail(
        user,
        folder,
        req.params.id,
        parseEmailUpdates(req.body),
      );
      res.json({ ok: true, data: { email: updated } });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:folder/:id", async (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const folder = parseFolder(req.params.folder);
      await emailService.deleteEmail(user, folder, req.params.id);
      res.json({ ok: true, data: { deleted: true } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
