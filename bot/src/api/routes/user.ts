import { Router } from "express";
import { getTMailDomain } from "../../services/address";
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

  router.post("/change-address", async (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const username = user.telegramUsername;
      if (!username) {
        res.status(400).json({
          ok: false,
          error: "You must have a Telegram username set in your profile to change your email address.",
        });
        return;
      }

      const domain = getTMailDomain();
      const targetAddress = `${username.toLowerCase()}@${domain}`;

      // 1. Check if the address is already set to the target address
      if (user.tmailAddress.toLowerCase() === targetAddress.toLowerCase()) {
        res.status(400).json({
          ok: false,
          error: "Your email address is already synced with your Telegram username.",
        });
        return;
      }

      // 2. Reserved words list check
      const BANNED_USERNAMES = new Set([
        "admin", "support", "billing", "staff", "security", "info", "help",
        "t-mail", "tmail", "system", "postmaster", "root"
      ]);
      if (BANNED_USERNAMES.has(username.toLowerCase())) {
        res.status(400).json({
          ok: false,
          error: `The username "${username}" is reserved and cannot be used as an email address.`,
        });
        return;
      }

      // 3. Rate limiting check (once every 30 days)
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      if (user.lastAddressChangeAt && Date.now() - user.lastAddressChangeAt < THIRTY_DAYS_MS) {
        const daysLeft = Math.ceil(
          (THIRTY_DAYS_MS - (Date.now() - user.lastAddressChangeAt)) / (24 * 60 * 60 * 1000)
        );
        res.status(400).json({
          ok: false,
          error: `You can only change your email address once every 30 days. Please try again in ${daysLeft} days.`,
        });
        return;
      }

      // 4. Check if the address is taken by someone else
      if (indexService.isAddressTaken(targetAddress)) {
        res.status(400).json({
          ok: false,
          error: `The email address "${targetAddress}" is already taken by another user.`,
        });
        return;
      }

      // 5. Update user and migrate mailbox
      const oldAddress = user.tmailAddress;
      const updatedUser = await indexService.updateUser(oldAddress, {
        tmailAddress: targetAddress,
        lastAddressChangeAt: Date.now(),
      });

      // Migrate emails in memory
      emailService.migrateMailbox(oldAddress, targetAddress);

      res.json({ ok: true, data: { user: updatedUser } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
