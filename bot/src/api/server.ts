import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { TMailError } from "../errors";
import { createAuthMiddleware } from "./middleware/auth";
import { apiRateLimit } from "./middleware/rateLimit";
import { createAttachmentsRouter } from "./routes/attachments";
import { createAssistantRouter } from "./routes/assistant";
import { createAuthRouter } from "./routes/auth";
import { createComposeRouter } from "./routes/compose";
import { createEmailsRouter } from "./routes/emails";
import { createInboundEmailRouter } from "./routes/inbound-email";
import { createUserRouter } from "./routes/user";
import { AttachmentHandler } from "../handlers/attachment";
import { EmailHandler } from "../handlers/email";
import { RegistrationHandler } from "../handlers/registration";
import { EmailService } from "../services/email";
import { MasterIndexService } from "../services/index";
import { SessionAuthService } from "../services/session-auth";

interface RawBodyRequest extends Request {
  rawBody?: string;
}

function parseTrustProxy(): boolean | number | string {
  const raw = (process.env.TRUST_PROXY ?? "").trim();
  if (!raw) {
    return false;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }

  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
}

function getApiTimeoutMs(): number {
  const raw = Number(process.env.API_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}

function buildAllowedOrigins(miniAppUrl: string): Set<string> {
  const origins = new Set<string>(["http://localhost:5173", "http://127.0.0.1:5173"]);

  try {
    origins.add(new URL(miniAppUrl).origin);
  } catch (_error) {
    // Ignore invalid MINIAPP_URL here; startup validation is handled elsewhere.
  }

  const extraOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  for (const origin of extraOrigins) {
    origins.add(origin);
  }

  return origins;
}

function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");

  if (process.env.NODE_ENV === "production" && req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}

export function createApiServer(params: {
  botToken: string;
  miniAppUrl: string;
  indexService: MasterIndexService;
  sessionAuthService: SessionAuthService;
  emailService: EmailService;
  registrationHandler: RegistrationHandler;
  emailHandler: EmailHandler;
  attachmentHandler: AttachmentHandler;
  telegramWebhookCallback?: RequestHandler;
}) {
  const app = express();
  const allowedOrigins = buildAllowedOrigins(params.miniAppUrl);
  const apiTimeoutMs = getApiTimeoutMs();

  app.disable("x-powered-by");
  app.set("trust proxy", parseTrustProxy());
  app.use(securityHeaders);
  app.use((req, res, next) => {
    req.setTimeout(apiTimeoutMs);
    res.setTimeout(apiTimeoutMs);
    next();
  });
  if (params.telegramWebhookCallback) {
    app.use(params.telegramWebhookCallback);
  }
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Dev-Seed-Key"],
      maxAge: 600,
    }),
  );
  app.use(express.json({
    limit: process.env.JSON_BODY_LIMIT ?? "256kb",
    strict: true,
    verify(req, _res, buf) {
      (req as RawBodyRequest).rawBody = buf.toString("utf8");
    },
  }));
  app.use(apiRateLimit(120, 60_000));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, status: "healthy", now: Date.now() });
  });

  app.use("/webhooks/inbound-email", apiRateLimit(60, 60_000));
  app.use(
    "/webhooks/inbound-email",
    createInboundEmailRouter({
      emailService: params.emailService,
      indexService: params.indexService,
      attachmentHandler: params.attachmentHandler,
    }),
  );

  app.use(
    "/auth",
    createAuthRouter({
      botToken: params.botToken,
      registrationHandler: params.registrationHandler,
      indexService: params.indexService,
      sessionAuthService: params.sessionAuthService,
    }),
  );

  app.use(
    createAuthMiddleware({
      botToken: params.botToken,
      indexService: params.indexService,
      sessionAuthService: params.sessionAuthService,
    }),
  );

  app.use("/emails", createEmailsRouter(params.emailService, params.indexService));
  app.use("/compose", createComposeRouter(params.emailHandler));
  app.use("/assistant", createAssistantRouter(params.emailService));
  app.use("/attachments/upload", apiRateLimit(10, 60_000));
  app.use("/attachments", createAttachmentsRouter(params.attachmentHandler));
  app.use(
    "/user",
    createUserRouter(params.indexService, params.sessionAuthService, params.emailService),
  );

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof TMailError) {
      res.status(error.statusCode).json({
        ok: false,
        error: error.message,
      });
      return;
    }

    console.error(error);
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : error instanceof Error
          ? error.message
          : "Unknown server error";
    res.status(500).json({ ok: false, error: message });
  });

  return app;
}
