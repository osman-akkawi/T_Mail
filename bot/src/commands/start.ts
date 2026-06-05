import { Markup, type Context } from "telegraf";
import { RegistrationHandler } from "../handlers/registration";

export function createStartCommand(
  registrationHandler: RegistrationHandler,
  miniAppUrl: string,
) {
  return async (ctx: Context): Promise<void> => {
    const from = ctx.from;
    if (!from) {
      await ctx.reply("Unable to identify Telegram user.");
      return;
    }

    const user = await registrationHandler.registerUser({
      telegramUserId: from.id,
      telegramUsername: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
    });

    await ctx.reply(
      [
        `Welcome to T-Mail, ${user.displayName}!`,
        `Your address: ${user.tmailAddress}`,
        "Use /inbox or tap below to open the Mini App.",
      ].join("\n"),
      Markup.inlineKeyboard([Markup.button.webApp("Open T-Mail", miniAppUrl)]),
    );
  };
}
