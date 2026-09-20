# Meta Webhooks Server (Pages + WhatsApp + Instagram)

A single Express service that receives Meta webhooks for three products:

| Product | Callback path | `object` | Where you register it |
| --- | --- | --- | --- |
| Facebook Page (feed + Messenger) | `/webhooks/pages` | `page` | App Dashboard > Webhooks > Page |
| WhatsApp Business Account | `/webhooks/whatsapp` | `whatsapp_business_account` | App Dashboard > WhatsApp > Configuration |
| Instagram professional account | `/webhooks/instagram` | `instagram` | App Dashboard > Webhooks > Instagram |

Both parts of the Meta webhook contract are implemented:

1. **Verification handshake** — `GET /webhooks/<product>` echoes `hub.challenge` as plain text when `hub.mode=subscribe` and `hub.verify_token` matches the configured token.
2. **Event notifications** — `POST /webhooks/<product>` validates `X-Hub-Signature-256` (HMAC-SHA256 over the exact raw body with `META_APP_SECRET`), acknowledges with `200` immediately, then normalizes the payload into typed events.

## Contents

- [Quick start](#quick-start)
- [Endpoints](#endpoints)
- [Configuration](#configuration)
- [Setting up each product](#setting-up-each-product)
  - [1. Expose your server publicly](#1-expose-your-server-publicly)
  - [2. Facebook Page webhooks](#2-facebook-page-webhooks)
  - [3. WhatsApp Business Account webhooks](#3-whatsapp-business-account-webhooks)
  - [4. Instagram webhooks](#4-instagram-webhooks)
- [Registering the callback in the App Dashboard](#registering-the-callback-in-the-app-dashboard)
- [Subscribing the asset to your app](#subscribing-the-asset-to-your-app)
- [Local testing](#local-testing)
- [Where to add your own logic](#where-to-add-your-own-logic)
- [Deploying to Render](#deploying-to-render)
- [Live dashboard and real-time alerts](#live-dashboard-and-real-time-alerts)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)

## Quick start

```powershell
npm install
Copy-Item .env.example .env      # then edit .env
npm start
```

`npm start` loads `.env` through Node's built-in `--env-file-if-exists`, so no dotenv package is needed. Node 20.6+ is required (Node 22+ recommended).

Then open the root index to see exactly which URLs are ready and which settings are still missing:

```powershell
Invoke-RestMethod http://localhost:3000/ | ConvertTo-Json -Depth 5
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Index: callback paths/URLs, object names, dashboard locations, config warnings |
| `GET` | `/dashboard` | Live real-time feed (page) |
| `GET` | `/dashboard/stream` | Server-Sent Events stream for the dashboard |
| `GET` | `/dashboard/recent?limit=50` | Recent dashboard entries (newest last) |
| `GET` | `/health` | Liveness probe plus the number of cached dedupe entries |
| `GET` | `/webhooks/pages` \| `/webhooks/whatsapp` \| `/webhooks/instagram` | Meta verification handshake |
| `POST` | `/webhooks/pages` \| `/webhooks/whatsapp` \| `/webhooks/instagram` | Event notifications |

Unknown products return `404`, wrong verify tokens return `403`, and bad signatures return `401`.

### Response codes for `POST`

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{"received":true,"events":N}` | Delivery accepted, `N` normalized events dispatched |
| `200` | `{"received":true,"duplicate":true}` | Same payload already handled (Meta retry) |
| `200` | `{"received":true,"error":true}` | Payload carried a Meta `error` object; logged, not retried |
| `400` | `{"error":"invalid_json"}` / `{"error":"invalid_payload"}` | Body was not valid JSON or not a JSON object |
| `401` | `{"error":"invalid_signature"}` | Signature did not match |
| `401` | `{"error":"app_secret_not_configured"}` | No `META_APP_SECRET` and unsigned webhooks are not allowed |
| `413` | `{"error":"payload_too_large"}` | Body exceeded 3 MB |

## Configuration

All settings come from environment variables. See `.env.example` for inline documentation.

### Core

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `PUBLIC_BASE_URL` | *(empty)* | Your tunnel/domain; used to print full callback URLs |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `LOG_JSON` | `false` | Newline-delimited JSON logs |
| `LOG_WEBHOOK_PAYLOADS` | `false` | Log full raw payloads (debugging only) |
| `INCLUDE_MESSAGE_CONTENT` | `false` | Include message text, usernames in normalized events |

### Live dashboard

| Variable | Default | Notes |
| --- | --- | --- |
| `DASHBOARD_TOKEN` | *(empty)* | Token gate for `/dashboard*`. Open `/dashboard?token=…` when set; empty = public (local dev only) |
| `DASHBOARD_RECENT_LIMIT` | `200` | How many recent entries the dashboard keeps in memory |

### Meta credentials

| Variable | Notes |
| --- | --- |
| `META_APP_SECRET` | App Dashboard > App settings > Basic > App secret. **Required** for signature verification |
| `META_APP_ID` | App Dashboard > App settings > Basic > App ID |
| `GRAPH_API_VERSION` | Defaults to `v26.0`; used by the subscribe script |
| `ALLOW_UNSIGNED_WEBHOOKS` | `false`. Set `true` **only** for local testing; the server logs a loud warning |
| `WEBHOOK_DEDUPE_TTL_MS` | `600000` (10 min). Window for collapsing duplicate deliveries |

### Verify tokens

| Variable | Notes |
| --- | --- |
| `WEBHOOK_VERIFY_TOKEN` | Shared fallback. Any string you choose |
| `PAGES_VERIFY_TOKEN` | Optional override for `/webhooks/pages` |
| `WHATSAPP_VERIFY_TOKEN` | Optional override for `/webhooks/whatsapp` |
| `INSTAGRAM_VERIFY_TOKEN` | Optional override for `/webhooks/instagram` |

The token you paste into the App Dashboard must match the value the server expects for that path.

### Subscription settings (used by `scripts/subscribe.js`)

| Variable | Notes |
| --- | --- |
| `PAGE_ID`, `PAGE_ACCESS_TOKEN`, `PAGES_SUBSCRIBED_FIELDS` | Page asset + token; fields default to `feed,messages` |
| `WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_SYSTEM_USER_TOKEN`, `WHATSAPP_SUBSCRIBED_FIELDS` | WhatsApp asset + system user token; fields default to `messages` |
| `INSTAGRAM_LOGIN_MODE`, `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_SUBSCRIBED_FIELDS` | Instagram asset + token; fields default to `comments,mentions,messages` |

`INSTAGRAM_LOGIN_MODE` is either `instagram` (Business Login for Instagram, `graph.instagram.com`) or `facebook` (Instagram via Facebook Login, `graph.facebook.com`).

## Setting up each product

### 1. Expose your server publicly

Meta must reach your server over HTTPS. For local development:

```powershell
ngrok http 3000
```

Put the HTTPS origin into `.env` and restart:

```
PUBLIC_BASE_URL=https://your-subdomain.ngrok-free.app
```

The startup banner now prints the exact callback URL for each product.

### 2. Facebook Page webhooks

1. Add the **Webhooks** product to your app in the App Dashboard.
2. Generate a **Page access token** for a person with the `CREATE_CONTENT`, `MANAGE` or `MODERATE` task on that Page (Graph API Explorer > select your app > request `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list` > then exchange for a Page token).
3. Set `PAGE_ID`, `PAGE_ACCESS_TOKEN` and `META_APP_ID` in `.env`.
4. Restart the server, then subscribe the Page (see [Subscribing the asset to your app](#subscribing-the-asset-to-your-app)).
5. In the App Dashboard > Webhooks > **Page**, set:
   - Callback URL: `https://<your-host>/webhooks/pages`
   - Verify token: the value of `PAGES_VERIFY_TOKEN` (or `WEBHOOK_VERIFY_TOKEN`)
   - Subscription fields: `feed`, `messages`

   Click **Verify and save** — your server must be running at that moment.

`feed` events deliver comments and posts; `messages` events deliver Messenger conversations. Note that Instagram Messaging routed through a linked Page arrives on the **Page** `messages` field.

### 3. WhatsApp Business Account webhooks

1. Create a WhatsApp Business Account and add a phone number in the App Dashboard > **WhatsApp > API Setup**.
2. Create a **system user** in Business Settings and grant it `whatsapp_business_messaging` and `whatsapp_business_management`; generate a permanent token.
3. Set `WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_SYSTEM_USER_TOKEN` in `.env`.
4. In the App Dashboard > **WhatsApp > Configuration**, set:
   - Callback URL: `https://<your-host>/webhooks/whatsapp`
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN` (or `WEBHOOK_VERIFY_TOKEN`)
5. Manage the subscribed fields (default `messages`) in the same page. `messages` covers both inbound messages and outbound `statuses` (`sent`/`delivered`/`read`/`failed`).

The WABA is subscribed to your app automatically when you add a phone number through the dashboard; use `npm run subscribe:whatsapp` to subscribe explicitly or to inspect which apps are installed.

### 4. Instagram webhooks

Instagram has two onboarding paths — pick the one matching how your token was created:

**A. Business Login for Instagram (`INSTAGRAM_LOGIN_MODE=instagram`)**

1. Enable **Instagram** in your app and connect the professional account.
2. Generate a long-lived Instagram user token with `instagram_business_basic`, `instagram_business_manage_messages` and `instagram_business_manage_comments`.
3. Set `INSTAGRAM_LOGIN_MODE=instagram`, `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`.
4. In **App Dashboard > Webhooks > Instagram**, set the callback URL to `https://<your-host>/webhooks/instagram` with your verify token, then subscribe the fields `comments`, `mentions`, `messages`.

**B. Facebook Login for Business (`INSTAGRAM_LOGIN_MODE=facebook`)**

1. Link the Instagram professional account to a Facebook Page, then add **Instagram** to your app.
2. Request `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments` plus `pages_show_list` and `pages_read_engagement`, and use a Page/User token.
3. Set `INSTAGRAM_LOGIN_MODE=facebook`, `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`.
4. Subscribe via `npm run subscribe:instagram` (this path uses `graph.facebook.com`), then subscribe the desired fields.

In both paths the Instagram professional account itself must be subscribed to your app, otherwise no `comments`, `mentions` or `messages` events are delivered.

## Registering the callback in the App Dashboard

For each product, paste the callback URL for that path and the matching verify token. When you click **Verify and save**, Meta sends:

```
GET /webhooks/<product>?hub.mode=subscribe&hub.challenge=<random>&hub.verify_token=<your token>
```

Your server replies with the challenge as `text/plain`. A successful verification only proves that Meta can reach the endpoint — it does **not** mean events will arrive. That requires the asset subscription described next.

## Subscribing the asset to your app

This step is the most common reason "verified but no events arrive". The Page, WhatsApp Business Account and Instagram professional account must each install/subscribe your app.

```powershell
npm run subscriptions:list              # show configured assets and fields
npm run subscribe:pages                 # POST /<PAGE_ID>/subscribed_apps
npm run subscribe:whatsapp              # POST /<WABA_ID>/subscribed_apps
npm run subscribe:instagram             # POST /<INSTAGRAM_USER_ID>/subscribed_apps
```

Direct usage also supports inspection and teardown:

```powershell
node scripts/subscribe.js pages list        # which apps are subscribed?
node scripts/subscribe.js instagram list
node scripts/subscribe.js pages unsubscribe  # DELETE /<PAGE_ID>/subscribed_apps
```

The script selects the correct Graph host (`graph.instagram.com` for `INSTAGRAM_LOGIN_MODE=instagram`, `graph.facebook.com` otherwise) and the correct token style (bearer for WhatsApp and Instagram Login, query parameter for Page and Facebook Login).

## Local testing

Send signed sample payloads for all three products without waiting for real traffic:

```powershell
npm start                       # terminal 1
npm run test:event              # terminal 2 - all three products
npm run test:event whatsapp     # or a single product
```

The script signs each request with `META_APP_SECRET` and prints the status plus the server's response. It exits non-zero if any delivery fails.

You can also simulate the handshake by hand:

```powershell
$token = 'change-me-shared-verify-token'
curl.exe -s "http://localhost:3000/webhooks/pages?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=$token"
```

The server should print `12345` and return HTTP 200. Use `curl.exe` rather than `Invoke-RestMethod` here: Windows PowerShell 5.1's web cmdlets have a URI-parsing quirk that turns this dotted `hub.*` query string into a 404, while Meta, `curl`, browsers, and Node's `fetch` all reach the route correctly.

Run the test suite (signature verification, deduplication, payload normalization, the handshake, the event bus, the dashboard routes and the full HTTP surface):

```powershell
npm test
```

For an end-to-end check that boots the real server and exercises the whole surface (handshake, signed delivery, duplicate retry, SSE stream and history), run:

```powershell
npm run smoke
```

## Deploying to Render

The repo ships with `render.yaml`, so Render can provision the service in one click. The server already honors Render's injected `PORT` and binds `0.0.0.0`, and `GET /health` is registered as the health check path.

### One-click deploy (Blueprint)

1. Push the project to GitHub (commit `render.yaml`, `package.json`, `package-lock.json` and `src/`).
2. In Render: **New** > **Blueprint** > select the repo. Render reads `render.yaml` and creates the `meta-webhooks-server` web service with `npm install` / `npm start`.
3. After the first deploy, copy the service URL (e.g. `https://meta-webhooks-server.onrender.com`):
   - Set `PUBLIC_BASE_URL` to that URL in Render > your service > **Environment**, then **Manual Deploy** so the startup banner prints the exact Meta callback URLs.
   - Note the auto-generated `WEBHOOK_VERIFY_TOKEN` and `DASHBOARD_TOKEN` values on the same page (or replace them with your own).
4. Paste the callback URLs + verify token into the Meta App Dashboard and **Verify and save** for each product (see [Registering the callback](#registering-the-callback-in-the-app-dashboard)).
5. Run the subscriptions from your own machine against the live Graph API (the subscribe script runs locally; it does not need to run on Render):

```powershell
$env:PUBLIC_BASE_URL = 'https://meta-webhooks-server.onrender.com'
npm run subscriptions:list
npm run subscribe:pages
npm run subscribe:whatsapp
npm run subscribe:instagram
```

### Free-plan notes

- The free tier sleeps after inactivity; the first request after sleep takes ~30–60 s. Meta's handshake tolerates this, but for production use Render's Starter plan (no sleeping).
- Keep the service to **one instance** (the default): the dashboard feed is in-memory, so a single instance guarantees every browser tab sees the same events.
- Logs in Render > your service > **Logs** are ephemeral (they rotate). The dashboard's in-memory window (`DASHBOARD_RECENT_LIMIT`, default 200) is likewise short-term — treat both as operational views, not archives.
- Set `LOG_JSON=true` (already the default in `render.yaml`) so Render log lines stay structured and searchable.

## Live dashboard and real-time alerts

Open `https://<your-service>.onrender.com/dashboard` (append `?token=<DASHBOARD_TOKEN>` when the token is set) to watch every verified delivery arrive within a second, newest first, with per-product color coding and counts. `GET /dashboard/recent?limit=50` returns the same trailing window as JSON, and `GET /dashboard/stream` is the Server-Sent Events stream the page consumes (auto-reconnecting, with a 25 s heartbeat so Render's proxy never drops it as idle).

Two log surfaces, two jobs:

| Surface | What it shows | Where |
| --- | --- | --- |
| **Live dashboard** (`/dashboard`) | Normalized webhook cards (message/comment IDs, senders, statuses) plus server log lines, in real time | Browser — keep the tab open |
| **Render Logs** (service > **Logs**) | The full raw server output (`Webhook received`, `Webhook events handled`, handshake lines, warnings) | Render dashboard, plus `render logs` CLI |

For real-time notification while the dashboard tab is open, click **Enable alerts**: the page plays a short beep and fires a desktop `Notification` for each incoming webhook (the browser asks for permission first; the tab title also shows the unread count). Keep the tab open — browsers cannot push notifications from a closed page without a separate push service.

## Where to add your own logic

Nothing is persisted and nothing is sent back to Meta. The default handler only logs identifiers, statuses and counts — message bodies are excluded unless `INCLUDE_MESSAGE_CONTENT=true`.

To store events, auto-reply or trigger automations, pass your own `onEvents` callback when building the app:

```js
const { createApp } = require('./src/app');

const { app } = createApp({
  // events: normalized array, context: { product, payload, deliveryHash }
  onEvents: async (events, context) => {
    for (const event of events) {
      if (context.product === 'whatsapp' && event.kind === 'message') {
        // await replyOnWhatsApp(event.senderId, 'Thanks for your message!');
      }
    }
  },
});

app.listen(3000);
```

Because the HTTP response is sent before `onEvents` runs, keep long work inside the callback (the request has already been acknowledged) and make it idempotent — use `context.deliveryHash` or the event IDs to guard against repeats.

The normalized event shapes are defined in `src/webhooks/normalize.js`:

```jsonc
// pages change (feed)
{ "kind": "change", "field": "feed", "item": "comment", "verb": "add",
  "commentId": "…", "postId": "…", "senderId": "…", "entryId": "PAGE_ID" }

// pages messaging (Messenger)
{ "kind": "messaging", "messageId": "m_…", "senderId": "…",
  "recipientId": "…", "attachmentTypes": ["image"] }

// whatsapp inbound message
{ "kind": "message", "messageId": "wamid.…", "senderId": "16505551234",
  "messageType": "text", "phoneNumberId": "…", "wabaId": "…" }

// whatsapp delivery status
{ "kind": "status", "status": "delivered", "messageId": "wamid.…",
  "recipientId": "…", "conversationId": "…", "pricingCategory": "service" }

// instagram comment / mention
{ "kind": "comment", "commentId": "…", "mediaId": "…", "senderId": "…" }
{ "kind": "mention", "mediaId": "…", "commentId": "…" }
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "The URL couldn't be validated" in the dashboard | Server not reachable at that moment, `hub.mode` not `subscribe`, or `hub.verify_token` mismatch. Check `LOG_LEVEL=debug` output; a mismatch logs *Verification rejected: token mismatch* |
| Render deploy shows "No open ports detected" | The app must bind `process.env.PORT` on `0.0.0.0`. Already handled (`HOST=0.0.0.0`, `PORT` from env); make sure you did not hard-code `PORT=3000` in Render's environment |
| `/dashboard` shows 401 on Render | `DASHBOARD_TOKEN` is set — open `/dashboard?token=<value from Render > Environment>`. Regenerating the value requires updating your bookmark |
| Dashboard connects but shows no events | Deliveries only appear after the Meta handshake *and* the asset subscription. Re-run `npm run subscribe:<product>` and check Render Logs for `Webhook received` lines |
| `403 verify_token_not_configured` | Neither `*_VERIFY_TOKEN` nor `WEBHOOK_VERIFY_TOKEN` is set; set one and restart |
| Dashboard shows **Verified**, but no events arrive | The asset is not subscribed. Run `npm run subscribe:pages` / `:whatsapp` / `:instagram`, then `node scripts/subscribe.js <product> list` to confirm |
| `401 invalid_signature` | `META_APP_SECRET` does not belong to the app making the request, or a proxy rewrote the body. Signature is computed over the raw bytes |
| `401 app_secret_not_configured` | Set `META_APP_SECRET` (or, for local testing only, `ALLOW_UNSIGNED_WEBHOOKS=true`) |
| Events logged twice | Meta retries. Duplicates within `WEBHOOK_DEDUPE_TTL_MS` are answered with `{"duplicate":true}` and skipped |
| `413 payload_too_large` | Payload exceeded 3 MB |
| Port already in use | Change `PORT` in `.env` or stop the process holding port 3000 |
| No message text in logs | By design. Set `INCLUDE_MESSAGE_CONTENT=true` to see bodies, `LOG_WEBHOOK_PAYLOADS=true` for raw payloads |

## Project layout

```
src/
  app.js                 Express app, /, /health, wiring
  server.js              Entry point: startup banner, graceful shutdown
  config.js              Env parsing, verify tokens, callback URLs, warnings
  products.js            Product registry (path, object name, dashboard location)
  lib/
    signature.js         HMAC-SHA256/SHA1 compute + constant-time verify
    dedupe.js            TTL + capacity-bounded duplicate suppression
    eventBus.js          In-memory fan-out for the live dashboard (SSE + history)
    live.js              Bridges logger + webhook pipeline into the event bus
    json.js              isObject helper
    logger.js            Leveled logger, optional JSON output
  dashboard/
    routes.js            /dashboard page, /dashboard/stream (SSE), /dashboard/recent
    index.html           Live feed UI: filters, counts, desktop-notification alerts
  webhooks/
    router.js            GET handshake + POST event routes, error handling
    normalize.js         Meta payload -> typed events
    handlers.js          Default logging-only onEvents implementation
scripts/
  subscribe.js           Subscribes Page/WABA/Instagram to the app via Graph API
  send-test-event.js     Sends signed sample payloads to a local server
  smoke-dashboard.js     Boots the real server and checks handshake, delivery, SSE + history
test/                    node:test suites (config, dedupe, normalize, signature, webhooks, eventBus, dashboard)
```