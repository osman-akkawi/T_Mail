import type { TMailAttachment, TMailEmail, TMailUser } from "../types";

export const UNLIMITED_STORAGE_LIMIT_BYTES = 0;
export const FREE_STORAGE_LIMIT_BYTES = UNLIMITED_STORAGE_LIMIT_BYTES;

export function normalizeStorageBytes(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

export function getStorageLimitBytes(_user: Pick<TMailUser, "plan">): number {
  return FREE_STORAGE_LIMIT_BYTES;
}

export function isStorageUnlimited(limit: number): boolean {
  return !Number.isFinite(limit) || limit <= 0;
}

export function calculateStoragePercentage(used: number, limit: number): number {
  if (isStorageUnlimited(limit)) {
    return 0;
  }

  return Math.min(100, Number(((used / limit) * 100).toFixed(4)));
}

export function getAttachmentStorageBytes(attachments: TMailAttachment[]): number {
  return attachments.reduce((total, attachment) => {
    return total + normalizeStorageBytes(attachment.size);
  }, 0);
}

export function getEmailPayloadStorageBytes(email: TMailEmail): number {
  return (
    Buffer.byteLength(JSON.stringify(email), "utf8") +
    getAttachmentStorageBytes(email.attachments)
  );
}
