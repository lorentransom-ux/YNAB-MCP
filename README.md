# YNAB MCP Server

A TypeScript MCP (Model Context Protocol) server that connects to the YNAB API for personal budget reporting — designed to be hosted on Railway, connected to Claude.ai as a custom connector, and optionally configured to send scheduled budget summaries and answer budget questions over Telegram.

## Features

12 read-only budget tools, all accessible via Claude chat.

**Budget tools:**

| Tool | Description |
|------|-------------|
| `ynab_get_plans` | List all budgets with IDs and names |
| `ynab_get_accounts` | All accounts with balances and types |
| `ynab_get_categories` | Category groups and categories with goal info |
| `ynab_get_months` | All budget months with income/budgeted/activity totals |
| `ynab_get_month_detail` | Full category breakdown for a specific month |
| `ynab_get_transactions` | All transactions with optional date filters |
| `ynab_get_transactions_by_account` | Transactions for a specific account |
| `ynab_get_transactions_by_category` | Transactions for a specific category |
| `ynab_get_transactions_by_payee` | Transactions for a specific payee |
| `ynab_get_payees` | All payees with IDs (for use with filtered queries) |
| `ynab_get_scheduled_transactions` | Upcoming and recurring scheduled transactions |
| `ynab_get_money_movements` | Account-to-account transfers |

Plus an optional **Telegram** integration: each person gets a scheduled budget digest on their own schedule and category list, can ask plain-English budget questions any time, and can adjust their own digest settings just by chatting — no phone number, carrier registration, or 10DLC required.

---

## Setup and Deployment

### Step 1 — Generate a YNAB Personal Access Token

1. Log in to YNAB and go to **app.ynab.com/settings/developer**
2. Click **New Token** under Personal Access Tokens
3. Copy the token — you won't see it again

### Step 2 — Deploy to Railway

1. Go to **railway.app** → **New Project** → **Deploy from GitHub repo** → select this repo
2. The `main` branch will be selected by default — leave it as is
3. Open your service → **Variables** tab and add:
   - `YNAB_TOKEN` — your YNAB personal access token from Step 1
   - `SERVER_URL` — your Railway public URL (e.g. `https://your-app.railway.app`). You may need to generate the domain first (Settings → Generate Domain), then come back and add this variable.
4. Railway builds and deploys automatically using `railway.toml`

### Step 3 — Connect to Claude.ai

1. Open Claude.ai → **Settings → Connectors → Add custom connector**
2. Enter your Railway URL with the `/mcp` path:
   ```
   https://your-app.railway.app/mcp
   ```
3. Leave the **OAuth Client ID** and **OAuth Client Secret** fields empty — the server handles registration automatically
4. Click **Add**

Claude.ai will open a page on your Railway server asking **"Authorize YNAB access?"** — click **Approve**. This happens once. After that, Claude.ai holds a token and reconnects silently.

> **Note:** If the server restarts (e.g. after a Railway redeploy), Claude.ai will prompt you to approve again. This is normal — tokens are held in memory.

---

## Telegram — Digests & Budget Chat (Optional)

The server can, over a Telegram bot:

- **Send a scheduled digest** of each person's chosen YNAB category balances, on a schedule they control.
- **Answer plain-English budget questions** any time the user messages the bot.

No phone number, no carrier registration, no 10DLC — a Telegram bot is free and works anywhere. Both features reuse the same YNAB-fetch + Claude logic (`src/assistant.ts`).

**Example digest:**
```
YNAB – May 2026 (Loren)
Groceries: $156.23 left
Dining Out: -$45.00 left
Entertainment: $80.00 left
```

**Example chat:**
```
You: How much is left in groceries?
YNAB: Groceries: $87.43 left this month.

You: How much did we spend eating out this week?
YNAB: Dining Out activity last 14 days: $124.50 across 6 transactions.

You: Are we over budget anywhere?
YNAB: Yes — Clothing is -$23.10 and Entertainment is -$8.00.
```

Chat replies are kept under ~1000 characters and may use light Markdown. Each message is a fresh query — no conversation history is retained between messages.

### Adjusting your digest by chat

