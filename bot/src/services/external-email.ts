import { TMailError, ValidationError } from "../errors";
import { getAddressDomain, getTMailDomain } from "./address";

export interface ExternalEmailInput {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: ExternalEmailAttachment[];
}

export interface ExternalEmailAttachment {
  filename: string;
  content: string;
  contentType?: string;
  size: number;
}

export interface ExternalEmailTransport {
  send(input: ExternalEmailInput): Promise<{ provider: string; messageId?: string }>;
}

class ExternalEmailError extends TMailError {
  constructor(message: string, statusCode = 502) {
    super(message, statusCode);
    this.name = "ExternalEmailError";
  }
}

function requireManagedSender(from: string): void {
  const senderDomain = getAddressDomain(from);
  if (senderDomain !== getTMailDomain()) {
    throw new ValidationError(`External email must be sent from @${getTMailDomain()}.`);
  }
}

export class ResendEmailTransport implements ExternalEmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = process.env.RESEND_API_URL ?? "https://api.resend.com/emails",
  ) {}

  async send(input: ExternalEmailInput): Promise<{ provider: string; messageId?: string }> {
    requireManagedSender(input.from);

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        cc: input.cc.length > 0 ? input.cc : undefined,
        bcc: input.bcc.length > 0 ? input.bcc : undefined,
        subject: input.subject || "(no subject)",
        text: input.text,
        html: input.html || undefined,
        attachments: input.attachments && input.attachments.length > 0
          ? input.attachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
            }))
          : undefined,
      }),
    });

    const raw = await response.text();
    let parsed: { id?: string; message?: string; error?: string } = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch (_error) {
      parsed = {};
    }

    if (!response.ok) {
      const details = parsed.message || parsed.error || raw || "Unknown provider error";
      throw new ExternalEmailError(`External email send failed: ${details}`, response.status);
    }

    return { provider: "resend", messageId: parsed.id };
  }
}

export function createExternalEmailTransport(): ExternalEmailTransport | null {
  const provider = (process.env.OUTBOUND_EMAIL_PROVIDER ?? "resend").trim().toLowerCase();
  if (provider === "none" || provider === "disabled") {
    return null;
  }

  if (provider !== "resend") {
    throw new ValidationError(`Unsupported OUTBOUND_EMAIL_PROVIDER: ${provider}`);
  }

  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) {
    return null;
  }

  return new ResendEmailTransport(apiKey);
}
