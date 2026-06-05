# T-Mail Cloudflare Email Worker

This worker is the free inbound-email bridge:

`Gmail/Outlook/iCloud -> your EU.org domain MX -> Cloudflare Email Worker -> T-Mail backend -> Telegram storage`

## Setup

1. Get a free delegated subdomain from EU.org, for example `mytmail.eu.org`.
2. Add that domain to Cloudflare DNS.
3. Enable Cloudflare Email Routing for the domain.
4. Copy `wrangler.toml.example` to `wrangler.toml`.
5. Set `TMAIL_INBOUND_WEBHOOK_URL` to your deployed backend:
   `https://YOUR_BACKEND_HOST/webhooks/inbound-email`
6. Add the shared secret:
   `wrangler secret put TMAIL_INBOUND_WEBHOOK_SECRET`
7. Deploy:
   `wrangler deploy`
8. In Cloudflare Email Routing, route catch-all or specific addresses to this Worker.

Use the same secret value in the backend env var `INBOUND_EMAIL_WEBHOOK_SECRET`.
