# T-Mail

```text
████████╗      ███╗   ███╗ █████╗ ██╗██╗
╚══██╔══╝      ████╗ ████║██╔══██╗██║██║
   ██║   █████╗██╔████╔██║███████║██║██║
   ██║   ╚════╝██║╚██╔╝██║██╔══██║██║██║
   ██║         ██║ ╚═╝ ██║██║  ██║██║███████╗
   ╚═╝         ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝
```

**T-Mail — Email reimagined inside Telegram.** Built by **Osman Akkawi**.

---

## Why T-Mail Beats Gmail, Outlook, and iCloud Mail

### The Storage Problem Every Gmail User Knows

Gmail gives you **15 GB** — shared across Gmail, Google Drive, and Google Photos. The moment a family photo or a large PDF lands in your inbox, that counter ticks down. Hit the cap and Google starts refusing new emails until you pay or delete old ones.

Outlook gives you **15 GB for email + 5 GB on OneDrive** — better, but still a hard ceiling you will eventually reach.

iCloud Mail shares from **5 GB** of your iCloud plan, which also covers photos, backups, and every other Apple service.

**T-Mail has no mailbox storage cap.** Every email, attachment, and file is stored in Telegram's cloud, which Telegram explicitly offers as **unlimited storage** for all users — free, with no subscription required. Telegram has provided this at no cost since 2013 and built it as a core promise of the platform.

### Exact Numbers: T-Mail vs the Competition

| | Gmail | Outlook | iCloud Mail | **T-Mail** |
|---|---|---|---|---|
| **Free mailbox storage** | 15 GB (shared) | 15 GB | 5 GB (shared) | **Unlimited** |
| **Paid storage** | From $2.99/mo (Google One) | From $1.99/mo (Microsoft 365) | From $0.99/mo | **Free forever** |
| **Max attachment per email** | 25 MB inline / 10 GB via Drive link | 20 MB inline / 2 GB via OneDrive link | 20 MB | **Up to 45 MB** via T-Mail Bot API |
| **Login required** | Google account + password | Microsoft account + password | Apple ID + password | **Telegram identity — no new account** |
| **Inbox in your messenger** | ❌ | ❌ | ❌ | ✅ |
| **Real-time Telegram push** | ❌ | ❌ | ❌ | ✅ |
| **Password to remember** | Yes | Yes | Yes | **No — your Telegram IS your identity** |

> **How T-Mail storage works:** Every email record, attachment reference, and file is written to Telegram's cloud servers through the Bot API. Telegram stores these in its own distributed cloud infrastructure — the same infrastructure that serves over **1 billion monthly active users** worldwide. There is no storage limit placed on this data by Telegram. T-Mail simply uses Telegram as the underlying storage layer.

> **Honest attachment note:** The Telegram Bot API (the programmatic interface T-Mail uses) caps individual file uploads at **50 MB** per file. T-Mail enforces a **45 MB** limit per attachment to stay within this safely. A user running their own self-hosted Local Bot API Server can increase this to **2 GB per file**, matching what Telegram Premium users get in the regular app. Gmail's inline attachment limit is 25 MB. T-Mail's 45 MB default is already nearly double Gmail's.

---

## What Is T-Mail

T-Mail is an email-style messaging system built by **Osman Akkawi**. It gives every Telegram user a real email address (`username@tmailok.abrdns.com`) and a full mailbox experience — inbox, sent, drafts, trash, attachments, search, smart assistant, Telegram login — all inside a Telegram Mini App.

The core idea: your Telegram account is your identity, your notification channel, and your file storage. No separate email password. No storage bill. No separate app to install.

---

## Why Osman Akkawi Built It

Most email apps are heavy, disconnected from messaging, and require separate accounts, passwords, storage systems, and hosting. T-Mail was built to explore a different idea:

- Use Telegram as the user identity and notification layer — 1 billion people already have it.
- Keep the product Telegram-first instead of building another generic webmail clone.
- Let users receive verification codes in Telegram instead of relying on traditional passwords.
- Store mailbox records and attachment references in Telegram's cloud — the same infrastructure that already holds your photos and files for free.
- Add external email bridges only where needed, without changing the core idea of T-Mail.

T-Mail is not just "another email UI." It is an experiment in making email a Telegram-native communication layer.

---

## The Innovation

T-Mail's innovation is the combination of email, Telegram identity, Telegram Mini Apps, external email bridging, and zero-cost cloud storage in one flow:

- **Telegram-native mailbox:** users open T-Mail from Telegram and use it like an app inside Telegram.
- **T-Mail identity:** users get real addresses like `username@tmailok.abrdns.com` that work with Gmail, Outlook, and iCloud.
- **Telegram verification:** email login sends a verification code to the user's Telegram — no password to remember.
- **Unlimited Telegram-backed storage:** mailbox events and attachment metadata are written as Telegram messages. Telegram's cloud holds the data with no storage cap, for free.
- **External email bridge:** T-Mail sends to and receives from Gmail, Outlook, iCloud, and other providers using Resend DNS routing.
- **Attachment pipeline:** inbound and outbound files up to 45 MB per file move between Telegram and external email providers.
- **Mail Butler:** smart digest, priority detection, and suggested replies make the mailbox feel more helpful than a basic inbox.
- **Free-first architecture:** the MVP runs with free DNS, free frontend hosting (Cloudflare Pages), a free backend tier (Koyeb), Telegram infrastructure, and Resend's free tier. No credit card required to run T-Mail.