Each person can change **their own** digest just by messaging the bot — no dashboard or env-var edit needed. Behind the scenes the assistant has a `ynab_update_config` tool, scoped to the chatting user (it can't touch anyone else's settings).

```
You: Add Rent and Utilities to my weekly summary
YNAB: Done — your digest now shows Groceries, Clothing, Rent, Utilities.

You: Send it Fridays at 8am instead
YNAB: Updated — your digest now sends at 8:00am on Fridays.

You: Show budgeted amounts instead of what's left
YNAB: Updated — your digest now shows the budgeted amount per category.
```

Adjustable by chat: which **categories** appear (add/remove), the **schedule** (cron) and **timezone**, the **amount shown** (remaining balance / budgeted / activity), **goal-progress** display, and a custom **header note**. Schedule and timezone changes take effect immediately. Changes are saved to `data/config.json`.

### Setup

1. **Create a bot:** message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the token it gives you.
2. Add `ANTHROPIC_API_KEY` (from console.anthropic.com) and `TELEGRAM_BOT_TOKEN` to your Railway service's **Variables** tab. Optionally set `TELEGRAM_WEBHOOK_SECRET` to any random string for webhook verification.
3. **Deploy.** On startup the server automatically registers its webhook with Telegram, pointing at `https://your-app.railway.app/telegram` (it uses your `SERVER_URL`, which must be HTTPS).
4. **Find each chat ID:** have the user send any message to the bot. The server logs `[Telegram Chat] Ignored message from unrecognized chat: <id>` — that `<id>` is their numeric chat ID.
5. Add that ID to the user via `USER1_TELEGRAM_ID` / `USER2_TELEGRAM_ID` (env var) or by editing `telegramChatId` in `data/config.json`. Redeploy/restart if you used the env var.
6. The user messages the bot again and gets budget answers, and their scheduled digest now delivers to that chat.

Only chat IDs listed in a user's `telegramChatId` will receive replies or digests — messages from other chats are logged and ignored.

### Environment Variables

Add these to your Railway service's **Variables** tab:

```
# Telegram credentials
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token-from-botfather
# Optional but recommended — an arbitrary string you invent; verifies inbound webhooks
TELEGRAM_WEBHOOK_SECRET=some-long-random-string

# Claude (required for budget chat)
ANTHROPIC_API_KEY=your_anthropic_key_here

# User 1
USER1_NAME=Loren
USER1_SCHEDULE=0 8 * * 1
USER1_CATEGORIES=Groceries,Dining Out,Entertainment
USER1_TIMEZONE=America/Chicago
USER1_TELEGRAM_ID=123456789

# User 2
USER2_NAME=Wife
USER2_SCHEDULE=0 9 * * 5
USER2_CATEGORIES=Groceries,Clothing,Personal Care
USER2_TIMEZONE=America/Chicago
USER2_TELEGRAM_ID=987654321

# Optional: pin to a specific YNAB budget ID (defaults to your last-used budget)
# YNAB_BUDGET_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

All Telegram variables are optional. If `TELEGRAM_BOT_TOKEN` is absent the scheduler starts up silently and does nothing, and the chat endpoint is disabled. USER1 and USER2 are independent — you can configure just one. A user's `USERx_TELEGRAM_ID` can be added after the fact (see step 4 above); until it's set, that user won't receive a digest.

### Cron Schedule Format

`USER_SCHEDULE` uses standard 5-field cron syntax: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|------------|---------|
| `0 8 * * 1` | Every Monday at 8:00am |
| `0 17 * * 5` | Every Friday at 5:00pm |
| `0 9 * * *` | Every day at 9:00am |
| `0 8 1 * *` | First day of every month at 8:00am |

Times are interpreted in the user's `TIMEZONE`. Use any [IANA timezone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) (e.g. `America/New_York`, `America/Denver`, `America/Los_Angeles`).

### Category Names

`USER_CATEGORIES` is a comma-separated list of YNAB category names, spelled exactly as they appear in your budget (case-insensitive). Each user gets their own list — the balance shown is the remaining balance for the current month.

### Security notes

- The bot token is used **outbound only** (your server → Telegram) and is never logged.
- When `TELEGRAM_WEBHOOK_SECRET` is set, Telegram echoes it back in the `X-Telegram-Bot-Api-Secret-Token` header on every webhook, and the `/telegram` endpoint rejects any request whose header doesn't match — this stops anyone from spoofing a webhook to a known chat ID.

### Local testing with ngrok

```bash
ngrok http 3000
# Set SERVER_URL to the https ngrok URL and restart so setWebhook points at it,
# or call setWebhook manually:
#   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<ngrok>.ngrok.io/telegram"
# Then message your bot and watch the logs.
```

### Config persistence — Railway Volume

User config is seeded from your `USERx_*` env vars and saved to `data/config.json`. On Railway, this file lives on the service's ephemeral filesystem and **resets on redeploy** unless you attach a persistent volume:

1. Railway dashboard → your service → **Volumes** tab → **Add Volume**
2. Mount path: `/data`
3. Add env var: `CONFIG_PATH=/data/config.json`

Without a volume, the config file is recreated from your `USER1_*`/`USER2_*` env vars on each restart, so changes made by chatting with the bot are lost on every redeploy — attach a volume if you want those to persist.

### How env vars and chat edits interact

The `USERx_*` env vars **seed the config once**, when `config.json` doesn't yet exist. After the file exists (e.g. on a persistent volume), startup does **not** re-read most of them — so editing `USER2_CATEGORIES`, `USER2_SCHEDULE`, etc. and redeploying has **no effect**. This is intentional: it preserves changes each user makes by chatting with the bot.

So, once seeded:

- **Categories, schedule, timezone, and format** are managed **by chat** ("add Rent to my summary", "send it Fridays at 8am") — instant, no redeploy. The config file is the source of truth.
- **`USERx_TELEGRAM_ID`** is the exception — it's reconciled from env on every startup, so you can add/change a chat ID via env var + redeploy at any time.

To force a full reseed from env (discarding chat edits), point `CONFIG_PATH` at a fresh filename or detach the volume. Keeping the env vars roughly in sync with the live config is still worthwhile as a recovery baseline for that case.

---

## Local Development

```bash
npm install
```

Create a `.env` file in the project root (it's gitignored):

```
# Required
YNAB_TOKEN=your_ynab_token_here
SERVER_URL=http://localhost:3000

