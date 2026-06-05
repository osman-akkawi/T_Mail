import { Router, type Request } from "express";
import { Webhook } from "svix";
import { TMailError, UnauthorizedError, ValidationError } from "../../errors";
import { AttachmentHandler } from "../../handlers/attachment";
import { normalizeTMailAddress } from "../../services/address";
import { EmailService } from "../../services/email";
import { MasterIndexService } from "../../services/index";
import type { TMailAttachment, TMailUser } from "../../types";

/**
 * In-memory idempotency store keyed on the Svix delivery ID.
 * Resend reuses the same `svix-id` for every retry of the same webhook event,
 * so we can safely short-circuit duplicates within the process lifetime.
 * TTL is 24 h — longer than Resend's retry window.
 */
class InboundIdempotencyStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs = 24 * 60 * 60 * 1000;
  private lastCleanupAt = 0;
  private readonly cleanupIntervalMs = 60 * 60 * 1000; // hourly GC

  isDuplicate(svixId: string): boolean {
    this.maybeCleanup();
    const seenAt = this.seen.get(svixId);
    return seenAt !== undefined && Date.now() - seenAt < this.ttlMs;
  }

  record(svixId: string): void {
    this.seen.set(svixId, Date.now());
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = now;
    for (const [id, seenAt] of this.seen.entries()) {
      if (now - seenAt >= this.ttlMs) this.seen.delete(id);
    }
  }
}

const MB = 1024 * 1024;
const TELEGRAM_BOT_API_MAX_FILE_SIZE_BYTES = 50 * MB;
const MAX_INBOUND_RECIPIENTS = Math.max(
  1,
  Math.floor(Number(process.env.MAX_INBOUND_EMAIL_RECIPIENTS ?? 25)),
);
const MAX_INBOUND_BODY_LENGTH = Math.max(
  1,
  Math.floor(Number(process.env.MAX_INBOUND_EMAIL_BODY_LENGTH ?? 100_000)),
);
const MAX_INBOUND_ATTACHMENTS = Math.max(
  1,
  Math.floor(Number(process.env.MAX_INBOUND_ATTACHMENTS_PER_EMAIL ?? process.env.MAX_ATTACHMENTS_PER_EMAIL ?? 10)),
);
const MAX_INBOUND_ATTACHMENT_SIZE_BYTES = Math.min(
  Math.max(
    1,
    Math.floor(Number(process.env.MAX_INBOUND_ATTACHMENT_SIZE_MB ?? process.env.MAX_ATTACHMENT_SIZE_MB ?? 20)),
  ) * MB,
  TELEGRAM_BOT_API_MAX_FILE_SIZE_BYTES,
);

interface RawBodyRequest extends Request {
  rawBody?: string;
}

interface NormalizedInboundEmail {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  receivedAt: number;
  providerEmailId?: string;
}

interface ResendWebhookEvent {
  type?: string;
  data?: {
    email_id?: unknown;
    created_at?: unknown;
    from?: unknown;
    to?: unknown;
    cc?: unknown;
    bcc?: unknown;
    subject?: unknown;
  };
}

interface ResendReceivedAttachment {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  download_url: string;
}

class InboundEmailProviderError extends TMailError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode);
    this.name = "InboundEmailProviderError";
  }
}

function readString(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string.`);
  }
  if (value.length > maxLength) {
    return value.slice(0, maxLength);
  }
  return value;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    const named: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: "\"",
    };
    if (named[lower]) {
      return named[lower];
    }
    if (lower.startsWith("#x")) {
      const parsed = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    if (lower.startsWith("#")) {
      const parsed = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }
    return match;
  });
}

function htmlToReadableText(html: string): string {
  let cleaned = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][\s\S]*$/i, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");

  cleaned = decodeHtmlEntities(cleaned);
  return cleaned
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stripQuotedReply(text: string): string {
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const quoteIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return (
      /^On .+ wrote:$/i.test(trimmed) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed) ||
      /^_{5,}$/.test(trimmed)
    );
  });

  const unquoted = quoteIndex > 0 ? lines.slice(0, quoteIndex).join("\n") : normalized;
  return unquoted
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toReadableBody(text: string, html: string): string {
  const plain = stripQuotedReply(text);
  if (plain) {
    return plain;
  }

  return stripQuotedReply(htmlToReadableText(html));
}

function extractEmailAddress(value: string): string {
  const trimmed = value.trim();
  const bracketMatch = trimmed.match(/<([^<>]+)>$/);
  return (bracketMatch?.[1] ?? trimmed).trim().toLowerCase();
}

function readAddress(value: unknown, field: string): string {
  const address = extractEmailAddress(readString(value, field, 320));
  if (!address || /[\s<>"'\\]/.test(address)) {
    throw new ValidationError(`Invalid ${field}.`);
  }
  return address;
}

function readAddressList(value: unknown, field: string): string[] {
  if (typeof value === "string") {
    return [normalizeTMailAddress(readAddress(value, field))];
  }
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array.`);
  }
  if (value.length > MAX_INBOUND_RECIPIENTS) {
    throw new ValidationError(`${field} has too many recipients.`);
  }

  return value.map((item) => normalizeTMailAddress(readAddress(item, field)));
}