---

## Telegram Storage — The Real Numbers

| Fact | Value |
|---|---|
| Telegram monthly active users (2025) | **1 billion+** |
| Telegram cloud storage limit per user | **Unlimited** (official Telegram policy) |
| Max file size — Telegram app (free user) | **2 GB per file** |
| Max file size — Telegram app (Premium user) | **4 GB per file** |
| Max file size — Telegram Bot API (standard) | **50 MB per file** |
| Max file size — Telegram Local Bot API Server | **2 GB per file** |
| T-Mail enforced attachment limit | **45 MB per file** (Bot API safe limit) |
| Cost to store in Telegram | **Free** |

When T-Mail writes an email to Telegram, it posts a structured message to the user's Telegram channel. Telegram stores that message on their servers indefinitely, for free, at no cost to the user. This is how T-Mail delivers unlimited mailbox storage — not by building its own storage infrastructure, but by standing on Telegram's existing, already-unlimited cloud.

---

## How It Works

T-Mail maps each account to Telegram-backed mailbox records. The backend stores user metadata in a master index stream and writes every email event as Telegram messages. The Mini App reads and updates that data through authenticated API routes secured with Telegram `initData` verification or Telegram OTP login.

```text
[Gmail / Outlook / iCloud]
        |
        v (via Resend + DNS)
[T-Mail Backend]
        |
        v
[Telegram Bot API]
        |
        +──▶ Master Index Channel (user registry)
        +──▶ User Inbox Channel (email records + attachments)
        +──▶ Direct Telegram notification to user
        |
[T-Mail Mini App] ◀──▶ reads/writes via T-Mail API
```

---

## Current Features

- Telegram Mini App login (initData) and Telegram OTP login (no password)
- Sending and receiving internal T-Mail messages between T-Mail users
- Sending external email to Gmail, Outlook, iCloud, and other providers through Resend
- Receiving external email through Resend inbound webhooks with duplicate protection
- Inbound and outbound attachments up to 45 MB per file
- Dark and light themes
- Responsive Telegram Mini App layout
- Inbox, Sent, Drafts, Trash, Starred folders
- Full-text search
- Threaded replies
- Telegram push notifications on every new email
- Mail Butler smart digest, priority inbox, and suggested replies
- Session persistence across backend restarts (Telegram-backed snapshot)
- Zero external storage services — Telegram is the database

---

## Why It Can Start Free

Telegram provides message and file hosting. T-Mail uses Telegram Bot API as identity, notification, and storage. For real internet email, the project uses a free delegated domain plus free-tier email routing and sending. Those free tiers are excellent for an MVP:

- **Frontend:** Cloudflare Pages (free)
- **Backend:** Koyeb free web service (512 MB RAM, 0.1 vCPU)
- **Email:** Resend free tier (3,000 emails/month, 100/day)
- **DNS:** ClouDNS free zone for `tmailok.abrdns.com`
- **Storage:** Telegram cloud — unlimited, free

---

## Production Hardening

- Run with `NODE_ENV=production`, a strong `JWT_SECRET`, exact `CORS_ALLOWED_ORIGINS`, and `ALLOW_DEV_AUTH_BYPASS=false`.
- Set `PUBLIC_API_BASE_URL` to your real HTTPS API origin so signed local attachment links never rely on user-supplied host headers.
- Keep `JSON_BODY_LIMIT`, `MAX_RECIPIENTS_PER_EMAIL`, `MAX_BODY_LENGTH`, and attachment limits conservative to reduce abuse and memory pressure.
- Set `TRUST_PROXY` only when the API is behind a known proxy or load balancer; otherwise leave it `false`.
- Use `API_TIMEOUT_MS`, `VITE_API_REQUEST_TIMEOUT_MS`, and `VITE_API_UPLOAD_TIMEOUT_MS` to fail slow requests instead of letting the UI hang.
- Rotate all API keys and webhook secrets before public launch. Never commit `.env` files to Git.

---

## Recommended Hosting Plan

For the free-first MVP:

- **Frontend:** Cloudflare Pages.
  - Root directory: `miniapp`
  - Build command: `npm install && npm run build`
  - Output directory: `dist`
- **Backend:** Koyeb Web Service.
  - Root directory: `bot`
  - Build command: `npm install && npm run build`
  - Start command: `npm start`
  - Health check path: `/health`
- **Email:** Resend for outbound sending and inbound receiving.
- **DNS:** ClouDNS free zone for `tmailok.abrdns.com`.
- **Telegram:** BotFather Mini App URL points to the deployed frontend, and `TELEGRAM_WEBHOOK_URL` points to the deployed backend.

