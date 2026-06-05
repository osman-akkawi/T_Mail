const assert = require("node:assert/strict");
const { Webhook } = require("svix");
const {
  apiRequest,
  closeServer,
  createTestApi,
  createTestServices,
  listen,
} = require("./test-harness");

async function rawJson(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (_error) {
    return { ok: false, error: raw };
  }
}

async function uploadAttachment(baseUrl, token) {
  const form = new FormData();
  form.append(
    "file",
    new Blob(["api integration attachment"], { type: "text/plain" }),
    "api-integration.txt",
  );

  const response = await fetch(`${baseUrl}/attachments/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const payload = await rawJson(response);
  if (!response.ok || !payload.ok) {
    throw new Error(`attachment upload failed (${response.status}): ${payload.error ?? ""}`);
  }
  return payload.data.attachment;
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

  const resendWebhookSecret = `whsec_${Buffer.from("api-integration-resend-webhook").toString("base64")}`;
  const services = createTestServices({
    env: {
      RESEND_API_KEY: "re_api_integration_test",
      RESEND_WEBHOOK_SECRET: resendWebhookSecret,
    },
  });
  const app = createTestApi(services);
  const { server, baseUrl } = await listen(app, 0);

  try {
    const healthResponse = await fetch(`${baseUrl}/health`);
    const health = await rawJson(healthResponse);
    equal(health.ok, true, "health endpoint responds");
    equal(healthResponse.headers.get("x-content-type-options"), "nosniff", "security header is present");

    const seed = (body) =>
      apiRequest(baseUrl, "/auth/dev/create-test-user", {
        method: "POST",
        body,
        label: `seed ${body.tmailAddress}`,
      });

    const alice = await seed({
      telegramUserId: 9_001,
      telegramUsername: "api_alice",
      firstName: "API",
      lastName: "Alice",
      tmailAddress: "api-alice@tmail",
      mirrorChatId: 90_001,
    });
    const bob = await seed({
      telegramUserId: 9_002,
      telegramUsername: "api_bob",
      firstName: "API",
      lastName: "Bob",
      tmailAddress: "api-bob@tmail",
      mirrorChatId: 90_002,
    });
    const cara = await seed({
      telegramUserId: 9_003,
      telegramUsername: "api_cara",
      firstName: "API",
      lastName: "Cara",
      tmailAddress: "api-cara@tmail",
      mirrorChatId: 90_003,
    });
    const dave = await seed({
      telegramUserId: 9_004,
      telegramUsername: "api_dave",
      firstName: "API",
      lastName: "Dave",
      tmailAddress: "api-dave@tmail",
      mirrorChatId: 90_004,
    });

    const aliceToken = alice.sessionToken;
    const bobToken = bob.sessionToken;
    const caraToken = cara.sessionToken;
    const daveToken = dave.sessionToken;

    equal(alice.user.tmailAddress, "api-alice@tmail", "dev seeder creates Alice");
    equal(bob.user.tmailAddress, "api-bob@tmail", "dev seeder creates Bob");

    const attachment = await uploadAttachment(baseUrl, aliceToken);
    equal(attachment.name, "api-integration.txt", "uploads attachment through API");

    const sent = await apiRequest(baseUrl, "/compose/send", {
      method: "POST",
      token: aliceToken,
      body: {
        from: "api-alice@tmail",
        to: ["api-bob@tmail"],
        cc: ["api-cara@tmail"],
        bcc: ["api-dave@tmail"],
        subject: "<b>API urgent invoice</b>",
        body: "Please confirm this API payment today. api-integration-needle",
        attachments: [attachment],
      },
      label: "send email",
    });
    equal(sent.deliveredTo.length, 3, "delivers To/CC/BCC recipient copies");
    equal(sent.email.from, "api-alice@tmail", "sends from primary identity");

    const bobInbox = await apiRequest(baseUrl, "/emails?folder=inbox&limit=10", {
      token: bobToken,
      label: "bob inbox",
    });
    const bobEmail = bobInbox.emails[0];
    check(bobEmail, "Bob receives inbox email");
    equal(bobEmail.attachments.length, 1, "Bob sees attachment metadata");
    equal(bobEmail.bcc.length, 0, "Bob cannot see BCC recipient list");

    const caraInbox = await apiRequest(baseUrl, "/emails?folder=inbox&limit=10", {
      token: caraToken,
      label: "cara inbox",
    });
    equal(caraInbox.emails.length, 1, "Cara receives CC email");

    const daveInbox = await apiRequest(baseUrl, "/emails?folder=inbox&limit=10", {
      token: daveToken,
      label: "dave inbox",
    });
    equal(daveInbox.emails[0].bcc[0], "api-dave@tmail", "Dave sees only his own BCC address");

    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      const href = typeof url === "string" ? url : url.url;
      if (href === "https://api.resend.com/emails/receiving/resend-api-email-1") {
        equal(
          options.headers.Authorization,
          "Bearer re_api_integration_test",
          "Resend receiving API uses configured API key",
        );
        return new Response(JSON.stringify({
          id: "resend-api-email-1",
          from: "Outside Sender <sender@example.com>",
          to: ["api-bob@tmail"],
          cc: ["API Cara <api-cara@tmail>"],
          bcc: ["api-dave@tmail"],
          subject: "External inbound",
          text: "",
          html: `<div dir="ltr">Hello from outside. api-inbound-needle</div><br><div class="gmail_quote gmail_quote_container"><blockquote>old quoted text</blockquote></div>`,
          attachments: [
            {
              id: "resend-attachment-1",
              filename: "api-inbound.txt",
              content_type: "text/plain",
              content_disposition: "attachment",
              content_id: null,
            },
          ],
          created_at: new Date(Date.now() + 1_000).toISOString(),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href === "https://api.resend.com/emails/receiving/resend-api-email-1/attachments") {
        return new Response(JSON.stringify({
          object: "list",
          has_more: false,
          data: [
            {
              id: "resend-attachment-1",
              filename: "api-inbound.txt",
              size: Buffer.byteLength("inbound attachment body"),
              content_type: "text/plain",
              content_disposition: "attachment",
              content_id: null,
              download_url: "https://download.example.test/api-inbound.txt",
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href === "https://download.example.test/api-inbound.txt") {
        return new Response("inbound attachment body", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      return originalFetch(url, options);
    };
    try {
      const resendPayload = JSON.stringify({
        type: "email.received",
        created_at: new Date().toISOString(),
        data: {
          email_id: "resend-api-email-1",
          from: "sender@example.com",
          to: ["api-bob@tmail"],
          cc: ["api-cara@tmail"],
          bcc: ["api-dave@tmail"],
          subject: "External inbound",
        },
      });
      const resendTimestamp = new Date();
      const resendSignature = new Webhook(resendWebhookSecret).sign(
        "msg_api_inbound_1",
        resendTimestamp,
        resendPayload,
      );
      const inboundResponse = await fetch(`${baseUrl}/webhooks/inbound-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": "msg_api_inbound_1",
          "svix-timestamp": String(Math.floor(resendTimestamp.getTime() / 1000)),
          "svix-signature": resendSignature,
        },
        body: resendPayload,
      });
      const inbound = await rawJson(inboundResponse);
      equal(inboundResponse.status, 200, "accepts signed Resend inbound webhook");
      equal(inbound.ok, true, "Resend inbound webhook response is ok");
      equal(inbound.data.deliveredTo.length, 3, "Resend inbound delivers To/CC/BCC users");
    } finally {
      global.fetch = originalFetch;
    }

    const externalBobInbox = await apiRequest(baseUrl, "/emails?folder=inbox&limit=10", {
      token: bobToken,
      label: "bob inbox after external inbound",
    });
    const bobInboundEmail = externalBobInbox.emails.find((email) =>
      email.body.includes("api-inbound-needle"),
    );
    check(
      bobInboundEmail,
      "Bob receives Resend inbound email body",
    );
    equal(bobInboundEmail.body.includes("<div"), false, "Resend inbound HTML is converted to safe text");
    equal(bobInboundEmail.body.includes("old quoted text"), false, "Gmail quoted history is removed");
    equal(bobInboundEmail.attachments.length, 1, "Bob receives Resend inbound attachment metadata");
    equal(bobInboundEmail.attachments[0].name, "api-inbound.txt", "Resend inbound attachment keeps filename");

    const detail = await apiRequest(baseUrl, `/emails/inbox/${encodeURIComponent(bobEmail.id)}`, {
      token: bobToken,
      label: "email detail",
    });
    equal(detail.thread.length, 1, "loads email detail and thread");

    const search = await apiRequest(baseUrl, "/emails/search/query?q=api-integration-needle", {
      token: bobToken,
      label: "search",
    });
    equal(search.emails.length, 1, "search finds API email");

    const updated = await apiRequest(baseUrl, `/emails/inbox/${encodeURIComponent(bobEmail.id)}`, {
      method: "PATCH",
      token: bobToken,
      body: { status: "read", starred: true, labels: ["api-tested"] },
      label: "update email",
    });
    equal(updated.email.status, "read", "marks API email read");
    equal(updated.email.starred, true, "stars API email");

    const butler = await apiRequest(baseUrl, "/assistant/insights", {
      token: daveToken,
      label: "butler",
    });
    check(butler.insights.actionCount > 0, "Mail Butler returns action insights");

    const draft = await apiRequest(baseUrl, "/compose/draft", {
      method: "POST",
      token: bobToken,
      body: {
        to: ["api-alice@tmail"],
        cc: [],
        bcc: [],
        subject: "API draft",
        body: "Draft body",
        attachments: [],
      },
      label: "save draft",
    });
    equal(draft.draft.status, "draft", "saves draft through API");

    await apiRequest(baseUrl, `/emails/inbox/${encodeURIComponent(bobEmail.id)}`, {
      method: "DELETE",
      token: bobToken,
      label: "delete email",
    });
    const bobTrash = await apiRequest(baseUrl, "/emails?folder=trash&limit=10", {
      token: bobToken,
      label: "trash",
    });
    check(bobTrash.emails.some((email) => email.id === bobEmail.id), "delete moves email to trash");

    const storage = await apiRequest(baseUrl, "/user/storage-usage", {
      token: aliceToken,
      label: "storage",
    });
    check(storage.used > 0, "storage endpoint reports usage");
    equal(storage.limit, 0, "storage endpoint reports unlimited free plan limit");
    equal(storage.unlimited, true, "storage endpoint reports unlimited flag");

    const users = await apiRequest(baseUrl, "/user/search-user?q=api-", {
      token: aliceToken,
      label: "search users",
    });
    check(users.users.length >= 3, "user search returns seeded users");

    const sessions = await apiRequest(baseUrl, "/user/sessions", {
      token: aliceToken,
      label: "sessions",
    });
    check(sessions.sessions.length >= 1, "sessions endpoint lists active session");

    const invalidFromResponse = await fetch(`${baseUrl}/compose/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "api-bob@tmail",
        to: ["api-cara@tmail"],
        subject: "spoof attempt",
        body: "should fail",
      }),
    });
    const invalidFrom = await rawJson(invalidFromResponse);
    equal(invalidFromResponse.status, 400, "rejects sender spoofing");
    equal(invalidFrom.ok, false, "sender spoofing response is not ok");

    const unauthResponse = await fetch(`${baseUrl}/user/me`);
    const unauth = await rawJson(unauthResponse);
    equal(unauthResponse.status, 401, "rejects missing auth token");
    equal(unauth.ok, false, "missing auth response is not ok");

    const escapedRecord = services.telegram.messages.find((message) =>
      message.text.includes("&lt;b&gt;API urgent invoice&lt;/b&gt;"),
    );
    check(escapedRecord, "API path escapes HTML before Telegram record storage");

    console.log(`PASS api-integration-test: ${assertions.length}/${assertions.length} assertions passed`);
  } finally {
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error("FAIL api-integration-test");
  console.error(error);
  process.exit(1);
});
