const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { createTestServices, seedUser } = require("./test-harness");

const USER_COUNT = Number(process.env.LOAD_TEST_USERS ?? 1000);
const MESSAGE_COUNT = Number(process.env.LOAD_TEST_MESSAGES ?? 3000);
const ATTACHMENT_STEP = Number(process.env.LOAD_TEST_ATTACHMENT_STEP ?? 50);

function pad(value) {
  return String(value).padStart(4, "0");
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function nowMs() {
  return performance.now();
}

function roundMs(start, end = nowMs()) {
  return Math.round(end - start);
}

async function main() {
  const assertions = [];
  const check = (condition, label) => {
    assert.equal(Boolean(condition), true, label);
    assertions.push(label);
  };
  const equal = (actual, expected, label) => {
    assert.equal(actual, expected, label);
    assertions.push(label);
  };

  const services = createTestServices();
  const timings = {};
  const expectedInboxCounts = new Array(USER_COUNT).fill(0);
  const users = [];

  const registerStart = nowMs();
  for (let index = 0; index < USER_COUNT; index += 1) {
    users.push(
      await seedUser(services, {
        telegramUserId: 5_000_000 + index,
        telegramUsername: `loaduser${pad(index)}`,
        firstName: `Load${pad(index)}`,
        lastName: "User",
        tmailAddress: `loaduser${pad(index)}@tmail`,
        mirrorChatId: 7_000_000 + index,
      }),
    );
  }
  timings.registerMs = roundMs(registerStart);

  const attachmentStart = nowMs();
  const attachmentsByUserIndex = new Map();
  for (let index = 0; index < USER_COUNT; index += ATTACHMENT_STEP) {
    const owner = services.index.lookupByAddress(users[index].tmailAddress);
    const attachment = await services.storage.uploadAttachment(owner, {
      buffer: Buffer.from(`production-load-attachment-${index}`),
      originalname: `load-${pad(index)}.txt`,
      mimetype: "text/plain",
      size: Buffer.byteLength(`production-load-attachment-${index}`),
    });
    attachmentsByUserIndex.set(index, attachment);
  }
  timings.attachmentMs = roundMs(attachmentStart);

  let deliveredRecipientTotal = 0;
  let firstEnvelope = null;
  const sendStart = nowMs();
  for (let index = 0; index < MESSAGE_COUNT; index += 1) {
    const fromIndex = index % USER_COUNT;
    const toIndex = (index * 37 + 17) % USER_COUNT;
    const ccIndex = (index * 53 + 19) % USER_COUNT;
    const bccIndex = (index * 97 + 23) % USER_COUNT;
    const sender = services.index.lookupByAddress(users[fromIndex].tmailAddress);
    const from = sender.tmailAddress;
    const to = index % 250 === 0 ? [] : [users[toIndex].tmailAddress];
    const cc = [users[ccIndex].tmailAddress];
    const bcc = [users[bccIndex].tmailAddress];
    const subject = index === 0
      ? "<script>load-e2e-needle urgent invoice</script>"
      : `Load message ${index}${index % 7 === 0 ? " urgent invoice" : ""}`;
    const body = index === 0
      ? "Please confirm payment today with needle-keyword-prod-test."
      : `Message ${index} asks for review and confirmation from ${from}.`;
    const recipients = new Set([toIndex, ccIndex, bccIndex]);

    if (to.length === 0) {
      recipients.delete(toIndex);
    }

    const result = await services.email.sendEmail({
      from,
      to,
      cc,
      bcc,
      subject,
      body,
      bodyHtml: body,
      attachments: attachmentsByUserIndex.has(fromIndex) && index % 20 === 0
        ? [attachmentsByUserIndex.get(fromIndex)]
        : [],
    });

    for (const recipientIndex of recipients) {
      expectedInboxCounts[recipientIndex] += 1;
    }
    deliveredRecipientTotal += result.deliveredTo.length;

    if (!firstEnvelope) {
      firstEnvelope = {
        subject,
        toUser: users[ccIndex],
        bccUser: users[bccIndex],
        bccAddress: users[bccIndex].tmailAddress,
      };
    }
  }
  timings.sendMs = roundMs(sendStart);

  const draftStart = nowMs();
  for (let index = 0; index < USER_COUNT; index += 100) {
    const owner = services.index.lookupByAddress(users[index].tmailAddress);
    await services.email.saveDraft(owner, {
      from: owner.tmailAddress,
      to: [users[(index + 1) % USER_COUNT].tmailAddress],
      cc: [],
      bcc: [],
      subject: `Draft load ${index}`,
      body: "Draft body for load testing.",
      bodyHtml: "Draft body for load testing.",
      attachments: [],
    });
  }
  timings.draftMs = roundMs(draftStart);

  const readStart = nowMs();
  let actualInboxTotal = 0;
  let sampledUsersMatch = 0;
  for (let index = 0; index < USER_COUNT; index += 1) {
    const owner = services.index.lookupByAddress(users[index].tmailAddress);
    const inbox = services.email.listEmails(owner, "inbox", MESSAGE_COUNT, 0);
    actualInboxTotal += inbox.length;
    if (index % 111 === 0 && inbox.length === expectedInboxCounts[index]) {
      sampledUsersMatch += 1;
    }
  }
  timings.readMs = roundMs(readStart);

  const toInbox = services.email.listEmails(firstEnvelope.toUser, "inbox", MESSAGE_COUNT, 0);
  const toCopy = toInbox.find((email) => email.subject === firstEnvelope.subject);
  const bccInbox = services.email.listEmails(firstEnvelope.bccUser, "inbox", MESSAGE_COUNT, 0);
  const bccCopy = bccInbox.find((email) => email.subject === firstEnvelope.subject);
  check(toCopy, "delivers CC-only first message copy");
  check(bccCopy, "delivers BCC first message copy");

  const searchResults = services.email.search(firstEnvelope.toUser, "needle-keyword-prod-test");
  const updated = services.email.updateEmail(firstEnvelope.toUser, "inbox", toCopy.id, {
    status: "read",
    starred: true,
    labels: ["load-tested"],
  });
  await services.email.deleteEmail(firstEnvelope.toUser, "inbox", toCopy.id);
  const trash = services.email.listEmails(firstEnvelope.toUser, "trash", MESSAGE_COUNT, 0);
  const butler = services.email.getMailButlerInsights(firstEnvelope.bccUser);
  const mailboxStorage = services.email.calculateMailboxStorageUsed(firstEnvelope.bccUser);
  const escapedRecord = services.telegram.messages.find((message) =>
    message.text.includes("&lt;script&gt;load-e2e-needle urgent invoice&lt;/script&gt;"),
  );

  equal(services.index.listAllUsers().length, USER_COUNT, "registers all seeded users");
  check(services.index.lookupByAddress("loaduser0999@tmail"), "looks up the last primary address");
  equal(attachmentsByUserIndex.size, Math.ceil(USER_COUNT / ATTACHMENT_STEP), "uploads sampled attachments");
  check(
    services.index.lookupByAddress("loaduser0000@tmail").storageUsed > 0,
    "tracks upload and mailbox storage for active users",
  );
  equal(deliveredRecipientTotal, actualInboxTotal, "delivers every expected recipient copy");
  equal(actualInboxTotal, expectedInboxCounts.reduce((total, count) => total + count, 0), "matches inbox totals");
  equal(sampledUsersMatch, Math.ceil(USER_COUNT / 111), "sampled inbox counts match exactly");
  equal(toCopy.bcc.length, 0, "hides BCC list from non-BCC recipients");
  equal(bccCopy.bcc[0], firstEnvelope.bccAddress, "shows only own BCC address to BCC recipient");
  equal(searchResults.length >= 1, true, "search finds seeded needle email");
  equal(updated.status, "read", "updates read status");
  equal(updated.starred, true, "updates starred status");
  check(trash.some((email) => email.id === toCopy.id), "delete moves inbox copy to trash");
  check(butler.unreadCount > 0, "Mail Butler counts unread load messages");
  check(butler.actionCount > 0, "Mail Butler detects action-oriented load messages");
  check(mailboxStorage > 0, "calculates mailbox storage for loaded mailbox");
  check(escapedRecord, "escapes dangerous HTML in Telegram records");
  check(timings.sendMs > 0, "records non-zero send timing");

  const memory = process.memoryUsage();
  const throughput = Math.round(MESSAGE_COUNT / Math.max(0.001, timings.sendMs / 1000));
  const report = {
    users: USER_COUNT,
    messages: MESSAGE_COUNT,
    deliveredRecipientCopies: deliveredRecipientTotal,
    attachmentUploads: attachmentsByUserIndex.size,
    timings,
    throughputMessagesPerSecond: throughput,
    memoryMb: {
      rss: mb(memory.rss),
      heapUsed: mb(memory.heapUsed),
    },
  };

  console.log(`PASS thousand-user-load-test: ${assertions.length}/${assertions.length} assertions passed`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error("FAIL thousand-user-load-test");
  console.error(error);
  process.exit(1);
});