### Backend Environment Variables

```env
NODE_ENV=production
ALLOW_DEV_AUTH_BYPASS=false
BOT_TOKEN=...
MASTER_INDEX_CHANNEL_ID=...
JWT_SECRET=...
MINIAPP_URL=https://YOUR_FRONTEND
PUBLIC_API_BASE_URL=https://YOUR_BACKEND
CORS_ALLOWED_ORIGINS=https://YOUR_FRONTEND
TELEGRAM_WEBHOOK_URL=https://YOUR_BACKEND/webhooks/telegram
TELEGRAM_WEBHOOK_SECRET=...
TMAIL_EMAIL_DOMAIN=tmailok.abrdns.com
OUTBOUND_EMAIL_PROVIDER=resend
RESEND_API_KEY=...
RESEND_WEBHOOK_SECRET=...
ATTACHMENT_FALLBACK_LOCAL=false
API_TIMEOUT_MS=120000
```

### Frontend Environment Variables

```env
VITE_API_BASE_URL=https://YOUR_BACKEND
VITE_TMAIL_EMAIL_DOMAIN=tmailok.abrdns.com
VITE_TELEGRAM_BOT_USERNAME=tmail_osman_bot
VITE_TELEGRAM_BOT_LINK=https://t.me/tmail_osman_bot
VITE_ALLOW_STANDALONE_WEB=true
VITE_API_UPLOAD_TIMEOUT_MS=120000
```

---

## Setup

1. Create a Telegram bot with BotFather and copy `BOT_TOKEN`.
2. Create one private channel to act as master index and add your bot as admin; copy the channel ID as `MASTER_INDEX_CHANNEL_ID`.
3. Clone this repo, copy `.env.example` files, and set real values.
4. Deploy `bot/` to Koyeb (or any public HTTPS Node host).
5. Deploy `miniapp/` to Cloudflare Pages with `VITE_API_BASE_URL` set.
6. Register the Telegram webhook: `https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://YOUR_BACKEND/webhooks/telegram&secret_token=YOUR_WEBHOOK_SECRET`
7. Set the Mini App URL in BotFather.

---

## Scale Notes

The current Telegram-backed, in-memory architecture is good for prototypes and small deployments. The Telegram cloud storage layer scales inherently — Telegram serves over 1 billion users. However, the in-memory email index (not the Telegram storage itself) would need to move to a real database (PostgreSQL, Redis) for high-traffic production. Telegram can remain a notification and file transport layer at any scale.

---

## Free External Email MVP

Closest zero-cost stack for a real domain email bridge:

- Free delegated domain: `tmailok.abrdns.com` (ClouDNS)
- Outbound: Resend free tier with `OUTBOUND_EMAIL_PROVIDER=resend`
- Inbound: Resend Receiving webhooks to `POST /webhooks/inbound-email`
- Frontend: Cloudflare Pages (free)
- Backend: Koyeb free tier

Flow:
```text
T-Mail user → backend → Resend → Gmail/Outlook/iCloud
Gmail/Outlook/iCloud → Resend Receiving webhook → backend → Telegram storage
```

---

## API Overview

- `POST /auth/verify` — validate Telegram initData and auto-register user
- `GET /auth/me` — current authenticated user
- `POST /auth/request-login-code` — send OTP to Telegram
- `POST /auth/verify-login-code` — verify OTP and create session
- `GET /emails?folder=inbox&limit=25&offset=0` — list emails
- `GET /emails/:folder/:id` — fetch email + thread
- `PATCH /emails/:folder/:id` — update read/star/labels/body metadata
- `DELETE /emails/:folder/:id` — move to trash
- `POST /compose/send` — send email
- `POST /compose/draft` — save draft
- `POST /webhooks/inbound-email` — receive email from Resend (idempotent, duplicate-safe)
- `POST /attachments/upload` — upload attachment via Telegram
- `GET /attachments/file/:fileId` — resolve Telegram file URL
- `GET /user/search-user?q=query` — address autocomplete
- `GET /user/storage-usage` — usage stats
- `GET /health` — health check

---

## Architecture

```text
[Telegram User]
     |
     v
[Telegram Mini App (React + Vite)]
     |
     v
[T-Mail Bot + API (Node/TypeScript)]
     |
     v
[Telegram Bot API]
     |
     +──▶ Master Index Channel (users + snapshot)
     +──▶ Mailbox Records (emails + attachment metadata)
     +──▶ Direct Telegram notifications
     |
[Resend]
     |
     +──▶ Outbound to Gmail / Outlook / iCloud
     +──▶ Inbound from Gmail / Outlook / iCloud
```

---

## Contributing

1. Fork and create a branch.
2. Run `npm install` in both `bot/` and `miniapp/`.
3. Run `npm run dev` in each package.
4. Submit a PR with tests or reproducible validation steps.

---

## License

MIT