function readOptionalAddressList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  return readAddressList(value, field);
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Date.now();
}

function getResendApiKey(): string {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new UnauthorizedError("Resend API key is not configured.");
  }

  return apiKey;
}

function getResendReceivingBaseUrl(): string {
  const configuredBaseUrl = (process.env.RESEND_RECEIVING_API_URL ?? "").trim();
  return (configuredBaseUrl || "https://api.resend.com/emails/receiving").replace(/\/+$/, "");
}

function assertWebhookSecret(provided: string): void {
  const expected = (process.env.INBOUND_EMAIL_WEBHOOK_SECRET ?? "").trim();
  if (!expected) {
    throw new UnauthorizedError("Inbound email webhook is not configured.");
  }
  if (provided !== expected) {
    throw new UnauthorizedError("Invalid inbound email webhook secret.");
  }
}

function readRawBody(req: Request): string {
  const rawBody = (req as RawBodyRequest).rawBody;
  if (!rawBody) {
    throw new ValidationError("Webhook raw body is missing.");
  }

  return rawBody;
}

function verifyResendWebhook(req: Request): ResendWebhookEvent {
  const secret = (process.env.RESEND_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    throw new UnauthorizedError("Resend inbound webhook is not configured.");
  }

  try {
    return new Webhook(secret).verify(readRawBody(req), {
      "svix-id": String(req.headers["svix-id"] ?? ""),
      "svix-timestamp": String(req.headers["svix-timestamp"] ?? ""),
      "svix-signature": String(req.headers["svix-signature"] ?? ""),
    }) as ResendWebhookEvent;
  } catch (_error) {
    throw new UnauthorizedError("Invalid Resend inbound webhook signature.");
  }
}

async function fetchResendReceivedEmail(emailId: string): Promise<Record<string, unknown>> {
  const baseUrl = getResendReceivingBaseUrl();
  const response = await fetch(`${baseUrl}/${encodeURIComponent(emailId)}`, {
    headers: {
      Authorization: `Bearer ${getResendApiKey()}`,
      "Content-Type": "application/json",
      "User-Agent": "T-Mail Inbound Receiver",
    },
  });
  const raw = await response.text();
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (_error) {
    parsed = {};
  }

  if (!response.ok) {
    const details =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message?: unknown }).message)
        : raw || "Unknown provider error";
    throw new InboundEmailProviderError(
      `Inbound email fetch failed: ${details}`,
      response.status,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new InboundEmailProviderError("Inbound email fetch returned invalid JSON.");
  }

  return parsed as Record<string, unknown>;
}

function parseResendAttachment(value: unknown): ResendReceivedAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as Record<string, unknown>;
  const id = readString(item.id, "attachment.id", 120).trim();
  const filename = readString(item.filename, "attachment.filename", 255).trim();
  const contentType =
    readString(item.content_type, "attachment.content_type", 255).trim() ||
    "application/octet-stream";
  const downloadUrl = readString(item.download_url, "attachment.download_url", 2_048).trim();
  const sizeRaw = Number(item.size ?? 0);
  const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0;

  if (!id || !filename || !downloadUrl) {
    return null;
  }

  return { id, filename, content_type: contentType, download_url: downloadUrl, size };
}

