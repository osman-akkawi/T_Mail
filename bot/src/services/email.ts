import { randomUUID } from "crypto";
import { NotFoundError, ValidationError } from "../errors";
import type { SendEmailInput, TMailAttachment, TMailEmail, TMailFolder, TMailUser } from "../types";
import { TelegramClient } from "../telegram/client";
import { isManagedTMailAddress } from "./address";
import type { ExternalEmailAttachment, ExternalEmailTransport } from "./external-email";
import { MasterIndexService } from "./index";
import {
  getEmailPayloadStorageBytes,
  getStorageLimitBytes,
  isStorageUnlimited,
  normalizeStorageBytes,
} from "./storage-accounting";
import { ThreadService } from "./thread";

const MB = 1024 * 1024;
const TELEGRAM_BOT_API_MAX_FILE_SIZE_BYTES = 50 * MB;

// Telegram Bot API caps message text at 4 096 characters.  Long email bodies
// are truncated only in the Telegram channel record (the audit trail written
// to inbox/sent/drafts/trash channels).  The full body is always kept in
// memory and returned to the Mini App unchanged.
const TELEGRAM_RECORD_MAX_BODY_CHARS = 1_500;
const ACTION_KEYWORDS = [
  "urgent",
  "asap",
  "today",
  "tomorrow",
  "deadline",
  "due",
  "invoice",
  "payment",
  "pay",
  "review",
  "approve",
  "sign",
  "contract",
  "meeting",
  "schedule",
  "confirm",
  "?",
];

export interface MailButlerEmailSummary {
  id: string;
  folder: TMailFolder;
  from: string;
  subject: string;
  preview: string;
  date: number;
  reason: string;
  replySuggestion?: string;
}

export interface MailButlerInsights {
  unreadCount: number;
  actionCount: number;
  attachmentCount: number;
  draftCount: number;
  spamCount: number;
  priority: MailButlerEmailSummary[];
  suggestedReplies: MailButlerEmailSummary[];
  digest: string[];
}

export type ExternalAttachmentResolver =
  (attachment: TMailAttachment) => Promise<ExternalEmailAttachment>;

export interface ReceiveExternalEmailInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  attachmentsByAddress?: Record<string, TMailAttachment[]>;
  subject: string;
  body: string;
  bodyHtml?: string;
  receivedAt?: number;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function folderKey(address: string, folder: TMailFolder): string {
  return `${address.toLowerCase()}::${folder}`;
}

function toPreviewBody(body: string): string {
  return body.length > 120 ? `${body.slice(0, 117)}...` : body;
}

