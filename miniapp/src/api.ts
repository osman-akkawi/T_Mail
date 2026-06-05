import { telegram } from "./telegram";
import type {
  ApiEnvelope,
  AuthSession,
  EmailDraftInput,
  MailButlerInsights,
  TMailEmail,
  TMailFolder,
  TMailUser,
} from "./types";

const IS_LOCAL =
  typeof window !== "undefined" &&
  ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
const LOCAL_BASE =
  (import.meta.env.VITE_LOCAL_API_BASE_URL as string | undefined) ?? "http://127.0.0.1:3000";
const REMOTE_BASE = import.meta.env.VITE_API_BASE_URL as string;
const BASE_URL = IS_LOCAL ? LOCAL_BASE : REMOTE_BASE;

const DEV_BYPASS =
  import.meta.env.DEV && IS_LOCAL && import.meta.env.VITE_DEV_BYPASS_AUTH === "true";

const SESSION_TOKEN_KEY = "tmail_session_token";
const API_REQUEST_TIMEOUT_MS = Math.max(
  1_000,
  Number(import.meta.env.VITE_API_REQUEST_TIMEOUT_MS ?? 15_000),
);
const API_UPLOAD_TIMEOUT_MS = Math.max(
  API_REQUEST_TIMEOUT_MS,
  Number(import.meta.env.VITE_API_UPLOAD_TIMEOUT_MS ?? 120_000),
);

interface ApiRequestInit extends RequestInit {
  timeoutMs?: number;
}

function getStoredSessionToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(SESSION_TOKEN_KEY) ?? "";
}

function setStoredSessionToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(SESSION_TOKEN_KEY, token);
}

function clearStoredSessionToken(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(SESSION_TOKEN_KEY);
}

function getAuthToken(): string {
  const sessionToken = getStoredSessionToken();
  if (sessionToken) {
    return sessionToken;
  }

  const initData = telegram.getInitData();
  if (initData) {
    return initData;
  }

  if (DEV_BYPASS) {
    return "DEV_BYPASS";
  }

  return "";
}

function getDeviceLabel(): string {
  if (typeof navigator === "undefined") {
    return "";
  }

  const platform = navigator.platform || "Unknown";
  const language = navigator.language || "en";
  return `${platform} (${language})`;
}

function parseApiEnvelope<T>(raw: string, fallbackError: string): ApiEnvelope<T> {
  try {
    return JSON.parse(raw) as ApiEnvelope<T>;
  } catch (_parseError) {
    return { ok: false, error: fallbackError, data: undefined as T };
  }
}