async function fetchResendReceivedAttachments(emailId: string): Promise<ResendReceivedAttachment[]> {
  const baseUrl = getResendReceivingBaseUrl();
  const response = await fetch(`${baseUrl}/${encodeURIComponent(emailId)}/attachments`, {
    headers: {
      Authorization: `Bearer ${getResendApiKey()}`,
      "Content-Type": "application/json",
      "User-Agent": "T-Mail Inbound Receiver",
    },
  });
  const raw = await response.text();
  let parsed: unknown = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (_error) {
    parsed = {};
  }

  if (!response.ok) {
    const details =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message?: unknown }).message)
        : raw || "Unknown provider error";
    throw new InboundEmailProviderError(
      `Inbound attachment list failed: ${details}`,
      response.status,
    );
  }

  const data = parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
    ? (parsed as { data: unknown[] }).data
    : [];
  return data.map(parseResendAttachment).filter((item): item is ResendReceivedAttachment => Boolean(item));
}

async function downloadResendAttachment(attachment: ResendReceivedAttachment): Promise<{
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}> {
  if (attachment.size > MAX_INBOUND_ATTACHMENT_SIZE_BYTES) {
    const maxMb = Math.floor(MAX_INBOUND_ATTACHMENT_SIZE_BYTES / MB);
    throw new ValidationError(`Attachment "${attachment.filename}" exceeds ${maxMb}MB.`);
  }

  const response = await fetch(attachment.download_url, {
    headers: { "User-Agent": "T-Mail Inbound Receiver" },
  });
  if (!response.ok) {
    throw new InboundEmailProviderError(
      `Inbound attachment download failed for ${attachment.filename}`,
      response.status,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_INBOUND_ATTACHMENT_SIZE_BYTES) {
    const maxMb = Math.floor(MAX_INBOUND_ATTACHMENT_SIZE_BYTES / MB);
    throw new ValidationError(`Attachment "${attachment.filename}" exceeds ${maxMb}MB.`);
  }

  return {
    buffer,
    originalname: attachment.filename,
    mimetype: attachment.content_type || "application/octet-stream",
    size: buffer.length,
  };
}

async function normalizeResendInboundEmail(req: Request): Promise<NormalizedInboundEmail | null> {
  const event = verifyResendWebhook(req);
  if (event.type !== "email.received") {
    return null;
  }

  const emailId = readString(event.data?.email_id, "email_id", 120).trim();
  if (!emailId) {
    throw new ValidationError("Resend inbound webhook is missing email_id.");
  }

  const email = await fetchResendReceivedEmail(emailId);
  const text = readString(email.text, "text", MAX_INBOUND_BODY_LENGTH);
  const html = readString(email.html, "html", MAX_INBOUND_BODY_LENGTH);
  const metadata = event.data ?? {};

  return {
    from: readAddress(email.from ?? metadata.from, "from"),
    to: readAddressList(email.to ?? metadata.to, "to"),
    cc: readOptionalAddressList(email.cc ?? metadata.cc, "cc"),
    bcc: readOptionalAddressList(email.bcc ?? metadata.bcc, "bcc"),
    subject: readString(email.subject ?? metadata.subject, "subject", 300) || "(no subject)",
    text,
    html,
    receivedAt: parseTimestamp(email.created_at ?? metadata.created_at),
    providerEmailId: emailId,
  };
}

function normalizeSimpleInboundEmail(req: Request): NormalizedInboundEmail {
  assertWebhookSecret(String(req.headers["x-tmail-webhook-secret"] ?? ""));

  const body = req.body && typeof req.body === "object"
    ? req.body as Record<string, unknown>
    : {};

  return {
    from: readAddress(body.from, "from"),
    to: readAddressList(body.to, "to"),
    cc: readOptionalAddressList(body.cc, "cc"),
    bcc: readOptionalAddressList(body.bcc, "bcc"),
    subject: readString(body.subject, "subject", 300) || "(no subject)",
    text: readString(body.text ?? body.body, "text", MAX_INBOUND_BODY_LENGTH),
    html: readString(body.html, "html", MAX_INBOUND_BODY_LENGTH),
    receivedAt: parseTimestamp(body.receivedAt),
  };
}

function resolveUniqueRecipients(indexService: MasterIndexService, inbound: NormalizedInboundEmail): TMailUser[] {
  const users = new Map<number, TMailUser>();
  for (const address of [...inbound.to, ...inbound.cc, ...inbound.bcc]) {
    const user = indexService.lookupByAddress(address);
    if (user) {
      users.set(user.telegramUserId, user);
    }
  }
  return Array.from(users.values());
}

function appendAttachmentNotes(body: string, notes: string[]): string {
  if (notes.length === 0) {
    return body;
  }

  return `${body || "(no message body)"}\n\n${notes.join("\n")}`;
}

async function storeInboundAttachments(params: {
  inbound: NormalizedInboundEmail;
  indexService: MasterIndexService;
  attachmentHandler: AttachmentHandler;
}): Promise<{ attachmentsByAddress: Record<string, TMailAttachment[]>; notes: string[] }> {
  if (!params.inbound.providerEmailId) {
    return { attachmentsByAddress: {}, notes: [] };
  }

  const recipients = resolveUniqueRecipients(params.indexService, params.inbound);
  if (recipients.length === 0) {
    return { attachmentsByAddress: {}, notes: [] };
  }

  const listed = await fetchResendReceivedAttachments(params.inbound.providerEmailId);
  const limited = listed.slice(0, MAX_INBOUND_ATTACHMENTS);
  const notes: string[] = [];
  if (listed.length > limited.length) {
    notes.push(`Attachment note: only the first ${MAX_INBOUND_ATTACHMENTS} file(s) were saved.`);
  }

  const downloaded: Array<Awaited<ReturnType<typeof downloadResendAttachment>>> = [];
  for (const attachment of limited) {
    try {
      downloaded.push(await downloadResendAttachment(attachment));
    } catch (error) {
      const message = error instanceof Error ? error.message : "download failed";
      notes.push(`Attachment skipped: ${attachment.filename} (${message})`);
    }
  }

  const attachmentsByAddress: Record<string, TMailAttachment[]> = {};
  for (const user of recipients) {
    const stored: TMailAttachment[] = [];
    for (const file of downloaded) {
      try {
        stored.push(await params.attachmentHandler.uploadInbound(user, file));
      } catch (error) {
        const message = error instanceof Error ? error.message : "upload failed";
        notes.push(`Attachment skipped for ${user.tmailAddress}: ${file.originalname} (${message})`);
      }
    }
    if (stored.length > 0) {
      attachmentsByAddress[user.tmailAddress] = stored;
    }
  }

  return { attachmentsByAddress, notes: Array.from(new Set(notes)) };
}

export function createInboundEmailRouter(params: {
  emailService: EmailService;
  indexService: MasterIndexService;
  attachmentHandler: AttachmentHandler;
}) {
  const router = Router();
  const idempotencyStore = new InboundIdempotencyStore();

  router.post("/", async (req, res, next) => {
    try {
      // Extract the Svix delivery ID before any processing.
      // Resend reuses the same svix-id on every retry of the same event,
      // so we can reject duplicates without doing any expensive work.
      const svixId = String(req.headers["svix-id"] ?? "").trim();
      if (svixId && idempotencyStore.isDuplicate(svixId)) {
        res.json({ ok: true, data: { ignored: true, duplicate: true } });
        return;
      }

      const body = req.body && typeof req.body === "object"
        ? req.body as Record<string, unknown>
        : {};
      const inbound = body.type === "email.received"
        ? await normalizeResendInboundEmail(req)
        : normalizeSimpleInboundEmail(req);

      if (!inbound) {
        res.json({ ok: true, data: { ignored: true } });
        return;
      }

      const attachmentResult = await storeInboundAttachments({
        inbound,
        indexService: params.indexService,
        attachmentHandler: params.attachmentHandler,
      });
      const readableBody = appendAttachmentNotes(
        toReadableBody(inbound.text, inbound.html),
        attachmentResult.notes,
      );
      if (!readableBody && Object.keys(attachmentResult.attachmentsByAddress).length === 0) {
        throw new ValidationError("Inbound email body is empty.");
      }

      const result = await params.emailService.receiveExternalEmail({
        from: inbound.from,
        to: inbound.to,
        cc: inbound.cc,
        bcc: inbound.bcc,
        attachmentsByAddress: attachmentResult.attachmentsByAddress,
        subject: inbound.subject,
        body: readableBody || "(no message body)",
        bodyHtml: readableBody || "(no message body)",
        receivedAt: inbound.receivedAt,
      });

      // Record the svix-id only after successful delivery.
      // If we recorded it before and then crashed, the event would be
      // silently dropped on the next retry — recording after success means
      // a transient error is retried correctly.
      if (svixId) {
        idempotencyStore.record(svixId);
      }

      res.json({
        ok: true,
        data: {
          deliveredTo: result.deliveredTo,
          unknownRecipients: result.unknownRecipients,
          count: result.emails.length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
