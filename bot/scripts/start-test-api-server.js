const { closeServer, createTestApi, createTestServices, listen, seedUser } = require("./test-harness");

async function main() {
  const port = Number(process.env.TEST_API_PORT ?? 3000);
  const devTelegramUserId = Number(process.env.DEV_TELEGRAM_USER_ID ?? 1376576931);
  const services = createTestServices({
    env: {
      DEV_TELEGRAM_USER_ID: String(devTelegramUserId),
      DEV_TELEGRAM_USERNAME: "devuser",
      DEV_TELEGRAM_FIRST_NAME: "Dev",
      DEV_TELEGRAM_LAST_NAME: "User",
    },
  });

  const devUser = await seedUser(services, {
    telegramUserId: devTelegramUserId,
    telegramUsername: "devuser",
    firstName: "Dev",
    lastName: "User",
    tmailAddress: "devuser@tmail",
    mirrorChatId: devTelegramUserId,
  });
  const bob = await seedUser(services, {
    telegramUserId: 13_765_769,
    telegramUsername: "browser_bob",
    firstName: "Browser",
    lastName: "Bob",
    tmailAddress: "browser-bob@tmail",
    mirrorChatId: 13_765_769,
  });

  await services.email.sendEmail({
    from: bob.tmailAddress,
    to: [devUser.tmailAddress],
    cc: [],
    bcc: [],
    subject: "Browser E2E urgent invoice",
    body: "Please confirm this browser seeded payment today.",
    bodyHtml: "Please confirm this browser seeded payment today.",
    attachments: [],
  });

  const app = createTestApi(services);
  const { server, baseUrl } = await listen(app, port);
  console.log(`TEST_API_READY ${baseUrl}`);

  const shutdown = async () => {
    await closeServer(server);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("TEST_API_FAILED");
  console.error(error);
  process.exit(1);
});
