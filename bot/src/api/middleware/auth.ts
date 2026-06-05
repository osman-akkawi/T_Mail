import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { UnauthorizedError } from "../../errors";
import type { InitDataUser, TMailUser } from "../../types";
import { MasterIndexService } from "../../services/index";
import type { AuthSession } from "../../services/session-auth";
import { SessionAuthService } from "../../services/session-auth";

declare global {
  namespace Express {
    interface Request {
      authUser?: TMailUser;
      initDataUser?: InitDataUser;
      authSession?: AuthSession;
    }
  }
}

function parseInitData(initData: string): URLSearchParams {
  return new URLSearchParams(initData);
}

function buildDataCheckString(params: URLSearchParams): string {
  const items: string[] = [];

  params.forEach((value, key) => {
    if (key !== "hash") {
      items.push(`${key}=${value}`);
    }
  });

  return items.sort((a, b) => a.localeCompare(b)).join("\n");
}

function getInitDataMaxAgeSeconds(): number {
  const fallback = 24 * 60 * 60;
  const raw = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
}

export function getClientIp(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim().length > 0) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  return req.ip || req.socket.remoteAddress || "";
}

export function getClientUserAgent(req: Request): string {
  const value = req.headers["user-agent"];
  return typeof value === "string" ? value : "";
}

function isLoopbackIp(value: string): boolean {
  const normalized = value.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function shouldRestrictDevBypassToLocal(): boolean {
  const raw = process.env.DEV_AUTH_BYPASS_LOCAL_ONLY;
  if (raw === undefined) {
    return true;
  }
  return raw !== "false";
}

export function verifyTelegramInitData(initData: string, botToken: string): boolean {
  const params = parseInitData(initData);
  const hash = params.get("hash");
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) {
    return false;
  }

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const checkString = buildDataCheckString(params);
  const expected = crypto.createHmac("sha256", secret).update(checkString).digest();
  const received = Buffer.from(hash, "hex");

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

export function parseInitDataUser(initData: string): InitDataUser {
  const params = parseInitData(initData);
  const userRaw = params.get("user");

  if (!userRaw) {
    throw new UnauthorizedError("Missing Telegram user in initData");
  }

  const parsed = JSON.parse(userRaw) as Partial<InitDataUser>;

  if (!parsed.id || !parsed.first_name) {
    throw new UnauthorizedError("Invalid Telegram user payload");
  }

  return {
    id: parsed.id,
    first_name: parsed.first_name,
    last_name: parsed.last_name,
    username: parsed.username,
  };
}

export function isTelegramInitDataFresh(initData: string): boolean {
  const params = parseInitData(initData);
  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) {
    return false;
  }

  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const maxAgeSeconds = getInitDataMaxAgeSeconds();

  if (authDate > now + 60) {
    return false;
  }

  return now - authDate <= maxAgeSeconds;
}

export function canUseDevBypass(req: Request, initData: string): boolean {
  if (initData !== "DEV_BYPASS") {
    return false;
  }

  if (process.env.ALLOW_DEV_AUTH_BYPASS !== "true") {
    return false;
  }

  if (process.env.NODE_ENV === "production") {
    return false;
  }

  if (!shouldRestrictDevBypassToLocal()) {
    return true;
  }

  return isLoopbackIp(getClientIp(req));
}

export function createAuthMiddleware(params: {
  botToken: string;
  indexService: MasterIndexService;
  sessionAuthService: SessionAuthService;
}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (req.method === "GET" && req.path.startsWith("/attachments/raw/")) {
        next();
        return;
      }

      const header = req.headers.authorization ?? "";
      if (!header.startsWith("Bearer ")) {
        throw new UnauthorizedError("Missing Bearer token");
      }

      const bearerToken = header.slice("Bearer ".length).trim();

      if (bearerToken.startsWith("session:")) {
        const sessionToken = bearerToken.slice("session:".length).trim();
        if (!sessionToken) {
          throw new UnauthorizedError("Missing session token.");
        }

        const session = params.sessionAuthService.verifySessionToken(sessionToken);
        const user = params.indexService.lookupByTelegramId(session.telegramUserId);
        if (!user) {
          throw new UnauthorizedError("User for this session was not found.");
        }

        req.authUser = user;
        req.authSession = session;
        req.initDataUser = {
          id: user.telegramUserId,
          first_name: user.displayName,
          username: user.telegramUsername,
        };
        next();
        return;
      }

      const initData = bearerToken;

      if (canUseDevBypass(req, initData)) {
        const devId = Number(process.env.DEV_TELEGRAM_USER_ID ?? 1376576931);
        const user = params.indexService.lookupByTelegramId(devId);
        if (!user) {
          throw new UnauthorizedError("Dev user missing. Call /auth/verify first.");
        }
        req.authUser = user;
        req.authSession = undefined;
        req.initDataUser = {
          id: user.telegramUserId,
          first_name: user.displayName,
          username: user.telegramUsername,
        };
        next();
        return;
      }

      if (!verifyTelegramInitData(initData, params.botToken)) {
        throw new UnauthorizedError("Invalid Telegram initData signature");
      }
      if (!isTelegramInitDataFresh(initData)) {
        throw new UnauthorizedError("Expired Telegram initData");
      }

      const initDataUser = parseInitDataUser(initData);
      const user = params.indexService.lookupByTelegramId(initDataUser.id);
      if (!user) {
        throw new UnauthorizedError("T-Mail account not found. Use /start in bot first.");
      }

      req.authUser = user;
      req.initDataUser = initDataUser;
      req.authSession = undefined;
      next();
    } catch (error) {
      next(error);
    }
  };
}
