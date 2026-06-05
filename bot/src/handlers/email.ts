import type { SendEmailInput, TMailEmail, TMailUser } from "../types";
import { EmailService } from "../services/email";

export class EmailHandler {
  constructor(private readonly emailService: EmailService) {}

  async send(input: SendEmailInput): Promise<{ email: TMailEmail; deliveredTo: string[] }> {
    return this.emailService.sendEmail(input);
  }

  async saveDraft(
    user: TMailUser,
    input: Omit<SendEmailInput, "from"> & { from?: string },
  ): Promise<TMailEmail> {
    return this.emailService.saveDraft(user, input);
  }
}
