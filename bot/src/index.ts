import "dotenv/config";
import { createServer } from "http";
import { createApiServer } from "./api/server";
import { createBot } from "./bot";
import { AttachmentHandler } from "./handlers/attachment";
import { EmailHandler } from "./handlers/email";
import { NotificationHandler } from "./handlers/notification";
import { RegistrationHandler } from "./handlers/registration";
import { EmailService } from "./services/email";
import { createExternalEmailTransport } from "./services/external-email";
import { MasterIndexService } from "./services/index";
import { SessionAuthService } from "./services/session-auth";
import { SnapshotService } from "./services/snapshot";
import { StorageService } from "./services/storage";
import { ThreadService } from "./services/thread";
import { TelegramClient } from "./telegram/client";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function normalizeWebhookPath(webhookUrl: string): string {
  try {
    const path = new URL(webhookUrl).pathname;
    return path.startsWith("/") ? path : `/${path}`;
  } catch (_error) {
    const fallback = (process.env.TELEGRAM_WEBHOOK_PATH ?? "/webhooks/telegram").trim();
    return fallback.startsWith("/") ? fallback : `/${fallback}`;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function parseTelegramChatIds(value: string | undefined): number[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item !== 0);
}

async function main(): Promise<void> {
  const botToken = requiredEnv("BOT_TOKEN");
  const jwtSecret = requiredEnv("JWT_SECRET");
  const masterIndexChannelId = Number(requiredEnv("MASTER_INDEX_CHANNEL_ID"));
  const miniAppUrl = requiredEnv("MINIAPP_URL");
  const port = Number(process.env.PORT ?? 3000);
  const telegramRequestTimeoutMs = Number(process.env.TELEGRAM_REQUEST_TIMEOUT_MS ?? 20_000);
  const telegramWebhookUrl = (process.env.TELEGRAM_WEBHOOK_URL ?? "").trim();
  const telegramWebhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  const telegramMenuButtonText =
    (process.env.TELEGRAM_MENU_BUTTON_TEXT ?? "Open T-Mail NEW").trim() || "Open T-Mail NEW";
  const telegramMenuButtonChatIds = parseTelegramChatIds(process.env.TELEGRAM_MENU_BUTTON_CHAT_IDS);
  const telegramWebhookPath = telegramWebhookUrl ? normalizeWebhookPath(telegramWebhookUrl) : "";

  const telegramClient = new TelegramClient(botToken);
  const indexService = new MasterIndexService(telegramClient, masterIndexChannelId);
  const threadService = new ThreadService();
  const externalEmailTransport = createExternalEmailTransport();
  const storageService = new StorageService(telegramClient, indexService);
  const attachmentHandler = new AttachmentHandler(storageService);
  const emailService = new EmailService(
    telegramClient,
    indexService,
    threadService,
    externalEmailTransport,
    (attachment) => attachmentHandler.readForExternalSend(attachment),
  );
  const sessionAuthService = new SessionAuthService(jwtSecret, telegramClient);
  const snapshotService = new SnapshotService(telegramClient, masterIndexChannelId);

  // ── Rehydration ───────────────────────────────────────────────────────────
  // Load the pinned snapshot from the master index channel before the HTTP
  // server starts accepting traffic.  This restores users and active sessions
  // from the previous process so users never see an empty inbox or a forced
  // re-login after a backend restart or redeploy.
  try {
    const snapshot = await snapshotService.load();
    if (snapshot) {
      indexService.rehydrateFromSnapshot(snapshot.users);
      sessionAuthService.rehydrateFromSnapshot(snapshot.sessions);
    } else {
      console.log("No snapshot found — starting with empty state.");
    }
  } catch (rehydrationError) {
    const msg =
      rehydrationError instanceof Error
        ? rehydrationError.message
        : String(rehydrationError ?? "unknown");
    console.warn(`Rehydration failed (starting fresh): ${msg}`);
  }

  // Wire state-change callbacks AFTER rehydration so startup writes don't
  // trigger a snapshot save (rehydration itself doesn't call these).
  const scheduleSnapshot = (): void => {
    snapshotService.schedule({
      version: 2,
      savedAt: Date.now(),
      users: indexService.listAllUsers(),
      sessions: sessionAuthService.listAllSessions(),
    });
  };
  indexService.setStateChangeCallback(scheduleSnapshot);
  sessionAuthService.setStateChangeCallback(scheduleSnapshot);
  // ──────────────────────────────────────────────────────────────────────────

  const registrationHandler = new RegistrationHandler(indexService);
  const emailHandler = new EmailHandler(emailService);
  const notificationHandler = new NotificationHandler(telegramClient, miniAppUrl);

  const bot = createBot({
    botToken,
    miniAppUrl,
    registrationHandler,
    indexService,
  });

  const apiApp = createApiServer({
    botToken,
    miniAppUrl,
    indexService,
    sessionAuthService,
    emailService,
    registrationHandler,
    emailHandler,
    attachmentHandler,
    telegramWebhookCallback: telegramWebhookUrl
      ? bot.webhookCallback(telegramWebhookPath, telegramWebhookSecret ? { secretToken: telegramWebhookSecret } : {})
      : undefined,
  });

  const server = createServer(apiApp);
  let isShuttingDown = false;
  let botStarted = false;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the other backend process first.`);
      return;
    }
    const message = error.message ?? "Unknown HTTP server error";
    console.error(`HTTP server error: ${message}`);
  });
  server.listen(port, () => {
    // Keep one explicit startup log for local deploy diagnostics.
    console.log(`T-Mail backend running on :${port}`);
  });

  try {
    await Promise.race([
      bot.telegram.setMyCommands([
        { command: "start", description: "Start T-Mail" },
        { command: "inbox", description: "Open inbox" },
        { command: "compose", description: "Compose email" },
        { command: "help", description: "Help" },
      ]),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("setMyCommands timed out")),
          telegramRequestTimeoutMs,
        );
      }),
    ]);
    console.log("Telegram command setup completed.");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown setMyCommands failure";
    console.error(`Telegram command setup failed: ${message}`);
  }

  const updateTelegramMenuButton = async (chatId?: number): Promise<void> => {
    await Promise.race([
      bot.telegram.callApi("setChatMenuButton", {
        ...(chatId ? { chat_id: chatId } : {}),
        menu_button: {
          type: "web_app",
          text: telegramMenuButtonText,
          web_app: { url: miniAppUrl },
        },
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("setChatMenuButton timed out")),
          telegramRequestTimeoutMs,
        );
      }),
    ]);
  };

  if (isHttpsUrl(miniAppUrl)) {
    try {
      await updateTelegramMenuButton();
      for (const chatId of telegramMenuButtonChatIds) {
        await updateTelegramMenuButton(chatId);
      }
      const chatScopeText =
        telegramMenuButtonChatIds.length > 0
          ? ` and ${telegramMenuButtonChatIds.length} chat override(s)`
          : "";
      console.log(`Telegram menu button updated to ${miniAppUrl}${chatScopeText}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown setChatMenuButton failure";
      console.error(`Telegram menu button setup failed: ${message}`);
    }
  } else {
    console.warn(
      `Skipping Telegram menu button setup because MINIAPP_URL is not HTTPS: ${miniAppUrl}`,
    );
  }

  const launchBotWithRetry = async (attempt: number): Promise<void> => {
    if (isShuttingDown || botStarted) {
      return;
    }

    try {
      if (telegramWebhookUrl) {
        await bot.telegram.setWebhook(
          telegramWebhookUrl,
          telegramWebhookSecret ? { secret_token: telegramWebhookSecret } : undefined,
        );
        botStarted = true;
        console.log("Telegram bot webhook enabled.");
        return;
      }

      if (attempt === 0) {
        console.log("Starting Telegram bot polling...");
      }
      await bot.launch();
      botStarted = true;
      console.log("Telegram bot launched successfully.");
      return;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown bot launch failure";
      const delayMs = Math.min(30_000, 1_000 * Math.pow(2, Math.min(attempt, 5)));
      const delaySeconds = Math.ceil(delayMs / 1000);
      console.error(`Telegram bot launch failed: ${message}`);
      console.error(`API server is still running on port ${port}.`);
      console.error(`Retrying Telegram bot launch in ${delaySeconds}s...`);
      setTimeout(() => {
        void launchBotWithRetry(attempt + 1);
      }, delayMs);
    }
  };

  void launchBotWithRetry(0);

  process.once("SIGINT", () => {
    isShuttingDown = true;
    bot.stop("SIGINT");
    server.close();
  });
  process.once("SIGTERM", () => {
    isShuttingDown = true;
    bot.stop("SIGTERM");
    server.close();
  });

  void notificationHandler;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(message);
  process.exit(1);
});
