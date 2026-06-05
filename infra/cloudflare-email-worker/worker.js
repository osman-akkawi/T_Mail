async function streamToText(stream) {
  return new Response(stream).text();
}

function splitAddresses(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export default {
  async email(message, env) {
    const raw = await streamToText(message.raw);
    const subject = message.headers.get("subject") || "(no subject)";
    const cc = splitAddresses(message.headers.get("cc"));

    const response = await fetch(env.TMAIL_INBOUND_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TMail-Webhook-Secret": env.TMAIL_INBOUND_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        cc,
        subject,
        text: raw.slice(0, Number(env.TMAIL_MAX_RAW_EMAIL_CHARS || 100000)),
        receivedAt: Date.now(),
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`T-Mail inbound webhook failed: ${response.status} ${details}`);
    }
  },
};
