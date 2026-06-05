import https from "https";
import { TelegramApiError } from "../errors";
import { withRetry } from "./rate-limiter";
import type { TelegramMessage } from "../types";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramChatRaw {
  id: number;
  type: string;
  title?: string;
  pinned_message?: {
    message_id: number;
    text?: string;
  };
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  pinnedMessage?: {
    messageId: number;
    text?: string;
  };
}

interface TelegramFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  username: string;
  first_name: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export class TelegramClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly forceIpv4: boolean;
  private readonly uploadRetryAttempts: number;
  private readonly forceTls12ForUpload: boolean;

  constructor(private readonly token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.requestTimeoutMs = parsePositiveInt(process.env.TELEGRAM_REQUEST_TIMEOUT_MS, 20_000);
    this.uploadTimeoutMs = parsePositiveInt(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS, 120_000);
    this.forceIpv4 = process.env.TELEGRAM_FORCE_IPV4 !== "false";
    this.uploadRetryAttempts = parsePositiveInt(process.env.TELEGRAM_UPLOAD_RETRIES, 4);
    this.forceTls12ForUpload = process.env.TELEGRAM_UPLOAD_FORCE_TLS12 !== "false";
  }

  private async postJson(method: string, payload?: Record<string, unknown>): Promise<string> {
    const body = payload ? JSON.stringify(payload) : "{}";
    const url = new URL(`${this.baseUrl}/${method}`);

    return new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: Number(url.port || 443),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          family: this.forceIpv4 ? 4 : undefined,
          timeout: this.requestTimeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const responseBody = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 500) >= 400) {
              reject(
                new TelegramApiError(
                  `Telegram HTTP ${res.statusCode ?? 500} for ${method}: ${responseBody.slice(0, 300)}`,
                ),
              );
              return;
            }
            resolve(responseBody);
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error("Telegram request timeout"));
      });
      req.on("error", (error) => {
        const message = error instanceof Error ? error.message : "unknown error";
        reject(new TelegramApiError(`Telegram request network error for ${method}: ${message}`));
      });

      req.write(body);
      req.end();
    });
  }

  private async request<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    return withRetry(async () => {
      const rawResponse = await this.postJson(method, payload);

      let data: TelegramResponse<T>;
      try {
        data = JSON.parse(rawResponse) as TelegramResponse<T>;
      } catch (_error) {
        throw new TelegramApiError(`Invalid Telegram response for ${method}`);
      }

      if (!data.ok || data.result === undefined) {
        throw new TelegramApiError(data.description ?? `Telegram request failed: ${method}`);
      }

      return data.result;
    });
  }

  private shouldRetryUploadError(error: unknown): boolean {
    if (error instanceof TelegramApiError) {
      if (error.statusCode >= 500 || error.statusCode === 429) {
        return true;
      }

      const text = error.message.toLowerCase();
      return (
        text.includes("timeout") ||
        text.includes("socket hang up") ||
        text.includes("network error") ||
        text.includes("bad record mac") ||
        text.includes("econnreset") ||
        text.includes("etimedout") ||
        text.includes("eai_again")
      );
    }

    const text = String(error ?? "").toLowerCase();
    return (
      text.includes("timeout") ||
      text.includes("socket hang up") ||
      text.includes("bad record mac") ||
      text.includes("econnreset") ||
      text.includes("etimedout")
    );
  }

  private shouldFallbackToDefaultNetwork(error: unknown): boolean {
    const text = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
    return (
      text.includes("bad record mac") ||
      text.includes("ssl") ||
      text.includes("tls") ||
      text.includes("econnreset") ||
      text.includes("etimedout")
    );
  }

  private async uploadMultipart(
    body: Buffer,
    boundary: string,
    filename: string,
    family: 4 | undefined,
  ): Promise<string> {
    const url = new URL(`${this.baseUrl}/sendDocument`);

    return new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: Number(url.port || 443),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
            Connection: "close",
          },
          family,
          timeout: this.uploadTimeoutMs,
          minVersion: this.forceTls12ForUpload ? "TLSv1.2" : undefined,
          maxVersion: this.forceTls12ForUpload ? "TLSv1.2" : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const responseBody = Buffer.concat(chunks).toString("utf8");
            const statusCode = res.statusCode ?? 500;
            if (statusCode >= 400) {
              reject(
                new TelegramApiError(
                  `Telegram HTTP ${statusCode} while uploading ${filename}: ${responseBody.slice(0, 300)}`,
                  statusCode,
                ),
              );
              return;
            }
            resolve(responseBody);
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error("Telegram upload timeout"));
      });
      req.on("error", (error) => {
        const message = error instanceof Error ? error.message : "unknown error";
        reject(new TelegramApiError(`Telegram upload network error: ${message}`));
      });

      req.write(body);
      req.end();
    });
  }

  async createChannel(title: string, description?: string): Promise<number> {
    throw new TelegramApiError(
      `Bot API cannot create channels directly. Please pre-create channel for ${title}. ${description ?? ""}`.trim(),
      501,
    );
  }

  async inviteBotToChannel(channelId: number): Promise<boolean> {
    const me = await this.getMe();
    await this.request("getChatMember", {
      chat_id: channelId,
      user_id: me.id,
    });
    return true;
  }

  async postMessage(channelId: number, text: string): Promise<{ messageId: number }> {
    const result = await this.request<TelegramMessage>("sendMessage", {
      chat_id: channelId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    return { messageId: result.message_id };
  }

  async editMessage(channelId: number, messageId: number, text: string): Promise<boolean> {
    await this.request("editMessageText", {
      chat_id: channelId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return true;
  }

  async deleteMessage(channelId: number, messageId: number): Promise<boolean> {
    await this.request("deleteMessage", {
      chat_id: channelId,
      message_id: messageId,
    });
    return true;
  }

  async pinMessage(channelId: number, messageId: number): Promise<boolean> {
    await this.request("pinChatMessage", {
      chat_id: channelId,
      message_id: messageId,
      disable_notification: true,
    });
    return true;
  }

  async uploadFile(
    channelId: number,
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<{ messageId: number; fileId: string; fileSize: number }> {
    const boundary = `----tmail-${Math.random().toString(16).slice(2)}`;
    const safeFilename = filename.replace(/["\r\n]/g, "_");
    const parts: Buffer[] = [];

    const pushField = (name: string, value: string): void => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    };

    pushField("chat_id", String(channelId));
    pushField("caption", filename);
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeFilename}"\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`,
      ),
    );
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    let fallbackToDefaultFamily = false;

    return withRetry(
      async () => {
        const family = this.forceIpv4 && !fallbackToDefaultFamily ? 4 : undefined;

        try {
          const rawResponse = await this.uploadMultipart(body, boundary, filename, family);
          let data: TelegramResponse<TelegramMessage>;
          try {
            data = JSON.parse(rawResponse) as TelegramResponse<TelegramMessage>;
          } catch (_error) {
            throw new TelegramApiError(`Invalid Telegram response while uploading ${filename}`);
          }

          if (!data.ok || !data.result?.document) {
            throw new TelegramApiError(data.description ?? "Failed to upload document", 502);
          }

          return {
            messageId: data.result.message_id,
            fileId: data.result.document.file_id,
            fileSize: data.result.document.file_size ?? buffer.length,
          };
        } catch (error) {
          if (this.forceIpv4 && !fallbackToDefaultFamily && this.shouldFallbackToDefaultNetwork(error)) {
            fallbackToDefaultFamily = true;
          }
          throw error;
        }
      },
      {
        attempts: this.uploadRetryAttempts,
        baseDelayMs: 600,
        shouldRetry: (error) => this.shouldRetryUploadError(error),
      },
    );
  }

  async getFileUrl(fileId: string): Promise<string> {
    const file = await this.request<TelegramFile>("getFile", { file_id: fileId });
    if (!file.file_path) {
      throw new TelegramApiError("Telegram did not return a file path");
    }
    return `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
  }

  async sendNotification(
    userId: number,
    text: string,
    options?: { silent?: boolean },
  ): Promise<boolean> {
    await this.request("sendMessage", {
      chat_id: userId,
      text,
      disable_notification: options?.silent ?? false,
    });
    return true;
  }

  async sendNotificationWithButton(
    userId: number,
    text: string,
    buttonText: string,
    buttonUrl: string,
  ): Promise<boolean> {
    await this.request("sendMessage", {
      chat_id: userId,
      text,
      reply_markup: {
        inline_keyboard: [[{ text: buttonText, web_app: { url: buttonUrl } }]],
      },
    });
    return true;
  }

  async getMe(): Promise<TelegramBotInfo> {
    return this.request<TelegramBotInfo>("getMe");
  }

  /**
   * Fetch chat info.  The returned object includes `pinnedMessage` when a
   * message is pinned — used by SnapshotService to load state on startup.
   */
  async getChat(chatId: number): Promise<TelegramChat> {
    const raw = await this.request<TelegramChatRaw>("getChat", { chat_id: chatId });
    return {
      id: raw.id,
      type: raw.type,
      title: raw.title,
      pinnedMessage: raw.pinned_message
        ? { messageId: raw.pinned_message.message_id, text: raw.pinned_message.text }
        : undefined,
    };
  }

  /**
   * Post a plain-text message (no HTML parse mode).  Used for snapshot
   * messages which contain base64 content incompatible with HTML mode.
   */
  async postPlainMessage(channelId: number, text: string): Promise<{ messageId: number }> {
    const result = await this.request<TelegramMessage>("sendMessage", {
      chat_id: channelId,
      text,
      disable_web_page_preview: true,
    });
    return { messageId: result.message_id };
  }

  /**
   * Edit a plain-text message (no HTML parse mode).  Used for snapshot updates.
   */
  async editPlainMessage(channelId: number, messageId: number, text: string): Promise<boolean> {
    await this.request("editMessageText", {
      chat_id: channelId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    });
    return true;
  }
}
