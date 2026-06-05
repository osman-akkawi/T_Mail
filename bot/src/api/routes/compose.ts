import { Router } from "express";
import { ValidationError } from "../../errors";
import { EmailHandler } from "../../handlers/email";
import { normalizeTMailAddress } from "../../services/address";
import type { TMailAttachment, TMailUser } from "../../types";

const MAX_RECIPIENTS_PER_EMAIL = Math.max(
  1,
  Math.floor(Number(process.env.MAX_RECIPIENTS_PER_EMAIL ?? 50)),
);
const MAX_ADDRESS_LENGTH = 254;
const MAX_SUBJECT_LENGTH = Math.max(
  1,
  Math.floor(Number(process.env.MAX_SUBJECT_LENGTH ?? 300)),
);
const MAX_BODY_LENGTH = Math.max(
  1,
  Math.floor(Number(process.env.MAX_BODY_LENGTH ?? 100_000)),
);

function normalizeAddress(input: string): string {
  return normalizeTMailAddress(input);
}

function readString(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new ValidationError(`${field} is too long.`);
  }

  return value;
}

function readAddressList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array.`);
  }
  if (value.length > MAX_RECIPIENTS_PER_EMAIL) {
    throw new ValidationError(`${field} has too many recipients.`);
  }

  return value.map((item) => {
    if (typeof item !== "string") {
      throw new ValidationError(`${field} must only contain strings.`);
    }

    const address = item.trim().toLowerCase();
    if (!address || address.length > MAX_ADDRESS_LENGTH || /[\s<>"'\\]/.test(address)) {
      throw new ValidationError(`Invalid address in ${field}.`);
    }

    return normalizeAddress(address);
  });
}

function readAttachments(value: unknown): TMailAttachment[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ValidationError("attachments must be an array.");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new ValidationError("Invalid attachment.");
    }

    const attachment = item as Partial<TMailAttachment>;
    if (
      typeof attachment.fileId !== "string" ||
      typeof attachment.name !== "string" ||
      typeof attachment.mimeType !== "string" ||
      typeof attachment.telegramMessageId !== "number" ||
      typeof attachment.size !== "number" ||
      !Number.isFinite(attachment.size) ||
      attachment.size <= 0
    ) {
      throw new ValidationError("Invalid attachment.");
    }

    return {
      fileId: attachment.fileId,
      name: attachment.name.slice(0, 255),
      size: Math.floor(attachment.size),
      mimeType: attachment.mimeType.slice(0, 255),
      telegramMessageId: Math.floor(attachment.telegramMessageId),
    };
  });
}

function resolveSenderAddress(user: TMailUser, value: unknown): string {
  const requested = typeof value === "string" && value.trim()
    ? normalizeAddress(value)
    : user.tmailAddress;
  if (requested !== normalizeAddress(user.tmailAddress)) {
    throw new ValidationError("You can only send from your primary T-Mail address.");
  }

  return user.tmailAddress;
}

function readComposePayload(user: TMailUser, payload: unknown) {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const plainBody = readString(body.body, "body", MAX_BODY_LENGTH);

  return {
    from: resolveSenderAddress(user, body.from),
    to: readAddressList(body.to, "to"),
    cc: readAddressList(body.cc, "cc"),
    bcc: readAddressList(body.bcc, "bcc"),
    subject: readString(body.subject, "subject", MAX_SUBJECT_LENGTH),
    body: plainBody,
    bodyHtml: plainBody,
    attachments: readAttachments(body.attachments),
    replyTo: body.replyTo === null || body.replyTo === undefined
      ? null
      : readString(body.replyTo, "replyTo", 100),
  };
}

export function createComposeRouter(emailHandler: EmailHandler) {
  const router = Router();

  router.post("/send", async (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const payload = readComposePayload(user, req.body);
      const result = await emailHandler.send({
        from: payload.from,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        body: payload.body,
        bodyHtml: payload.bodyHtml,
        attachments: payload.attachments,
        replyTo: payload.replyTo,
      });

      res.json({ ok: true, data: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/draft", async (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const payload = readComposePayload(user, req.body);
      const draft = await emailHandler.saveDraft(user, {
        from: payload.from,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        body: payload.body,
        bodyHtml: payload.bodyHtml,
        attachments: payload.attachments,
        replyTo: payload.replyTo,
      });

      res.json({ ok: true, data: { draft } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