async function request<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const authToken = getAuthToken();
  const controller = new AbortController();
  const { timeoutMs = API_REQUEST_TIMEOUT_MS, ...fetchInit } = init ?? {};
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...fetchInit,
      headers,
      signal: controller.signal,
    });
    const raw = await response.text();
    const payload = parseApiEnvelope<T>(raw, `Request failed (${response.status}).`);
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error ?? `Request failed: ${path}`);
    }

    return payload.data;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Network request failed. Please check your connection.");
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export const api = {
  auth: {
    getSessionToken(): string {
      return getStoredSessionToken();
    },
    setSessionToken(token: string): void {
      setStoredSessionToken(token);
    },
    clearSessionToken(): void {
      clearStoredSessionToken();
    },
    verify(initData: string): Promise<{ user: TMailUser; session: AuthSession; sessionToken: string }> {
      return request<{ user: TMailUser; session: AuthSession; sessionToken: string }>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ initData: initData || getAuthToken(), deviceLabel: getDeviceLabel() }),
      });
    },
    requestLoginCode(tmailAddress: string): Promise<{ challengeId: string; expiresInSeconds: number }> {
      return request<{ challengeId: string; expiresInSeconds: number }>("/auth/request-login-code", {
        method: "POST",
        body: JSON.stringify({ tmailAddress }),
      });
    },
    verifyLoginCode(tmailAddress: string, challengeId: string, code: string): Promise<{ user: TMailUser; session: AuthSession; sessionToken: string }> {
      return request<{ user: TMailUser; session: AuthSession; sessionToken: string }>("/auth/verify-login-code", {
        method: "POST",
        body: JSON.stringify({
          tmailAddress,
          challengeId,
          code,
          deviceLabel: getDeviceLabel(),
        }),
      });
    },
  },
  emails: {
    list(folder: TMailFolder, limit = 25, offset = 0): Promise<{ emails: TMailEmail[] }> {
      return request<{ emails: TMailEmail[] }>(
        `/emails?folder=${encodeURIComponent(folder)}&limit=${limit}&offset=${offset}`,
      );
    },
    get(folder: TMailFolder, emailId: string): Promise<{ email: TMailEmail; thread: TMailEmail[] }> {
      return request<{ email: TMailEmail; thread: TMailEmail[] }>(
        `/emails/${encodeURIComponent(folder)}/${encodeURIComponent(emailId)}`,
      );
    },
    update(
      folder: TMailFolder,
      emailId: string,
      updates: Partial<Pick<TMailEmail, "status" | "starred" | "labels" | "subject" | "body" | "bodyHtml">>,
    ): Promise<{ email: TMailEmail }> {
      return request<{ email: TMailEmail }>(
        `/emails/${encodeURIComponent(folder)}/${encodeURIComponent(emailId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(updates),
        },
      );
    },
    delete(folder: TMailFolder, emailId: string): Promise<{ deleted: boolean }> {
      return request<{ deleted: boolean }>(
        `/emails/${encodeURIComponent(folder)}/${encodeURIComponent(emailId)}`,
        {
          method: "DELETE",
        },
      );
    },
    search(query: string): Promise<{ emails: TMailEmail[] }> {
      return request<{ emails: TMailEmail[] }>(`/emails/search/query?q=${encodeURIComponent(query)}`);
    },
  },
  compose: {
    send(emailData: EmailDraftInput): Promise<{ email: TMailEmail; deliveredTo: string[] }> {
      return request<{ email: TMailEmail; deliveredTo: string[] }>("/compose/send", {
        method: "POST",
        body: JSON.stringify(emailData),
        timeoutMs: emailData.attachments.length > 0
          ? API_UPLOAD_TIMEOUT_MS
          : API_REQUEST_TIMEOUT_MS,
      });
    },
    draft(emailData: EmailDraftInput): Promise<{ draft: TMailEmail }> {
      return request<{ draft: TMailEmail }>("/compose/draft", {
        method: "POST",
        body: JSON.stringify(emailData),
      });
    },
  },
  attachments: {
    async upload(file: File): Promise<{
      attachment: {
        fileId: string;
        name: string;
        size: number;
        mimeType: string;
        telegramMessageId: number;
      };
    }> {
      const form = new FormData();
      form.append("file", file);
      const authToken = getAuthToken();
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), API_UPLOAD_TIMEOUT_MS);
      const headers: Record<string, string> = {};
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }

      let response: Response;
      try {
        response = await fetch(`${BASE_URL}/attachments/upload`, {
          method: "POST",
          headers,
          body: form,
          signal: controller.signal,
        });
        const raw = await response.text();
        const payload = parseApiEnvelope<{
          attachment: {
            fileId: string;
            name: string;
            size: number;
            mimeType: string;
            telegramMessageId: number;
          };
        }>(raw, `Upload failed (${response.status}).`);
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? "Upload failed");
        }

        return payload.data;
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error("Upload timed out. Please retry.");
        }
        if (error instanceof Error) {
          throw error;
        }
        throw new Error("Upload failed due to network error. Please retry.");
      } finally {
        window.clearTimeout(timeoutId);
      }
    },
    getUrl(fileId: string): Promise<{ url: string }> {
      return request<{ url: string }>(`/attachments/file/${encodeURIComponent(fileId)}`);
    },
  },
  user: {
    me(): Promise<{ user: TMailUser }> {
      return request<{ user: TMailUser }>("/user/me", { method: "GET" });
    },
    sessions(): Promise<{ sessions: AuthSession[]; currentSessionId: string | null }> {
      return request<{ sessions: AuthSession[]; currentSessionId: string | null }>("/user/sessions", {
        method: "GET",
      });
    },
    logout(scope: "current" | "others" | "all"): Promise<{ revoked: number }> {
      return request<{ revoked: number }>("/user/sessions/logout", {
        method: "POST",
        body: JSON.stringify({ scope }),
      });
    },
    search(query: string): Promise<{ users: Array<{ tmailAddress: string; displayName: string }> }> {
      return request<{ users: Array<{ tmailAddress: string; displayName: string }> }>(
        `/user/search-user?q=${encodeURIComponent(query)}`,
      );
    },
    storageUsage(): Promise<{ used: number; limit: number; percentage: number; unlimited: boolean }> {
      return request<{ used: number; limit: number; percentage: number; unlimited: boolean }>("/user/storage-usage");
    },
  },
  assistant: {
    insights(): Promise<{ insights: MailButlerInsights }> {
      return request<{ insights: MailButlerInsights }>("/assistant/insights");
    },
  },
};
