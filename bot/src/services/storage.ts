import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors";
import type { TMailAttachment, TMailUser } from "../types";
import { TelegramClient } from "../telegram/client";
import { MasterIndexService } from "./index";
import {
  getStorageLimitBytes,
  isStorageUnlimited,
  normalizeStorageBytes,
} from "./storage-accounting";

const MB = 1024 * 1024;
const TELEGRAM_BOT_API_MAX_FILE_SIZE_BYTES = 50 * MB;
const LOCAL_FILE_ID_PREFIX = "local:";

interface LocalAttachmentRecord {
  filePath: string;
  metadataPath: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface StoredAttachmentContent {
  filename: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
}

function getMaxAttachmentSizeBytes(): number {
  const raw = Number(process.env.MAX_ATTACHMENT_SIZE_MB ?? 20);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 20 * MB;
  }
  return Math.min(Math.floor(raw * MB), TELEGRAM_BOT_API_MAX_FILE_SIZE_BYTES);
}

function getPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export class StorageService {
  private readonly maxAttachmentSizeBytes = getMaxAttachmentSizeBytes();
  private readonly localAttachments = new Map<string, LocalAttachmentRecord>();
  private readonly localAttachmentDir = path.join(os.tmpdir(), "tmail-attachments");
  private readonly fallbackToLocalOnTelegramFailure =
    process.env.ATTACHMENT_FALLBACK_LOCAL !== "false";
  private readonly localDownloadTtlSeconds = getPositiveInt(
    process.env.LOCAL_ATTACHMENT_URL_TTL_SECONDS,
    15 * 60,
  );
  private readonly localDownloadSecret =
    process.env.LOCAL_ATTACHMENT_URL_SECRET || process.env.JWT_SECRET || "tmail-local-dev-secret";

  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly indexService: MasterIndexService,
  ) {}

  private isLocalFileId(fileId: string): boolean {
    return fileId.startsWith(LOCAL_FILE_ID_PREFIX);
  }

  private getLocalId(fileId: string): string {
    return fileId.slice(LOCAL_FILE_ID_PREFIX.length);
  }

  private getLocalDataPath(fileId: string): string {
    const localId = this.getLocalId(fileId);
    return path.join(this.localAttachmentDir, `${localId}.bin`);
  }

  private getLocalMetadataPath(fileId: string): string {
    const localId = this.getLocalId(fileId);
    return path.join(this.localAttachmentDir, `${localId}.json`);
  }

  private createLocalFileId(): string {
    return `${LOCAL_FILE_ID_PREFIX}${crypto.randomUUID()}`;
  }

  private createLocalDownloadSignature(fileId: string, expires: number): string {
    const payload = `${fileId}:${expires}`;
    return crypto.createHmac("sha256", this.localDownloadSecret).update(payload).digest("hex");
  }

  private createLocalDownloadUrl(fileId: string): string {
    const expires = Math.floor(Date.now() / 1000) + this.localDownloadTtlSeconds;
    const sig = this.createLocalDownloadSignature(fileId, expires);
    return `/attachments/raw/${encodeURIComponent(fileId)}?expires=${expires}&sig=${sig}`;
  }

  private shouldFallbackToLocal(error: unknown): boolean {
    if (!this.fallbackToLocalOnTelegramFailure) {
      return false;
    }
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
    return (
      message.includes("telegram upload network error") ||
      message.includes("bad record mac") ||
      message.includes("ssl") ||
      message.includes("tls") ||
      message.includes("econnreset") ||
      message.includes("etimedout")
    );
  }

  private assertStorageAvailable(user: TMailUser, additionalBytes: number): void {
    const current = this.indexService.lookupByAddress(user.tmailAddress) ?? user;
    const used = normalizeStorageBytes(current.storageUsed);
    const limit = getStorageLimitBytes(current);
    const needed = normalizeStorageBytes(additionalBytes);

    if (!isStorageUnlimited(limit) && used + needed > limit) {
      throw new ValidationError(
        "Storage limit exceeded. Free up space before uploading more attachments.",
      );
    }
  }

  private async storeLocalAttachment(file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  }): Promise<TMailAttachment> {
    const fileId = this.createLocalFileId();
    await fs.mkdir(this.localAttachmentDir, { recursive: true });

    const diskPath = this.getLocalDataPath(fileId);
    const metadataPath = this.getLocalMetadataPath(fileId);
    await fs.writeFile(diskPath, file.buffer);
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          fileName: file.originalname,
          mimeType: file.mimetype || "application/octet-stream",
          size: file.size,
        },
        null,
        2,
      ),
      "utf8",
    );

    this.localAttachments.set(fileId, {
      filePath: diskPath,
      metadataPath,
      fileName: file.originalname,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
    });

    return {
      fileId,
      name: file.originalname,
      size: file.size,
      mimeType: file.mimetype || "application/octet-stream",
      telegramMessageId: 0,
    };
  }

  async uploadAttachment(
    user: TMailUser,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    channelId = user.channels.drafts,
  ): Promise<TMailAttachment> {
    if (file.size <= 0) {
      throw new ValidationError("Attachment is empty");
    }

    if (file.size > this.maxAttachmentSizeBytes) {
      const maxMb = Math.floor(this.maxAttachmentSizeBytes / MB);
      throw new ValidationError(`Attachment exceeds limit (${maxMb}MB max per file)`);
    }

    this.assertStorageAvailable(user, file.size);

    try {
      const uploaded = await this.telegramClient.uploadFile(
        channelId,
        file.buffer,
        file.originalname,
        file.mimetype,
      );

      const attachment = {
        fileId: uploaded.fileId,
        name: file.originalname,
        size: uploaded.fileSize,
        mimeType: file.mimetype,
        telegramMessageId: uploaded.messageId,
      };
      await this.indexService.incrementStorageUsed(user.tmailAddress, attachment.size);
      return attachment;
    } catch (error) {
      if (!this.shouldFallbackToLocal(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error ?? "unknown error");
      console.warn(
        `Attachment upload fallback: storing "${file.originalname}" locally due to Telegram upload issue (${message}).`,
      );

      const attachment = await this.storeLocalAttachment(file);
      await this.indexService.incrementStorageUsed(user.tmailAddress, attachment.size);
      return attachment;
    }
  }

  async resolveFileUrl(fileId: string): Promise<string> {
    if (this.isLocalFileId(fileId)) {
      const record =
        this.localAttachments.get(fileId) || (await this.loadLocalAttachmentRecord(fileId));
      if (!record) {
        throw new NotFoundError("Attachment not found. It may have expired after restart.");
      }
      return this.createLocalDownloadUrl(fileId);
    }

    return this.telegramClient.getFileUrl(fileId);
  }

  async readAttachmentContent(attachment: TMailAttachment): Promise<StoredAttachmentContent> {
    if (this.isLocalFileId(attachment.fileId)) {
      const record =
        this.localAttachments.get(attachment.fileId) ||
        (await this.loadLocalAttachmentRecord(attachment.fileId));
      if (!record) {
        throw new NotFoundError("Attachment not found. It may have expired after restart.");
      }

      const buffer = await fs.readFile(record.filePath);
      if (buffer.length <= 0) {
        throw new ValidationError(`Attachment "${attachment.name}" is empty.`);
      }
      if (buffer.length > this.maxAttachmentSizeBytes) {
        const maxMb = Math.floor(this.maxAttachmentSizeBytes / MB);
        throw new ValidationError(
          `Attachment "${attachment.name}" exceeds ${maxMb}MB per-file limit`,
        );
      }

      return {
        filename: record.fileName || attachment.name,
        mimeType: record.mimeType || attachment.mimeType || "application/octet-stream",
        size: buffer.length,
        buffer,
      };
    }

    const fileUrl = await this.telegramClient.getFileUrl(attachment.fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new ValidationError(
        `Attachment "${attachment.name}" could not be read from storage.`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= 0) {
      throw new ValidationError(`Attachment "${attachment.name}" is empty.`);
    }
    if (buffer.length > this.maxAttachmentSizeBytes) {
      const maxMb = Math.floor(this.maxAttachmentSizeBytes / MB);
      throw new ValidationError(
        `Attachment "${attachment.name}" exceeds ${maxMb}MB per-file limit`,
      );
    }

    return {
      filename: attachment.name,
      mimeType:
        attachment.mimeType ||
        response.headers.get("content-type") ||
        "application/octet-stream",
      size: buffer.length,
      buffer,
    };
  }

  private async loadLocalAttachmentRecord(fileId: string): Promise<LocalAttachmentRecord | null> {
    if (!this.isLocalFileId(fileId)) {
      return null;
    }

    const filePath = this.getLocalDataPath(fileId);
    const metadataPath = this.getLocalMetadataPath(fileId);

    try {
      const [metaRaw] = await Promise.all([fs.readFile(metadataPath, "utf8"), fs.access(filePath)]);
      const parsed = JSON.parse(metaRaw) as Partial<LocalAttachmentRecord>;
      if (!parsed.fileName || !parsed.mimeType || !parsed.size) {
        return null;
      }

      const record: LocalAttachmentRecord = {
        filePath,
        metadataPath,
        fileName: parsed.fileName,
        mimeType: parsed.mimeType,
        size: parsed.size,
      };

      this.localAttachments.set(fileId, record);
      return record;
    } catch (_error) {
      return null;
    }
  }

  async getLocalAttachmentForDownload(
    fileId: string,
    expiresRaw: string | string[] | undefined,
    sigRaw: string | string[] | undefined,
  ): Promise<LocalAttachmentRecord> {
    if (!this.isLocalFileId(fileId)) {
      throw new NotFoundError("Local attachment not found");
    }

    const expiresValue = Array.isArray(expiresRaw) ? expiresRaw[0] : expiresRaw;
    const sigValue = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
    const expires = Number(expiresValue);

    if (!expiresValue || !Number.isFinite(expires) || !sigValue) {
      throw new UnauthorizedError("Invalid attachment download token.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (expires < now) {
      throw new UnauthorizedError("Attachment download token expired.");
    }

    const expectedSig = this.createLocalDownloadSignature(fileId, expires);
    const expectedBuffer = Buffer.from(expectedSig, "hex");
    const providedBuffer = Buffer.from(sigValue, "hex");
    if (
      expectedBuffer.length === 0 ||
      providedBuffer.length === 0 ||
      expectedBuffer.length !== providedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw new UnauthorizedError("Invalid attachment download signature.");
    }

    const record =
      this.localAttachments.get(fileId) || (await this.loadLocalAttachmentRecord(fileId));
    if (!record) {
      throw new NotFoundError("Attachment not found. It may have expired after restart.");
    }

    try {
      await fs.access(record.filePath);
    } catch (_error) {
      this.localAttachments.delete(fileId);
      try {
        await fs.unlink(record.metadataPath);
      } catch (_unlinkError) {
        // no-op
      }
      throw new NotFoundError("Attachment file is no longer available.");
    }

    return record;
  }
}
