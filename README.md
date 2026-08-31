# YNAB MCP Server

A TypeScript MCP (Model Context Protocol) server that connects to the YNAB API for personal budget reporting — designed to be hosted on Railway, connected to Claude.ai as a custom connector, and optionally configured to send scheduled budget summaries and answer budget questions over Telegram.

## Features

26 budget tools — 12 read, 14 write — all accessible via Claude chat.

**Read tools:**

| Tool | Description |
|------|-------------|
| `ynab_get_plans` | List all budgets with IDs and names |
| `ynab_get_accounts` | All accounts with balances, types, and `transfer_payee_id` (needed for transfers) |
| `ynab_get_categories` | Category groups and categories with goal info |
| `ynab_get_months` | All budget months with income/budgeted/activity totals |
| `ynab_get_month_detail` | Full category breakdown for a specific month |
| `ynab_get_transactions` | All transactions with optional date filters; includes `flag_color`, `flag_name`, and `subtransactions` on splits |
| `ynab_get_transactions_by_account` | Transactions for a specific account (includes flags) |
| `ynab_get_transactions_by_category` | Transactions for a specific category (includes flags) |
| `ynab_get_transactions_by_payee` | Transactions for a specific payee (includes flags) |
| `ynab_get_payees` | All payees with IDs (for use with filtered queries) |
| `ynab_get_scheduled_transactions` | Upcoming and recurring scheduled transactions |
| `ynab_get_money_movements` | Account-to-account transfers (includes flags) |

**Write tools:**

| Tool | Description |
|------|-------------|
| `ynab_create_transaction` | Add a transaction, a linked transfer via `transfer_payee_id`, or a multi-category split via `subtransactions` |
| `ynab_update_transaction` | Edit, recategorize, approve, or clear a transaction (cannot add splits to an existing one) |
| `ynab_delete_transaction` | Delete a transaction |
| `ynab_import_transactions` | Trigger import from linked bank accounts |
| `ynab_set_category_budget` | Set a category's assigned amount for a month (money moves) |
| `ynab_update_category` | Rename a category, edit its note/group, or set/remove goal target fields |
| `ynab_create_scheduled_transaction` | Add a recurring or future-dated transaction, including splits |
| `ynab_update_scheduled_transaction` | Edit a scheduled transaction |
| `ynab_delete_scheduled_transaction` | Delete a scheduled transaction |
| `ynab_rename_payee` | Rename a payee |
| `ynab_create_account` | Create an unlinked (manually tracked) account |
| `ynab_create_category` | Create a category in a group; optionally set goal target/date/frequency |
| `ynab_create_category_group` | Create a category group (name, max 50 characters) |
| `ynab_update_category_group` | Rename a category group |

Write tools take amounts in dollars (negative = outflow) and convert to YNAB milliunits internally. Categories and category groups can be created, and goal targets can be set or updated (`goal_target`, `goal_target_date`, `goal_needs_whole_amount`, `goal_frequency`). The YNAB API still cannot create or delete a plan (budget) and still cannot delete accounts, so those remain app-only. It also cannot add or edit splits on an *existing* (already imported) transaction — those still have to be split in the YNAB app.

### Split transactions (multiple categories)

