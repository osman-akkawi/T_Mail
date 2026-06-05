import { ConflictError } from "../errors";
import type { TMailChannels, TMailUser } from "../types";
import { TelegramClient } from "../telegram/client";

export class MailboxService {
  constructor(private readonly telegramClient: TelegramClient) {}

  async createMailbox(user: Pick<TMailUser, "tmailAddress">): Promise<TMailChannels> {
    const address = user.tmailAddress;
    throw new ConflictError(
      `Automatic channel creation is not available through Telegram Bot API. Create channels for ${address} and register them via admin bootstrap.`,
    );
  }

  getInboxChannel(user: TMailUser): number {
    return user.channels.inbox;
  }

  getSentChannel(user: TMailUser): number {
    return user.channels.sent;
  }

  getDraftsChannel(user: TMailUser): number {
    return user.channels.drafts;
  }

  getTrashChannel(user: TMailUser): number {
    return user.channels.trash;
  }

  async pinWelcomeMessage(channelId: number, tmailAddress: string): Promise<void> {
    const msg = await this.telegramClient.postMessage(
      channelId,
      `Welcome to T-Mail, <b>${tmailAddress}</b>. This channel stores your inbox records.`,
    );
    await this.telegramClient.pinMessage(channelId, msg.messageId);
  }
}
