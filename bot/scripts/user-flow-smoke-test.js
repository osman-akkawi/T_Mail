const assert = require("node:assert/strict");
const { MasterIndexService } = require("../dist/services/index");
const { EmailService } = require("../dist/services/email");
const { StorageService } = require("../dist/services/storage");
const { ThreadService } = require("../dist/services/thread");
const { RegistrationHandler } = require("../dist/handlers/registration");

class FakeTelegramClient {
  constructor() {
    this.nextMessageId = 1;
    this.messages = [];
    this.edits = [];
    this.uploads = [];
    this.files = new Map();
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

  async sendNotification() {
    return true;
  }
}

async function main() {
  process.env.MAX_ATTACHMENT_SIZE_MB = "20";
  process.env.MAX_TOTAL_ATTACHMENTS_SIZE_MB = "45";

  const telegram = new FakeTelegramClient();
  const index = new MasterIndexService(telegram, -100123);
  const threads = new ThreadService();
  const externalSends = [];
  const externalTransport = {
    async send(input) {
      externalSends.push(input);
      return { provider: "fake", messageId: "fake-external-message" };
    },
  };
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
    externalTransport,
    externalAttachmentResolver,
  );
  const registration = new RegistrationHandler(index);

  const alice = await registration.registerUser({
    telegramUserId: 1001,
    telegramUsername: "alice",
    firstName: "Alice",
    preferredAddress: "alice@tmail",
  });
  const bob = await registration.registerUser({
    telegramUserId: 1002,
    telegramUsername: "bob",
    firstName: "Bob",
    preferredAddress: "bob@tmail",
  });

  assert.equal(alice.tmailAddress, "alice@tmail", "registers Alice primary address");
  assert.equal(bob.tmailAddress, "bob@tmail", "registers Bob primary address");

  const uploaded = await storage.uploadAttachment(alice, {
    buffer: Buffer.from("invoice attachment"),
    originalname: "invoice.txt",
    mimetype: "text/plain",
    size: Buffer.byteLength("invoice attachment"),
  });
  assert.equal(uploaded.size > 0, true, "uploads attachment through Telegram transport");
  assert.equal(index.lookupByTelegramId(alice.telegramUserId).storageUsed > 0, true, "tracks upload storage");

  const sent = await email.sendEmail({
    from: "alice@tmail",
    to: ["bob@tmail"],
    cc: [],
    bcc: [],
    subject: "<script>alert(1)</script> urgent invoice?",
    body: "Can you review and confirm payment today?",
    bodyHtml: "Can you review and confirm payment today?",
    attachments: [uploaded],
  });
  assert.equal(sent.deliveredTo.length, 1, "deduplicates and delivers to recipient");
  assert.equal(sent.email.from, "alice@tmail", "sends from primary identity");

  const externalSent = await email.sendEmail({
    from: "alice@tmail",
    to: ["friend@example.com"],
    cc: [],
    bcc: [],
    subject: "External hello",
    body: "Hello from T-Mail.",
    bodyHtml: "Hello from T-Mail.",
    attachments: [uploaded],
  });
  assert.equal(externalSent.deliveredTo[0], "friend@example.com", "delivers external email through provider");
  assert.equal(externalSends[0].to[0], "friend@example.com", "external provider receives recipient");
  assert.equal(externalSends[0].attachments.length, 1, "external provider receives attachment");
  assert.equal(
    Buffer.from(externalSends[0].attachments[0].content, "base64").toString("utf8"),
    "invoice attachment",
    "external provider receives attachment bytes",
  );

  const inbound = await email.receiveExternalEmail({
    from: "friend@example.com",
    to: ["alice@tmail"],
    subject: "External reply",
    body: "Replying back into T-Mail.",
  });
  assert.equal(inbound.deliveredTo[0], "alice@tmail", "stores inbound external email for T-Mail user");

  const bobInbox = email.listEmails(bob, "inbox", 10, 0);
  assert.equal(bobInbox.length, 1, "recipient receives inbox message");
  assert.equal(bobInbox[0].attachments.length, 1, "recipient sees attachment metadata");

  const escapedRecord = telegram.messages.find((message) => message.text.includes("&lt;script&gt;"));
  assert.ok(escapedRecord, "escapes HTML before writing Telegram records");

  const insights = email.getMailButlerInsights(bob);
  assert.equal(insights.unreadCount, 1, "Mail Butler counts unread inbox");
  assert.equal(insights.actionCount >= 1, true, "Mail Butler detects action item");
  assert.equal(insights.priority.length >= 1, true, "Mail Butler returns priority message");
  assert.equal(insights.suggestedReplies.length >= 1, true, "Mail Butler suggests replies");

  const draft = await email.saveDraft(bob, {
    to: ["alice@tmail"],
    cc: [],
    bcc: [],
    subject: "Draft reply",
    body: "I will review this.",
    bodyHtml: "I will review this.",
    attachments: [],
  });
  assert.equal(draft.status, "draft", "saves draft");

  const searchResults = email.search(bob, "invoice");
  assert.equal(searchResults.length >= 1, true, "search finds invoice message");

  await email.deleteEmail(bob, "inbox", bobInbox[0].id);
  assert.equal(email.listEmails(bob, "inbox", 10, 0).length, 0, "deletes inbox copy");
  assert.equal(email.listEmails(bob, "trash", 10, 0).length, 1, "moves deleted email to trash");

  const mailboxBytes = email.calculateMailboxStorageUsed(bob);
  assert.equal(mailboxBytes > 0, true, "calculates mailbox storage usage");

  console.log("PASS user-flow-smoke-test: 23/23 assertions passed");
}

main().catch((error) => {
  console.error("FAIL user-flow-smoke-test");
  console.error(error);
  process.exit(1);
});
