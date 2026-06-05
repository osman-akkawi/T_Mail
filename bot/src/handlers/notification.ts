import { TelegramClient } from "../telegram/client";
import type { TMailEmail, TMailUser } from "../types";

export class NotificationHandler {
  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly miniAppUrl: string,
  ) {}

  async notifyNewMail(recipient: TMailUser, email: TMailEmail): Promise<void> {
    await this.telegramClient.sendNotificationWithButton(
      recipient.telegramUserId,
      `New T-Mail from ${email.from}\nSubject: ${email.subject || "(no subject)"}`,
      "Open T-Mail",
      this.miniAppUrl,
    );
  }
}
