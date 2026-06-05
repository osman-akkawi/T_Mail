import { Router } from "express";
import {
  canUseDevBypass,
  getClientIp,
  getClientUserAgent,
  isTelegramInitDataFresh,
  parseInitDataUser,
  verifyTelegramInitData,
} from "../middleware/auth";
import { ValidationError } from "../../errors";
import { RegistrationHandler } from "../../handlers/registration";
import { normalizeTMailAddress } from "../../services/address";
import { MasterIndexService } from "../../services/index";
import { SessionAuthService } from "../../services/session-auth";

function normalizeLoginAddress(input: string): string {
  return normalizeTMailAddress(input);
}

function getDeviceLabel(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }

  const maybe = (body as { deviceLabel?: unknown }).deviceLabel;
  return typeof maybe === "string" ? maybe : "";
}

function normalizeSeedAddress(input: string): string {
  return normalizeTMailAddress(input);
}

function isLoopbackIp(value: string): boolean {
  const normalized = value.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function createAuthRouter(params: {
  botToken: string;
  registrationHandler: RegistrationHandler;
  indexService: MasterIndexService;
  sessionAuthService: SessionAuthService;
}) {
  const router = Router();

  router.post("/dev/create-test-user", async (req, res, next) => {
    try {
      if (process.env.NODE_ENV === "production") {
        res.status(403).json({ ok: false, error: "Disabled in production." });
        return;
      }

      const clientIp = getClientIp(req);
      if (!isLoopbackIp(clientIp)) {
        res.status(403).json({ ok: false, error: "Only localhost can create test users." });
        return;
      }

      const seedKey = String(process.env.DEV_SEED_KEY ?? "").trim();
      if (seedKey) {
        const providedKey = String(req.headers["x-dev-seed-key"] ?? "");
        if (providedKey !== seedKey) {
          res.status(403).json({ ok: false, error: "Invalid dev seed key." });
          return;
        }
      }

      const rawAddress = String(req.body?.tmailAddress ?? req.body?.address ?? "");
      const tmailAddress = normalizeSeedAddress(rawAddress);
      if (!tmailAddress) {
        throw new ValidationError("tmailAddress is required.");
      }

      const mirrorChatId = Number(req.body?.mirrorChatId ?? req.body?.chatId ?? 0);
      if (!Number.isFinite(mirrorChatId) || mirrorChatId <= 0) {
        throw new ValidationError("mirrorChatId must be a positive Telegram chat id.");
      }

      const existingByAddress = params.indexService.lookupByAddress(tmailAddress);
      if (existingByAddress) {
        const session = params.sessionAuthService.createSessionFromTelegram({
          user: existingByAddress,
          ipAddress: getClientIp(req),
          userAgent: getClientUserAgent(req),
          deviceLabel: "Local Dev Seeder",
        });
        res.json({
          ok: true,
          data: {
            user: existingByAddress,
            created: false,
            session: session.session,
            sessionToken: `session:${session.sessionToken}`,
          },
        });
        return;
      }

      const requestedId = Number(req.body?.telegramUserId ?? 0);
      const telegramUserId = Number.isFinite(requestedId) && requestedId > 0
        ? Math.floor(requestedId)
        : Math.floor(8_000_000_000 + Math.random() * 1_000_000_000);

      if (params.indexService.lookupByTelegramId(telegramUserId)) {
        throw new ValidationError("telegramUserId is already in use.");
      }

      const firstName = String(req.body?.firstName ?? req.body?.displayName ?? "Test");
      const lastName = String(req.body?.lastName ?? "User");
      const telegramUsername = String(req.body?.telegramUsername ?? "").trim().toLowerCase();

      const created = await params.registrationHandler.registerUser({
        telegramUserId,
        telegramUsername: telegramUsername || undefined,
        firstName: firstName || "Test",
        lastName: lastName || "User",
        preferredAddress: tmailAddress,
      });

      const user = await params.indexService.updateUser(created.tmailAddress, {
        channels: {
          inbox: mirrorChatId,
          sent: mirrorChatId,
          drafts: mirrorChatId,
          trash: mirrorChatId,
        },
      });

      const session = params.sessionAuthService.createSessionFromTelegram({
        user,
        ipAddress: getClientIp(req),
        userAgent: getClientUserAgent(req),
        deviceLabel: "Local Dev Seeder",
      });

      res.json({
        ok: true,
        data: {
          user,
          created: true,
          session: session.session,
          sessionToken: `session:${session.sessionToken}`,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/verify", async (req, res, next) => {
    try {
      const initData = String(req.body?.initData ?? "");
      const deviceLabel = getDeviceLabel(req.body);

      let telegramUser:
        | ReturnType<typeof parseInitDataUser>
        | {
            id: number;
            first_name: string;
            last_name?: string;
            username?: string;
          };

      if (canUseDevBypass(req, initData)) {
        const devId = Number(process.env.DEV_TELEGRAM_USER_ID ?? 1376576931);
        const devUsername = process.env.DEV_TELEGRAM_USERNAME ?? "devuser";
        const devFirstName = process.env.DEV_TELEGRAM_FIRST_NAME ?? "Dev";
        const devLastName = process.env.DEV_TELEGRAM_LAST_NAME ?? "User";
        telegramUser = {
          id: devId,
          username: devUsername,
          first_name: devFirstName,
          last_name: devLastName,
        };
      } else {
        const valid = verifyTelegramInitData(initData, params.botToken);
        if (!valid) {
          res.status(401).json({ ok: false, error: "Invalid initData" });
          return;
        }
        if (!isTelegramInitDataFresh(initData)) {
          res.status(401).json({ ok: false, error: "Expired initData" });
          return;
        }
        telegramUser = parseInitDataUser(initData);
      }

      let user = params.indexService.lookupByTelegramId(telegramUser.id);

      if (!user) {
        user = await params.registrationHandler.registerUser({
          telegramUserId: telegramUser.id,
          telegramUsername: telegramUser.username,
          firstName: telegramUser.first_name,
          lastName: telegramUser.last_name,
        });
      }

      const session = params.sessionAuthService.createSessionFromTelegram({
        user,
        ipAddress: getClientIp(req),
        userAgent: getClientUserAgent(req),
        deviceLabel,
      });

      res.json({
        ok: true,
        data: {
          user,
          session: session.session,
          sessionToken: `session:${session.sessionToken}`,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/request-login-code", async (req, res, next) => {
    try {
      const rawAddress = String(req.body?.tmailAddress ?? req.body?.email ?? "");
      const tmailAddress = normalizeLoginAddress(rawAddress);
      if (!tmailAddress) {
        throw new ValidationError("Please enter your T-Mail address.");
      }

      const user = params.indexService.lookupByAddress(tmailAddress);
      if (!user) {
        res.status(404).json({ ok: false, error: "Account not found." });
        return;
      }

      const challenge = await params.sessionAuthService.requestLoginCode({
        user,
        ipAddress: getClientIp(req),
        userAgent: getClientUserAgent(req),
      });

      res.json({ ok: true, data: challenge });
    } catch (error) {
      next(error);
    }
  });

  router.post("/verify-login-code", async (req, res, next) => {
    try {
      const challengeId = String(req.body?.challengeId ?? "").trim();
      const code = String(req.body?.code ?? "").trim();
      const tmailAddress = normalizeLoginAddress(String(req.body?.tmailAddress ?? req.body?.email ?? ""));
      const deviceLabel = getDeviceLabel(req.body);

      if (!challengeId) {
        throw new ValidationError("Missing challenge id.");
      }
      if (!/^\d{6}$/.test(code)) {
        throw new ValidationError("Verification code must be 6 digits.");
      }
      if (!tmailAddress) {
        throw new ValidationError("Please enter your T-Mail address.");
      }

      const user = params.indexService.lookupByAddress(tmailAddress);
      if (!user) {
        res.status(401).json({ ok: false, error: "Invalid verification request." });
        return;
      }

      const session = params.sessionAuthService.verifyLoginCode({
        user,
        challengeId,
        code,
        ipAddress: getClientIp(req),
        userAgent: getClientUserAgent(req),
        deviceLabel,
      });

      res.json({
        ok: true,
        data: {
          user,
          session: session.session,
          sessionToken: `session:${session.sessionToken}`,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", (req, res) => {
    if (!req.authUser) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    res.json({ ok: true, data: { user: req.authUser } });
  });

  return router;
}