To create a new split (for example a Rouse's trip that is part groceries, part household supplies):

1. Look up category IDs with `ynab_get_categories`.
2. Call `ynab_create_transaction` with the total `amount`, **omit** `category_id`, and pass `subtransactions`: at least two lines, each with `amount` (same sign as the parent) and `category_id`. Line amounts must add up to `amount`. Optional per-line `memo`.

Example: a $47.20 outflow, $32.10 groceries and $15.10 supplies — `amount: -47.20` and two lines `-32.10` / `-15.10`.

Reads (`ynab_get_transactions` and the filtered variants) return a `subtransactions` array on split transactions. `ynab_create_scheduled_transaction` accepts the same `subtransactions` shape.

The public API will not convert an already-imported bank transaction into a split. For those, split in the YNAB app (or delete and recreate, which drops the bank match).

### Account-to-account transfers

YNAB records a transfer as a transaction whose payee is the destination account's transfer payee (not a new payee you create).

1. Call `ynab_get_accounts` and take the **source** account `id` plus the **destination** account `transfer_payee_id`.
2. Call `ynab_create_transaction` with `account_id` = source, `amount` as a negative outflow in dollars, `payee_id` = destination `transfer_payee_id`, and **omit** `category_id`.

A `payee_name` like `Transfer : Checking` is resolved to that existing transfer payee. Do not invent a duplicate non-transfer payee with that name.

### Transaction flags

List/get responses (`ynab_get_transactions`, by account/payee/category, and `ynab_get_money_movements`) include `flag_color` (`red` / `orange` / `yellow` / `green` / `blue` / `purple`) and `flag_name` (the custom name on that flag, if any). `ynab_create_transaction` and `ynab_update_transaction` can set `flag_color`; a later get returns both fields. Merchant order-history URLs are not in the YNAB REST API and are not exposed here.

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

Adjustable by chat: which **categories** appear (add/remove), the **schedule** (cron) and **timezone**, the **amount shown** (remaining balance / budgeted / activity), **goal-progress** display, and a custom **header note**. Schedule and timezone changes take effect immediately. Changes are saved to Postgres.

### Proactive balance alerts

Beyond the scheduled digest, each person can set **threshold alerts** — get a Telegram message when a category's remaining balance crosses a limit. Set them by chat (the `ynab_manage_alerts` tool, scoped to the chatting user):

```
You: Notify me when Coffee Shops gets to $15 or below
YNAB: Set alert — Alert when Coffee Shops is at or below $15.00.

You: List my alerts
YNAB: Current alerts: Coffee Shops ≤ $15.00.

You: Remove the Coffee Shops alert
YNAB: Removed alert for Coffee Shops.
```

Balances are checked every two hours, every day (in your timezone). You get **one** message per crossing — an alert re-arms only after the balance recovers back past the threshold. Alerts are saved to Postgres, so they survive redeploys.

> **Note on red negatives:** in the digest and chat answers, negative amounts render as `🔻 ($15.00)` — parentheses are the accounting convention for negative, and the 🔻 stands in for "red" because Telegram messages can't display colored text.

### Setup

1. **Create a bot:** message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the token it gives you.
2. Add `ANTHROPIC_API_KEY` (from console.anthropic.com) and `TELEGRAM_BOT_TOKEN` to your Railway service's **Variables** tab. Optionally set `TELEGRAM_WEBHOOK_SECRET` to any random string for webhook verification.
3. **Deploy.** On startup the server automatically registers its webhook with Telegram, pointing at `https://your-app.railway.app/telegram` (it uses your `SERVER_URL`, which must be HTTPS).
4. **Find each chat ID:** have the user send any message to the bot. The server logs `[Telegram Chat] Ignored message from unrecognized chat: <id>` — that `<id>` is their numeric chat ID.
5. Add that ID to the user via `USER1_TELEGRAM_ID` / `USER2_TELEGRAM_ID` (env var). Redeploy/restart so it's reconciled on startup.
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

### Config persistence — Postgres

User config (categories, schedule, timezone, format, Telegram chat ID, and balance alerts) is seeded from your `USERx_*` env vars and persisted to a **Postgres database**. The server keeps the config in a single-row `app_config` table (stored as a JSONB blob) and connects over the network, so config **survives redeploys** without any volume coordination.

On Railway:

1. Railway dashboard → your project → **New → Database → Add PostgreSQL**.
2. Open your app service → **Variables** → add a reference variable
   `DATABASE_URL = ${{Postgres.DATABASE_PRIVATE_URL}}`. Use the **private** URL
   (host `postgres.railway.internal`) — traffic stays on the internal network so
   there are no egress fees, and no SSL config is needed. Both services must be in
   the same project/environment.
3. Deploy. On first boot the app creates the `app_config` table automatically.

The server reads `process.env.DATABASE_URL`, so locally you can point it at any
Postgres instance (e.g. `postgres://postgres:pw@localhost:5432/postgres`). When
`DATABASE_URL` points at a non-private host (such as the public `*.rlwy.net`
proxy or any remote host), TLS is enabled automatically.

### How env vars and chat edits interact

The `USERx_*` env vars **seed the config once**, when the database has no config yet. After config exists in Postgres, startup does **not** re-read most of them — so editing `USER2_CATEGORIES`, `USER2_SCHEDULE`, etc. and redeploying has **no effect**. This is intentional: it preserves changes each user makes by chatting with the bot.

So, once seeded:

- **Categories, schedule, timezone, and format** are managed **by chat** ("add Rent to my summary", "send it Fridays at 8am") — instant, no redeploy. The database is the source of truth.
- **`USERx_TELEGRAM_ID`** is the exception — it's reconciled from env on every startup, so you can add/change a chat ID via env var + redeploy at any time.

To force a full reseed from env (discarding chat edits), clear the `app_config` table (e.g. `DELETE FROM app_config;`). Keeping the env vars roughly in sync with the live config is still worthwhile as a recovery baseline for that case.

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
- **Transfers**: Accounts include `transfer_payee_id`; create a linked transfer with that id as `payee_id` and no `category_id`
- **Splits**: Create with `subtransactions` (omit parent `category_id`); reads return split lines. Existing imports cannot be split via the API
- **Flags**: Transaction reads pass through `flag_color` and `flag_name`
- **Scheduler**: Optional background worker (`node-cron`) that fires on configured cron schedules, fetches YNAB category balances, and sends digests via Telegram. Initializes at server startup; silently no-ops if `TELEGRAM_BOT_TOKEN` is absent.

---

## Security

- Your YNAB Personal Access Token is only read from the environment — never committed to code
- The Telegram bot token is environment-only and used outbound only — never in code or logs
- Write tools mutate the household YNAB budget via the personal access token; they cannot create or delete a plan, or delete accounts
- Access requires explicit approval in your browser — unapproved requests are rejected
- PKCE prevents authorization codes from being stolen or replayed
- Sessions are isolated per Claude connection
