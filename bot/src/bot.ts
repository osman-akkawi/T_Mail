import https from "https";
import { Markup, type Context, Telegraf } from "telegraf";
import { RegistrationHandler } from "./handlers/registration";
import { getTMailDomain } from "./services/address";
import { MasterIndexService } from "./services/index";
import { createComposeCommand } from "./commands/compose";
import { createHelpCommand } from "./commands/help";
import { createInboxCommand } from "./commands/inbox";
import { createStartCommand } from "./commands/start";

export function createBot(params: {
  botToken: string;
  miniAppUrl: string;
  registrationHandler: RegistrationHandler;
  indexService: MasterIndexService;
}) {
  const forceIpv4 = process.env.TELEGRAM_FORCE_IPV4 !== "false";

  const bot = new Telegraf(params.botToken, {
    telegram: {
      agent: new https.Agent({
        keepAlive: true,
        family: forceIpv4 ? 4 : undefined,
      }),
      webhookReply: false,
    },
  });

  bot.catch(async (error, ctx) => {
    const message = error instanceof Error ? error.message : "Unknown bot error";
    console.error("Unhandled error while processing", ctx.update);
    console.error(`Bot update handling failed: ${message}`);

    try {
      await ctx.reply("Something went wrong. Please try again in a moment.");
    } catch (_replyError) {
      // Ignore secondary reply failures to avoid noisy loops.
    }
  });

  bot.start(createStartCommand(params.registrationHandler, params.miniAppUrl));
  bot.command("inbox", createInboxCommand(params.indexService, params.miniAppUrl));
  bot.command("compose", createComposeCommand(params.indexService, params.miniAppUrl));
  bot.command("help", createHelpCommand());

  bot.on("text", async (ctx: Context) => {
    const txt = ctx.message && "text" in ctx.message ? ctx.message.text.trim() : "";
    if (!txt.startsWith("@tmail ")) {
      return;
    }

    const desired = txt.replace("@tmail ", "").trim().toLowerCase();
    if (!desired) {
      await ctx.reply(`Usage: @tmail yourname@${getTMailDomain()}`);
      return;
    }

    const from = ctx.from;
    if (!from) {
      return;
    }

    try {
      const user = await params.registrationHandler.registerUser({
        telegramUserId: from.id,
        telegramUsername: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
        preferredAddress: desired,
      });

      await ctx.reply(
        `Address created: ${user.tmailAddress}`,
        Markup.inlineKeyboard([
          Markup.button.webApp("Open T-Mail", params.miniAppUrl),
        ]),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Registration failed";
      await ctx.reply(message);
    }
  });

  return bot;
}
