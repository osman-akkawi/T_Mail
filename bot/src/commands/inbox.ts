import { Markup, type Context } from "telegraf";
import { MasterIndexService } from "../services/index";

export function createInboxCommand(indexService: MasterIndexService, miniAppUrl: string) {
  return async (ctx: Context): Promise<void> => {
    const from = ctx.from;
    if (!from) {
      await ctx.reply("Unable to identify Telegram user.");
      return;
    }

    const user = indexService.lookupByTelegramId(from.id);
    if (!user) {
      await ctx.reply("You are not registered yet. Run /start first.");
      return;
    }

    await ctx.reply(
      `Inbox ready for ${user.tmailAddress}`,
      Markup.inlineKeyboard([Markup.button.webApp("Open Inbox", miniAppUrl)]),
    );
  };
}
