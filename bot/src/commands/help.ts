import type { Context } from "telegraf";
import { getTMailDomain } from "../services/address";

export function createHelpCommand() {
  return async (ctx: Context): Promise<void> => {
    const domain = getTMailDomain();

    await ctx.reply(
      [
        "T-Mail commands:",
        "/start - create account and open app",
        "/inbox - open inbox",
        "/compose - write a new email",
        "/help - show this help",
        `To claim a custom address, send: @tmail yourname@${domain}`,
      ].join("\n"),
    );
  };
}
