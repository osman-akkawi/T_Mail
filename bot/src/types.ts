export type TMailPlan = "free" | "pro";
export type TMailStatus = "unread" | "read" | "draft";
export type TMailFolder = "inbox" | "sent" | "drafts" | "trash" | "starred" | "spam";

export interface TMailChannels {
  inbox: number;
  sent: number;
  drafts: number;
  trash: number;
  spam?: number;
}

export interface TMailUser {
  telegramUserId: number;
  telegramUsername: string;
  tmailAddress: string;
  displayName: string;
  channels: TMailChannels;
  createdAt: number;
  plan: TMailPlan;
  storageUsed: number;
  indexMessageId?: number;
}

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

export interface TMailThread {
  threadId: string;
  subject: string;
  participants: string[];
  emails: TMailEmail[];
  lastDate: number;
  unreadCount: number;
}

export interface SendEmailInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  attachments?: TMailAttachment[];
  replyTo?: string | null;
}

export interface AuthPayload {
  telegramUserId: number;
  username: string;
  firstName: string;
  lastName?: string;
}

export interface InitDataUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  chat: {
    id: number;
    type: string;
    title?: string;
  };
  document?: {
    file_id: string;
    file_name?: string;
    file_size?: number;
    mime_type?: string;
  };
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
  details?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;
