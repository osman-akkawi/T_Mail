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

    const text = (ctx.message as any)?.text || "";
    const parts = text.split(" ");
    const startParam = parts.length > 1 ? parts[1].trim() : "";
    let preferredAddress: string | undefined = undefined;

    if (startParam.startsWith("reg_")) {
      preferredAddress = startParam.substring(4).toLowerCase().trim();
    }

    let user;
    try {
      user = await registrationHandler.registerUser({
        telegramUserId: from.id,
        telegramUsername: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
        preferredAddress,
      });
    } catch (error: any) {
      // If preferredAddress is already taken or invalid, register normally
      user = await registrationHandler.registerUser({
        telegramUserId: from.id,
        telegramUsername: from.username,
        firstName: from.first_name,
        lastName: from.last_name,
      });
      if (preferredAddress) {
        await ctx.reply(
          `⚠️ The address "${preferredAddress}" is already taken or invalid. We've assigned you a unique one instead: ${user.tmailAddress}`
        );
      }
    }

    await ctx.reply(
      [
        `Welcome to T-Mail, ${user.displayName}!`,
        `Your address: ${user.tmailAddress}`,
        "Choose an option below to open T-Mail:",
      ].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.webApp("📱 Open in Telegram", miniAppUrl)],
        [Markup.button.url("🌐 Open in Web Browser", "https://t-mailok.vercel.app/")]
      ]),
    );
  };
}
