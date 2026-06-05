const http = require("node:http");
const { AttachmentHandler } = require("../dist/handlers/attachment");
const { EmailHandler } = require("../dist/handlers/email");
const { RegistrationHandler } = require("../dist/handlers/registration");
const { createApiServer } = require("../dist/api/server");
const { EmailService } = require("../dist/services/email");
const { MasterIndexService } = require("../dist/services/index");
const { SessionAuthService } = require("../dist/services/session-auth");
const { StorageService } = require("../dist/services/storage");
const { ThreadService } = require("../dist/services/thread");

class FakeTelegramClient {
  constructor(options = {}) {
    this.nextMessageId = 1;
    this.messages = [];
    this.edits = [];
    this.uploads = [];
    this.files = new Map();
    this.notifications = [];
    this.failUploads = Boolean(options.failUploads);
  }

  async postMessage(channelId, text) {
    const message = { channelId, text, messageId: this.nextMessageId++ };
    this.messages.push(message);
    return { messageId: message.messageId };
  }

  async editMessage(channelId, messageId, text) {
    this.edits.push({ channelId, messageId, text });
    return true;
  }

  async uploadFile(channelId, buffer, filename, mimeType) {
    if (this.failUploads) {
      throw new Error("Telegram upload network error");
    }

    const messageId = this.nextMessageId++;
    const fileId = `fake-file-${messageId}`;
    const fileBuffer = Buffer.from(buffer);
    this.files.set(fileId, { buffer: fileBuffer, mimeType });
    this.uploads.push({ channelId, filename, mimeType, size: fileBuffer.length, fileId });
    return { messageId, fileId, fileSize: buffer.length };
  }

  async getFileUrl(fileId) {
    const file = this.files.get(fileId);
    if (file) {
      return `data:${file.mimeType || "application/octet-stream"};base64,${file.buffer.toString("base64")}`;
    }

    return `https://files.example.test/${encodeURIComponent(fileId)}`;
  }

  async sendNotification(chatId, text) {
    this.notifications.push({ chatId, text });
    return true;
  }
}

function setTestEnv(overrides = {}) {
  Object.assign(process.env, {
    ALLOW_DEV_AUTH_BYPASS: "true",
    API_TIMEOUT_MS: "15000",
    CORS_ALLOWED_ORIGINS: "http://127.0.0.1:5174,http://localhost:5174",
    DEV_AUTH_BYPASS_LOCAL_ONLY: "true",
    DEV_TELEGRAM_FIRST_NAME: "Dev",
    DEV_TELEGRAM_LAST_NAME: "User",
    DEV_TELEGRAM_USER_ID: "1376576931",
    DEV_TELEGRAM_USERNAME: "devuser",
    JSON_BODY_LIMIT: "512kb",
    JWT_SECRET: "test-jwt-secret-that-is-long-enough",
    MAX_ATTACHMENT_SIZE_MB: "20",
    MAX_RECIPIENTS_PER_EMAIL: "50",
    MAX_TOTAL_ATTACHMENTS_SIZE_MB: "45",
    NODE_ENV: "test",
    ...overrides,
  });
}

function createTestServices(options = {}) {
  setTestEnv(options.env);
  const telegram = new FakeTelegramClient(options.telegram);
  const index = new MasterIndexService(telegram, options.masterIndexChannelId ?? -100123);
  const threads = new ThreadService();
  const storage = new StorageService(telegram, index);
  const externalAttachmentResolver = async (attachment) => {
    const content = await storage.readAttachmentContent(attachment);
    return {
      filename: content.filename,
      content: content.buffer.toString("base64"),
      contentType: content.mimeType,
      size: content.size,
    };
  };
  const email = new EmailService(
    telegram,
    index,
    threads,
    options.externalEmailTransport ?? null,
    externalAttachmentResolver,
  );
  const registration = new RegistrationHandler(index);
  const emailHandler = new EmailHandler(email);
  const attachmentHandler = new AttachmentHandler(storage);
  const sessionAuth = new SessionAuthService(process.env.JWT_SECRET, telegram);

  return {
    telegram,
    index,
    threads,
    email,
    storage,
    registration,
    emailHandler,
    attachmentHandler,
    sessionAuth,
  };
}

async function seedUser(services, params) {
  const user = await services.registration.registerUser({
    telegramUserId: params.telegramUserId,
    telegramUsername: params.telegramUsername,
    firstName: params.firstName,
    lastName: params.lastName,
    preferredAddress: params.tmailAddress,
  });

  if (params.mirrorChatId) {
    return services.index.updateUser(user.tmailAddress, {
      channels: {
        inbox: params.mirrorChatId,
        sent: params.mirrorChatId,
        drafts: params.mirrorChatId,
        trash: params.mirrorChatId,
      },
    });
  }

  return user;
}

function createTestApi(services, options = {}) {
  return createApiServer({
    botToken: options.botToken ?? "123456:test-token",
    miniAppUrl: options.miniAppUrl ?? "http://127.0.0.1:5174",
    indexService: services.index,
    sessionAuthService: services.sessionAuth,
    emailService: services.email,
    registrationHandler: services.registration,
    emailHandler: services.emailHandler,
    attachmentHandler: services.attachmentHandler,
  });
}

function listen(app, port = 0) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = {
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers ?? {}),
  };

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : {};
  if (!response.ok || !payload.ok) {
    const error = new Error(
      `${options.label ?? `${options.method ?? "GET"} ${path}`} failed (${response.status}): ${payload.error ?? raw}`,
    );
    error.response = response;
    error.payload = payload;
    throw error;
  }
  return payload.data;
}

module.exports = {
  FakeTelegramClient,
  apiRequest,
  closeServer,
  createTestApi,
  createTestServices,
  listen,
  seedUser,
  setTestEnv,
};