# Optional — Telegram integration (omit to disable)
ANTHROPIC_API_KEY=your_anthropic_key_here
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_WEBHOOK_SECRET=some-long-random-string

USER1_NAME=Loren
USER1_SCHEDULE=*/2 * * * *
USER1_CATEGORIES=Groceries,Dining Out
USER1_TIMEZONE=America/Chicago
USER1_TELEGRAM_ID=123456789

USER2_NAME=Wife
USER2_SCHEDULE=0 9 * * 5
USER2_CATEGORIES=Groceries,Clothing
USER2_TIMEZONE=America/Chicago
USER2_TELEGRAM_ID=987654321
```

> **Tip:** For local testing, set `USER1_SCHEDULE=*/2 * * * *` to fire every 2 minutes so you can verify a digest arrives quickly, then change it to your real schedule before deploying.

Then run:

```bash
npm run dev
```

The server starts on port 3000. Check it's running at `http://localhost:3000/health`. Registered cron jobs are logged at startup — look for lines starting with `[Scheduler]`.

---

## Architecture

- **Transport**: Streamable HTTP (MCP spec) with stateful sessions
- **Auth**: OAuth 2.0 with dynamic client registration and PKCE. Claude.ai registers itself automatically; you approve access once in your browser.
- **Amounts**: All monetary values returned in dollars (milliunits ÷ 1000), never raw integers
- **Default budget**: All tools default to `last-used` so you don't need to specify a plan ID
- **Scheduler**: Optional background worker (`node-cron`) that fires on configured cron schedules, fetches YNAB category balances, and sends digests via Telegram. Initializes at server startup; silently no-ops if `TELEGRAM_BOT_TOKEN` is absent.

---

## Security

- Your YNAB Personal Access Token is only read from the environment — never committed to code
- The Telegram bot token is environment-only and used outbound only — never in code or logs
- All tools are read-only; no write operations are exposed
- Access requires explicit approval in your browser — unapproved requests are rejected
- PKCE prevents authorization codes from being stolen or replayed
- Sessions are isolated per Claude connection