function summarizeBody(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class EmailService {
  private readonly emailsByFolder = new Map<string, TMailEmail[]>();
  private readonly mailboxStorageCache = new Map<string, number>();
  private readonly maxAttachmentsPerEmail: number;
  private readonly maxAttachmentSizeBytes: number;
  private readonly maxTotalAttachmentsSizeBytes: number;

  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly indexService: MasterIndexService,
    private readonly threadService: ThreadService,
    private readonly externalEmailTransport: ExternalEmailTransport | null = null,
    private readonly externalAttachmentResolver: ExternalAttachmentResolver | null = null,
  ) {
    this.maxAttachmentsPerEmail = Math.floor(
      parsePositiveNumber(process.env.MAX_ATTACHMENTS_PER_EMAIL, 10),
    );
    this.maxAttachmentSizeBytes = Math.min(
      Math.floor(parsePositiveNumber(process.env.MAX_ATTACHMENT_SIZE_MB, 20) * MB),
      TELEGRAM_BOT_API_MAX_FILE_SIZE_BYTES,
    );
    this.maxTotalAttachmentsSizeBytes = Math.floor(
      parsePositiveNumber(process.env.MAX_TOTAL_ATTACHMENTS_SIZE_MB, 45) * MB,
    );
  }

  private getFolderEmails(address: string, folder: TMailFolder): TMailEmail[] {
    const key = folderKey(address, folder);
    return this.emailsByFolder.get(key) ?? [];
  }

  private getMailboxCacheKey(address: string): string {
    return address.toLowerCase();
  }

  private invalidateMailboxStorage(address: string): void {
    this.mailboxStorageCache.delete(this.getMailboxCacheKey(address));
  }

  private setFolderEmails(address: string, folder: TMailFolder, emails: TMailEmail[]): void {
    const key = folderKey(address, folder);
    this.emailsByFolder.set(key, emails);
    this.invalidateMailboxStorage(address);
  }

  private pushEmail(address: string, folder: TMailFolder, email: TMailEmail): void {
    const current = this.getFolderEmails(address, folder);
    const insertAt = current.findIndex((item) => item.date < email.date);
    if (insertAt === -1) {
      this.setFolderEmails(address, folder, [...current, email]);
      return;
    }

    this.setFolderEmails(address, folder, [
      ...current.slice(0, insertAt),
      email,
      ...current.slice(insertAt),
    ]);
  }

  /**
   * Return a copy of the email safe to embed in a Telegram channel record.
   * `body` and `bodyHtml` are truncated to TELEGRAM_RECORD_MAX_BODY_CHARS so
   * the serialised JSON never exceeds Telegram's 4 096-character message limit.
   * The original in-memory email object is not modified.
   */
  private truncateEmailForRecord(email: TMailEmail): TMailEmail {
    if (
      email.body.length <= TELEGRAM_RECORD_MAX_BODY_CHARS &&
      email.bodyHtml.length <= TELEGRAM_RECORD_MAX_BODY_CHARS
    ) {
      return email; // nothing to truncate — avoid creating a needless copy
    }

    const truncate = (text: string): string =>
      text.length > TELEGRAM_RECORD_MAX_BODY_CHARS
        ? `${text.slice(0, TELEGRAM_RECORD_MAX_BODY_CHARS)}…[full body in app]`
        : text;

    return { ...email, body: truncate(email.body), bodyHtml: truncate(email.bodyHtml) };
  }

  private renderChannelRecord(folder: TMailFolder, email: TMailEmail): string {
    // Use the truncated copy for the JSON block only; header lines still show
    // the real preview so the Telegram channel remains human-readable.
    const recordEmail = this.truncateEmailForRecord(email);
    return [
      `<b>T-Mail ${folder.toUpperCase()}</b>`,
      `From: ${escapeHtml(email.from)}`,
      `To: ${email.to.map(escapeHtml).join(", ")}`,
      `Subject: ${escapeHtml(email.subject || "(no subject)")}`,
      `Body: ${escapeHtml(toPreviewBody(email.body))}`,
      `Record: <code>${escapeHtml(email.id)}</code>`,
      `<pre>${escapeHtml(JSON.stringify(recordEmail, null, 2))}</pre>`,
    ].join("\n");
  }

  private getChannelRecordStorageBytes(folder: TMailFolder, email: TMailEmail): number {
    return Buffer.byteLength(this.renderChannelRecord(folder, email), "utf8");
  }

  private assertStorageAvailable(
    entries: Array<{ user: TMailUser; additionalBytes: number }>,
  ): void {
    const byAddress = new Map<string, { user: TMailUser; additionalBytes: number }>();

    for (const entry of entries) {
      const current = this.indexService.lookupByAddress(entry.user.tmailAddress) ?? entry.user;
      const key = current.tmailAddress.toLowerCase();
      const existing = byAddress.get(key);
      const additionalBytes = normalizeStorageBytes(entry.additionalBytes);
      if (existing) {
        existing.additionalBytes += additionalBytes;
      } else {
        byAddress.set(key, { user: current, additionalBytes });
      }
    }

    for (const entry of byAddress.values()) {
      const used = normalizeStorageBytes(entry.user.storageUsed);
      const limit = getStorageLimitBytes(entry.user);
      if (!isStorageUnlimited(limit) && used + entry.additionalBytes > limit) {
        throw new ValidationError(`Storage limit exceeded for ${entry.user.tmailAddress}.`);
      }
    }
  }

  private async recordStorageUsed(user: TMailUser, additionalBytes: number): Promise<void> {
    await this.indexService.incrementStorageUsed(user.tmailAddress, additionalBytes);
  }

  private resolveRecipients(addresses: string[]): { internal: TMailUser[]; external: string[] } {
    const resolved = new Map<number, TMailUser>();
    const external = new Set<string>();

    for (const address of addresses) {
      const user = this.indexService.lookupByAddress(address);
      if (user) {
        resolved.set(user.telegramUserId, user);
        continue;
      }

      if (isManagedTMailAddress(address)) {
        throw new NotFoundError(`Recipient not found: ${address}`);
      }

      external.add(address);
    }

    return {
      internal: Array.from(resolved.values()),
      external: Array.from(external.values()),
    };
  }

  private validateAttachments(attachments: SendEmailInput["attachments"]): void {
    const list = attachments ?? [];
    if (list.length > this.maxAttachmentsPerEmail) {
      throw new ValidationError(
        `Too many attachments (${this.maxAttachmentsPerEmail} max per email)`,
      );
    }

    let totalSize = 0;
    for (const attachment of list) {
      if (attachment.size <= 0) {
        throw new ValidationError(`Attachment "${attachment.name}" is empty`);
      }
      if (attachment.size > this.maxAttachmentSizeBytes) {
        const maxMb = Math.floor(this.maxAttachmentSizeBytes / MB);
        throw new ValidationError(
          `Attachment "${attachment.name}" exceeds ${maxMb}MB per-file limit`,
        );
      }
      totalSize += attachment.size;
    }

    if (totalSize > this.maxTotalAttachmentsSizeBytes) {
      const maxTotalMb = Math.floor(this.maxTotalAttachmentsSizeBytes / MB);
      throw new ValidationError(`Total attachment size exceeds ${maxTotalMb}MB per email`);
    }
  }

  private async resolveExternalAttachments(
    attachments: TMailAttachment[],
  ): Promise<ExternalEmailAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    const resolver = this.externalAttachmentResolver;
    if (!resolver) {
      throw new ValidationError("External email attachments are not configured.");
    }

    const resolved = await Promise.all(
      attachments.map((attachment) => resolver(attachment)),
    );
    let totalSize = 0;
    for (const attachment of resolved) {
      if (!attachment) {
        throw new ValidationError("External email attachment could not be prepared.");
      }
      if (attachment.size <= 0) {
        throw new ValidationError(`Attachment "${attachment.filename}" is empty`);
      }
      if (attachment.size > this.maxAttachmentSizeBytes) {
        const maxMb = Math.floor(this.maxAttachmentSizeBytes / MB);
        throw new ValidationError(
          `Attachment "${attachment.filename}" exceeds ${maxMb}MB per-file limit`,
        );
      }
      totalSize += attachment.size;
    }

    if (totalSize > this.maxTotalAttachmentsSizeBytes) {
      const maxTotalMb = Math.floor(this.maxTotalAttachmentsSizeBytes / MB);
      throw new ValidationError(`Total attachment size exceeds ${maxTotalMb}MB per email`);
    }

    return resolved;
  }

  async sendEmail(input: SendEmailInput): Promise<{ email: TMailEmail; deliveredTo: string[] }> {
    const cc = input.cc ?? [];
    const bcc = input.bcc ?? [];
    const recipientAddresses = [...input.to, ...cc, ...bcc];
    if (recipientAddresses.length === 0) {
      throw new ValidationError("At least one recipient is required");
    }
    this.validateAttachments(input.attachments);

    const sender = this.indexService.lookupByAddress(input.from);
    if (!sender) {
      throw new NotFoundError(`Sender ${input.from} not found`);
    }

    const { internal: recipients, external: externalRecipientAddresses } =
      this.resolveRecipients(recipientAddresses);
    if (externalRecipientAddresses.length > 0 && !this.externalEmailTransport) {
      throw new NotFoundError(
        `Recipient not found in T-Mail and external email sending is not configured: ${externalRecipientAddresses[0]}`,
      );
    }
    const bccRecipientIds = new Set(
      bcc
        .map((address) => this.indexService.lookupByAddress(address)?.telegramUserId)
        .filter((telegramUserId): telegramUserId is number => typeof telegramUserId === "number"),
    );
    const threadId = input.replyTo ? this.findThreadIdByEmailId(sender, input.replyTo) : this.threadService.createThreadId();

    const baseEmail: Omit<TMailEmail, "telegramMessageId"> = {
      id: randomUUID(),
      from: input.from,
      to: input.to,
      cc,
      bcc,
      subject: input.subject,
      body: input.body,
      bodyHtml: input.bodyHtml ?? input.body,
      attachments: input.attachments ?? [],
      date: Date.now(),
      status: "unread",
      threadId,
      replyTo: input.replyTo ?? null,
      labels: [],
      starred: false,
    };
    const senderRecordBytes = this.getChannelRecordStorageBytes("sent", {
      ...baseEmail,
      telegramMessageId: 0,
    });

    const makeInboxEmail = (recipient: TMailUser, telegramMessageId: number): TMailEmail => ({
      ...baseEmail,
      bcc: bccRecipientIds.has(recipient.telegramUserId) ? [recipient.tmailAddress] : [],
      telegramMessageId,
    });

    this.assertStorageAvailable([
      { user: sender, additionalBytes: senderRecordBytes },
      ...recipients.map((recipient) => ({
        user: recipient,
        additionalBytes: this.getChannelRecordStorageBytes("inbox", makeInboxEmail(recipient, 0)),
      })),
    ]);

    if (externalRecipientAddresses.length > 0 && this.externalEmailTransport) {
      const externalAttachments = await this.resolveExternalAttachments(input.attachments ?? []);
      const externalSet = new Set(externalRecipientAddresses);
      const externalTo = input.to.filter((address) => externalSet.has(address));
      if (externalTo.length === 0) {
        throw new ValidationError("External email requires at least one external To recipient.");
      }

      await this.externalEmailTransport.send({
        from: input.from,
        to: externalTo,
        cc: cc.filter((address) => externalSet.has(address)),
        bcc: bcc.filter((address) => externalSet.has(address)),
        subject: input.subject,
        text: input.body,
        html: input.bodyHtml,
        attachments: externalAttachments,
      });
    }

    const sentMsg = await this.telegramClient.postMessage(
      sender.channels.sent,
      this.renderChannelRecord("sent", { ...baseEmail, telegramMessageId: 0 }),
    );

    const senderEmail: TMailEmail = {
      ...baseEmail,
      status: "read",
      telegramMessageId: sentMsg.messageId,
    };
    this.pushEmail(sender.tmailAddress, "sent", senderEmail);
    await this.recordStorageUsed(sender, senderRecordBytes);

    for (const recipient of recipients) {
      const inboxRecord = makeInboxEmail(recipient, 0);
      const inboxPost = await this.telegramClient.postMessage(
        recipient.channels.inbox,
        this.renderChannelRecord("inbox", inboxRecord),
      );

      const inboxEmail = makeInboxEmail(recipient, inboxPost.messageId);
      this.pushEmail(recipient.tmailAddress, "inbox", inboxEmail);
      await this.recordStorageUsed(
        recipient,
        this.getChannelRecordStorageBytes("inbox", inboxEmail),
      );
    }

    return {
      email: senderEmail,
      deliveredTo: [...recipients.map((r) => r.tmailAddress), ...externalRecipientAddresses],
    };
  }

  async saveDraft(
    user: TMailUser,
    input: Omit<SendEmailInput, "from"> & { from?: string },
  ): Promise<TMailEmail> {
    this.validateAttachments(input.attachments);

    const draft: TMailEmail = {
      id: randomUUID(),
      from: input.from ?? user.tmailAddress,
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject,
      body: input.body,
      bodyHtml: input.bodyHtml ?? input.body,
      attachments: input.attachments ?? [],
      date: Date.now(),
      status: "draft",
      threadId: this.threadService.createThreadId(),
      replyTo: input.replyTo ?? null,
      labels: ["draft"],
      starred: false,
      telegramMessageId: 0,
    };
    const draftRecordBytes = this.getChannelRecordStorageBytes("drafts", draft);
    this.assertStorageAvailable([{ user, additionalBytes: draftRecordBytes }]);

    const post = await this.telegramClient.postMessage(
      user.channels.drafts,
      this.renderChannelRecord("drafts", draft),
    );

    draft.telegramMessageId = post.messageId;
    this.pushEmail(user.tmailAddress, "drafts", draft);
    await this.recordStorageUsed(user, draftRecordBytes);
    return draft;
  }

  async receiveExternalEmail(input: ReceiveExternalEmailInput): Promise<{
    emails: TMailEmail[];
    deliveredTo: string[];
    unknownRecipients: string[];
  }> {
    const recipients = new Map<number, TMailUser>();
    const unknownRecipients: string[] = [];
    const visibleBccRecipients = new Set(input.bcc ?? []);
    const attachmentsByAddress = input.attachmentsByAddress ?? {};

    for (const address of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
      const user = this.indexService.lookupByAddress(address);
      if (user) {
        recipients.set(user.telegramUserId, user);
      } else {
        unknownRecipients.push(address);
      }
    }

    const recipientUsers = Array.from(recipients.values());
    if (recipientUsers.length === 0) {
      return { emails: [], deliveredTo: [], unknownRecipients };
    }

    const baseEmail: Omit<TMailEmail, "telegramMessageId"> = {
      id: randomUUID(),
      from: input.from,
      to: input.to,
      cc: input.cc ?? [],
      bcc: [],
      subject: input.subject,
      body: input.body,
      bodyHtml: input.bodyHtml ?? input.body,
      attachments: [],
      date: input.receivedAt ?? Date.now(),
      status: "unread",
      threadId: this.threadService.createThreadId(),
      replyTo: null,
      labels: ["external"],
      starred: false,
    };

    const makeInboxEmail = (user: TMailUser, telegramMessageId: number): TMailEmail => ({
      ...baseEmail,
      attachments: attachmentsByAddress[user.tmailAddress] ?? [],
      bcc: visibleBccRecipients.has(user.tmailAddress) ? [user.tmailAddress] : [],
      telegramMessageId,
    });

    this.assertStorageAvailable(
      recipientUsers.map((user) => ({
        user,
        additionalBytes: this.getChannelRecordStorageBytes("inbox", makeInboxEmail(user, 0)),
      })),
    );

    const emails: TMailEmail[] = [];
    for (const user of recipientUsers) {
      const inboxRecord = makeInboxEmail(user, 0);
      const posted = await this.telegramClient.postMessage(
        user.channels.inbox,
        this.renderChannelRecord("inbox", inboxRecord),
      );

      const inboxEmail = makeInboxEmail(user, posted.messageId);
      this.pushEmail(user.tmailAddress, "inbox", inboxEmail);
      await this.recordStorageUsed(user, this.getChannelRecordStorageBytes("inbox", inboxEmail));
      emails.push(inboxEmail);
    }

    return {
      emails,
      deliveredTo: recipientUsers.map((user) => user.tmailAddress),
      unknownRecipients,
    };
  }

  listEmails(user: TMailUser, folder: TMailFolder, limit: number, offset: number): TMailEmail[] {
    return this.getFolderEmails(user.tmailAddress, folder).slice(offset, offset + limit);
  }

  getEmail(user: TMailUser, folder: TMailFolder, emailId: string): TMailEmail {
    const email = this.getFolderEmails(user.tmailAddress, folder).find((e) => e.id === emailId);
    if (!email) {
      throw new NotFoundError(`Email not found: ${emailId}`);
    }
    return email;
  }

  updateEmail(
    user: TMailUser,
    folder: TMailFolder,
    emailId: string,
    updates: Partial<Pick<TMailEmail, "status" | "starred" | "labels" | "subject" | "body" | "bodyHtml">>,
  ): TMailEmail {
    const emails = this.getFolderEmails(user.tmailAddress, folder);
    const index = emails.findIndex((e) => e.id === emailId);
    if (index === -1) {
      throw new NotFoundError(`Email not found: ${emailId}`);
    }

    const updated: TMailEmail = { ...emails[index], ...updates };
    const next = [...emails];
    next[index] = updated;
    this.setFolderEmails(user.tmailAddress, folder, next);
    return updated;
  }

  async deleteEmail(user: TMailUser, folder: TMailFolder, emailId: string): Promise<void> {
    const emails = this.getFolderEmails(user.tmailAddress, folder);
    const target = emails.find((e) => e.id === emailId);
    if (!target) {
      throw new NotFoundError(`Email not found: ${emailId}`);
    }

    this.setFolderEmails(
      user.tmailAddress,
      folder,
      emails.filter((e) => e.id !== emailId),
    );

    const trashCopy: TMailEmail = {
      ...target,
      labels: Array.from(new Set([...(target.labels ?? []), "trash"])),
    };
    const trashRecordBytes = this.getChannelRecordStorageBytes("trash", trashCopy);
    this.assertStorageAvailable([{ user, additionalBytes: trashRecordBytes }]);

    const post = await this.telegramClient.postMessage(
      user.channels.trash,
      this.renderChannelRecord("trash", trashCopy),
    );

    trashCopy.telegramMessageId = post.messageId;
    this.pushEmail(user.tmailAddress, "trash", trashCopy);
    await this.recordStorageUsed(user, trashRecordBytes);
  }

  getThread(user: TMailUser, threadId: string): TMailEmail[] {
    const all: TMailEmail[] = [
      ...this.getFolderEmails(user.tmailAddress, "inbox"),
      ...this.getFolderEmails(user.tmailAddress, "sent"),
      ...this.getFolderEmails(user.tmailAddress, "drafts"),
      ...this.getFolderEmails(user.tmailAddress, "trash"),
      ...this.getFolderEmails(user.tmailAddress, "spam"),
    ];

    return all
      .filter((email) => email.threadId === threadId)
      .sort((a, b) => a.date - b.date);
  }

  search(user: TMailUser, query: string): TMailEmail[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      return [];
    }

    const all: TMailEmail[] = [
      ...this.getFolderEmails(user.tmailAddress, "inbox"),
      ...this.getFolderEmails(user.tmailAddress, "sent"),
      ...this.getFolderEmails(user.tmailAddress, "drafts"),
      ...this.getFolderEmails(user.tmailAddress, "trash"),
      ...this.getFolderEmails(user.tmailAddress, "spam"),
    ];

    return all
      .filter((email) => {
        return (
          email.subject.toLowerCase().includes(q) ||
          email.body.toLowerCase().includes(q) ||
          email.from.toLowerCase().includes(q) ||
          email.to.some((x) => x.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => b.date - a.date)
      .slice(0, 100);
  }

  getMailButlerInsights(user: TMailUser): MailButlerInsights {
    const inbox = this.getFolderEmails(user.tmailAddress, "inbox");
    const drafts = this.getFolderEmails(user.tmailAddress, "drafts");
    const spam = this.getFolderEmails(user.tmailAddress, "spam");
    const unread = inbox.filter((email) => email.status === "unread");
    const actionItems = inbox.filter((email) => this.emailNeedsAction(email));
    const withAttachments = inbox.filter((email) => email.attachments.length > 0);

    const priority = [...actionItems]
      .sort((left, right) => this.scoreEmail(right) - this.scoreEmail(left))
      .slice(0, 5)
      .map((email) => this.toButlerSummary(email, "inbox", this.explainEmailPriority(email)));

    const suggestedReplies = unread
      .filter((email) => email.from !== user.tmailAddress)
      .slice(0, 3)
      .map((email) => this.toButlerSummary(
        email,
        "inbox",
        "Unread message that may need a response.",
        this.suggestReply(email),
      ));

    const digest = [
      unread.length > 0
        ? `${unread.length} unread message${unread.length === 1 ? "" : "s"} need attention.`
        : "Inbox is clear — no unread messages.",
      actionItems.length > 0
        ? `${actionItems.length} message${actionItems.length === 1 ? "" : "s"} look action-oriented.`
        : "No urgent action keywords detected.",
      withAttachments.length > 0
        ? `${withAttachments.length} inbox message${withAttachments.length === 1 ? "" : "s"} include attachments.`
        : "No inbox attachments to review right now.",
      drafts.length > 0
        ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} waiting to be finished.`
        : "No drafts are waiting.",
      spam.length > 0
        ? `⚠️ ${spam.length} message${spam.length === 1 ? "" : "s"} in your Spam folder.`
        : "No spam detected in your mailbox.",
    ];

    return {
      unreadCount: unread.length,
      actionCount: actionItems.length,
      attachmentCount: withAttachments.length,
      draftCount: drafts.length,
      spamCount: spam.length,
      priority,
      suggestedReplies,
      digest,
    };
  }

  private findThreadIdByEmailId(user: TMailUser, emailId: string): string {
    const folders: TMailFolder[] = ["inbox", "sent", "drafts", "trash", "spam"];
    for (const folder of folders) {
      const found = this.getFolderEmails(user.tmailAddress, folder).find((e) => e.id === emailId);
      if (found) {
        return found.threadId;
      }
    }

    return this.threadService.createThreadId();
  }

  private emailNeedsAction(email: TMailEmail): boolean {
    const haystack = `${email.subject} ${email.body}`.toLowerCase();
    return ACTION_KEYWORDS.some((keyword) => haystack.includes(keyword));
  }

  private scoreEmail(email: TMailEmail): number {
    let score = email.status === "unread" ? 20 : 0;
    const haystack = `${email.subject} ${email.body}`.toLowerCase();
    for (const keyword of ACTION_KEYWORDS) {
      if (haystack.includes(keyword)) {
        score += keyword === "urgent" || keyword === "asap" ? 15 : 8;
      }
    }
    if (email.attachments.length > 0) {
      score += 6;
    }
    score += Math.max(0, 10 - Math.floor((Date.now() - email.date) / (24 * 60 * 60 * 1000)));
    return score;
  }

  private explainEmailPriority(email: TMailEmail): string {
    const haystack = `${email.subject} ${email.body}`.toLowerCase();
    const matched = ACTION_KEYWORDS.find((keyword) => haystack.includes(keyword));
    if (matched) {
      return `Detected action keyword: "${matched}".`;
    }
    if (email.attachments.length > 0) {
      return "Contains attachments to review.";
    }
    return "Recent unread message.";
  }

  private suggestReply(email: TMailEmail): string {
    const haystack = `${email.subject} ${email.body}`.toLowerCase();
    if (haystack.includes("?") || haystack.includes("confirm")) {
      return "Thanks — I saw this. I’ll confirm and get back to you shortly.";
    }
    if (haystack.includes("invoice") || haystack.includes("payment") || haystack.includes("pay")) {
      return "Thanks for sending this. I’ll review the payment details and follow up.";
    }
    if (haystack.includes("meeting") || haystack.includes("schedule")) {
      return "Thanks — I’ll check my schedule and reply with availability.";
    }
    return "Thanks — received. I’ll review this and get back to you.";
  }

  private toButlerSummary(
    email: TMailEmail,
    folder: TMailFolder,
    reason: string,
    replySuggestion?: string,
  ): MailButlerEmailSummary {
    return {
      id: email.id,
      folder,
      from: email.from,
      subject: email.subject || "(no subject)",
      preview: summarizeBody(email.body),
      date: email.date,
      reason,
      replySuggestion,
    };
  }

  /**
   * Move an email from its current folder into the spam folder.
   * Works in-memory (same as deleteEmail → trash).  If the user's channel
   * doesn't have a spam channel yet we fall back to in-memory-only storage
   * so the move still works without a Telegram channel write.
   */
  async moveToSpam(user: TMailUser, folder: TMailFolder, emailId: string): Promise<void> {
    const emails = this.getFolderEmails(user.tmailAddress, folder);
    const target = emails.find((e) => e.id === emailId);
    if (!target) {
      throw new NotFoundError(`Email not found: ${emailId}`);
    }

    // Remove from source folder
    this.setFolderEmails(
      user.tmailAddress,
      folder,
      emails.filter((e) => e.id !== emailId),
    );

    // Push copy to spam
    const spamCopy: TMailEmail = {
      ...target,
      labels: Array.from(new Set([...(target.labels ?? []), "spam"])),
    };

    this.pushEmail(user.tmailAddress, "spam", spamCopy);
  }

  /**
   * Move an email from spam back to inbox ("not spam" / "report not spam").
   */
  markNotSpam(user: TMailUser, emailId: string): void {
    const spamEmails = this.getFolderEmails(user.tmailAddress, "spam");
    const target = spamEmails.find((e) => e.id === emailId);
    if (!target) {
      throw new NotFoundError(`Email not found in spam: ${emailId}`);
    }

    this.setFolderEmails(
      user.tmailAddress,
      "spam",
      spamEmails.filter((e) => e.id !== emailId),
    );

    const inboxCopy: TMailEmail = {
      ...target,
      labels: (target.labels ?? []).filter((l) => l !== "spam"),
      status: "unread",
    };
    this.pushEmail(user.tmailAddress, "inbox", inboxCopy);
  }

  calculateMailboxStorageUsed(user: TMailUser): number {
    const cacheKey = this.getMailboxCacheKey(user.tmailAddress);
    const cached = this.mailboxStorageCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const folders: TMailFolder[] = ["inbox", "sent", "drafts", "trash", "spam"];
    const seenAttachmentIds = new Set<string>();
    let channelRecordTotal = 0;

    for (const folder of folders) {
      for (const email of this.getFolderEmails(user.tmailAddress, folder)) {
        channelRecordTotal += this.getChannelRecordStorageBytes(folder, email);

        for (const attachment of email.attachments) {
          if (seenAttachmentIds.has(attachment.fileId)) {
            continue;
          }

          seenAttachmentIds.add(attachment.fileId);
          channelRecordTotal += normalizeStorageBytes(attachment.size);
        }
      }
    }

    const used = Math.max(channelRecordTotal, this.getMailboxPayloadStorageUsed(user));
    this.mailboxStorageCache.set(cacheKey, used);
    return used;
  }

  private getMailboxPayloadStorageUsed(user: TMailUser): number {
    const folders: TMailFolder[] = ["inbox", "sent", "drafts", "trash", "spam"];
    return folders.reduce((total, folder) => {
      return (
        total +
        this.getFolderEmails(user.tmailAddress, folder).reduce((folderTotal, email) => {
          return folderTotal + getEmailPayloadStorageBytes(email);
        }, 0)
      );
    }, 0);
  }
}
