import { Router } from "express";
import { ValidationError } from "../../errors";
import { EmailService } from "../../services/email";
import { MasterIndexService } from "../../services/index";
import { SessionAuthService } from "../../services/session-auth";
import {
  calculateStoragePercentage,
  getStorageLimitBytes,
  isStorageUnlimited,
  normalizeStorageBytes,
} from "../../services/storage-accounting";

type LogoutScope = "current" | "others" | "all";

export function createUserRouter(
  indexService: MasterIndexService,
  sessionAuthService: SessionAuthService,
  emailService: EmailService,
) {
  const router = Router();

  router.get("/me", (req, res) => {
    if (!req.authUser) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    res.json({ ok: true, data: { user: req.authUser } });
  });

  router.get("/search-user", (req, res) => {
    const q = String(req.query.q ?? "");
    const users = indexService.searchUsers(q);
    res.json({ ok: true, data: { users } });
  });

  router.get("/storage-usage", (req, res) => {
    if (!req.authUser) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const currentUser = indexService.lookupByTelegramId(req.authUser.telegramUserId) ?? req.authUser;
    const ledgerUsed = normalizeStorageBytes(currentUser.storageUsed);
    const mailboxUsed = emailService.calculateMailboxStorageUsed(currentUser);
    const used = Math.max(ledgerUsed, mailboxUsed);
    const limit = getStorageLimitBytes(currentUser);
    const unlimited = isStorageUnlimited(limit);
    const percentage = calculateStoragePercentage(used, limit);

    res.json({ ok: true, data: { used, limit, percentage, unlimited } });
  });

  router.get("/sessions", (req, res) => {
    if (!req.authUser) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const sessions = sessionAuthService.listSessions(req.authUser.telegramUserId);
    res.json({
      ok: true,
      data: {
        sessions,
        currentSessionId: req.authSession?.sessionId ?? null,
      },
    });
  });

  router.post("/sessions/logout", (req, res) => {
    if (!req.authUser) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const rawScope = String(req.body?.scope ?? "current").toLowerCase();
    const scope = rawScope as LogoutScope;
    if (scope !== "current" && scope !== "others" && scope !== "all") {
      throw new ValidationError("Invalid logout scope.");
    }

    let revoked = 0;
    if (scope === "current") {
      if (req.authSession) {
        revoked = sessionAuthService.revokeSession(
          req.authUser.telegramUserId,
          req.authSession.sessionId,
        )
          ? 1
          : 0;
      }
    } else if (scope === "others") {
      revoked = sessionAuthService.revokeAllSessions(
        req.authUser.telegramUserId,
        req.authSession?.sessionId,
      );
    } else {
      revoked = sessionAuthService.revokeAllSessions(req.authUser.telegramUserId);
    }

    res.json({ ok: true, data: { revoked } });
  });

  return router;
}
