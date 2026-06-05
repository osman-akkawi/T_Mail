export type TMailStatus = "unread" | "read" | "draft";
export type TMailFolder = "inbox" | "sent" | "drafts" | "trash" | "starred";

export interface TMailAttachment {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  telegramMessageId: number;
}

export interface TMailEmail {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyHtml: string;
  attachments: TMailAttachment[];
  date: number;
  status: TMailStatus;
  threadId: string;
  replyTo: string | null;
  labels: string[];
  starred: boolean;
  telegramMessageId: number;
}

export interface TMailUser {
  telegramUserId: number;
  telegramUsername: string;
  tmailAddress: string;
  displayName: string;
  createdAt: number;
  plan: "free" | "pro";
  storageUsed: number;
}

export type AuthMethod = "telegram_webapp" | "telegram_otp";
export type DeviceType = "desktop" | "mobile" | "tablet" | "telegram" | "unknown";

export interface AuthSession {
  sessionId: string;
  telegramUserId: number;
  tmailAddress: string;
  deviceType: DeviceType;
  deviceLabel: string;
  authMethod: AuthMethod;
  ipAddress: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface TelegramMiniUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface EmailDraftInput {
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyHtml: string;
  attachments: TMailAttachment[];
  replyTo?: string | null;
}

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
  priority: MailButlerEmailSummary[];
  suggestedReplies: MailButlerEmailSummary[];
  digest: string[];
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: string;
}
