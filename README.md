# YNAB MCP Server

A TypeScript MCP (Model Context Protocol) server that connects to the YNAB API for personal budget reporting — designed to be hosted on Railway, connected to Claude.ai as a custom connector, and optionally configured to send scheduled budget summaries and answer budget questions over Telegram.

## Features

32 budget tools — 16 read, 16 write — all accessible via Claude chat.

**Read tools:**

| Tool | Description |
|------|-------------|
| `ynab_get_plans` | List all budgets with IDs and names |
| `ynab_get_accounts` | All accounts with balances, types, and `transfer_payee_id` (needed for transfers) |
| `ynab_get_categories` | Every category group and category with goal info. Large response (tens of thousands of characters on a full budget); use `ynab_get_category` for a single category |
| `ynab_get_category` | One category by loose name or ID — budgeted, activity, balance, goal info. Resolves day-range splits (e.g. `Eating Out 8th–15th`) to the one covering today; fails with candidates when the name is ambiguous |
| `ynab_get_months` | All budget months with income/budgeted/activity totals |
| `ynab_get_month_detail` | Full category breakdown for a specific month. Large response; use `ynab_get_category` with `month` for a single category |
| `ynab_get_transactions` | Transactions with optional `month`, `type` (`unapproved` / `uncategorized`), and date filters; includes `flag_color`, `flag_name`, and `subtransactions` on splits |
| `ynab_get_transaction` | One transaction by ID, with its account, payee, and category IDs |
| `ynab_get_transactions_by_account` | Transactions for a specific account (includes flags) |
| `ynab_get_transactions_by_category` | Transactions for a specific category (includes flags) |
| `ynab_get_transactions_by_payee` | Transactions for a specific payee (includes flags) |
| `ynab_get_category_groups` | Category group IDs and names, including empty and hidden groups |
| `ynab_get_payees` | All payees with IDs (for use with filtered queries) |
| `ynab_get_scheduled_transactions` | Upcoming and recurring scheduled transactions |
| `ynab_get_money_transfers` | Account-to-account transfers (includes flags). Formerly `ynab_get_money_movements` |
| `ynab_get_category_money_movements` | Money moved between categories or to/from Ready to Assign. `month` is the budget month the money belongs to; `moved_since` / `moved_until` filter by the date the move was made (and search every budget month when `month` is omitted). Optional `category` filter and grouping by action. Always reports `total_in_period`, `count`, and `action_count` |

**Write tools:**

| Tool | Description |
|------|-------------|
| `ynab_create_transaction` | Add a transaction, a linked transfer via `transfer_payee_id`, or a multi-category split via `subtransactions`. Approved by default |
| `ynab_update_transaction` | Edit, recategorize, approve, or clear a transaction, or turn an unsplit transaction into a split via `subtransactions` (the lines of an existing split cannot be changed) |
| `ynab_update_transactions` | Update several transactions in one call; fails with the IDs if YNAB does not confirm every one |
| `ynab_delete_transaction` | Delete a transaction. For a split, also makes YNAB recalculate each line's category (YNAB leaves the deleted lines in the spent total otherwise) and fails if a category still does not match |
| `ynab_import_transactions` | Trigger import from linked bank accounts |
| `ynab_set_category_budget` | Set a category's assigned amount for a month (money moves) |
| `ynab_update_category` | Rename a category, edit its note/group, or set/remove goal target fields |
| `ynab_create_scheduled_transaction` | Add a recurring or future-dated transaction (single category; the API cannot create scheduled splits) |
| `ynab_update_scheduled_transaction` | Edit a scheduled transaction |
| `ynab_delete_scheduled_transaction` | Delete a scheduled transaction |
| `ynab_rename_payee` | Rename a payee |
| `ynab_create_payee` | Create a payee; refuses a duplicate name and returns the existing ID |
| `ynab_create_account` | Create an unlinked (manually tracked) account |
| `ynab_create_category` | Create a category in a group; optionally set goal target/date/frequency |
| `ynab_create_category_group` | Create a category group (name, max 50 characters) |
| `ynab_update_category_group` | Rename a category group |

Write tools take amounts in dollars (negative = outflow) and convert to YNAB milliunits internally. Categories and category groups can be created, and goal targets can be set or updated (`goal_target`, `goal_target_date`, `goal_needs_whole_amount`, `goal_frequency`); use `ynab_get_category_groups` to get the `category_group_id` these need. The YNAB API still cannot create or delete a plan (budget), cannot delete accounts, and cannot delete payees, so those remain app-only. It cannot change the lines of a transaction that is *already* a split, and cannot create split *scheduled* transactions at all — those still have to be edited in the YNAB app.

New transactions are **approved by default**. YNAB itself leaves a transaction unapproved when the field is omitted, so `ynab_create_transaction` sends `approved: true` unless the caller passes `false`.

### Split transactions (multiple categories)

To create a new split (for example a Rouse's trip that is part groceries, part household supplies):

1. Look up each category ID with `ynab_get_category` (one small call per category; `ynab_get_categories` returns the whole budget).
2. Call `ynab_create_transaction` with the total `amount`, **omit** `category_id`, and pass `subtransactions`: at least two lines, each with `amount` (same sign as the parent) and `category_id`. Line amounts must add up to `amount`. Optional per-line `memo`.

Example: a $47.20 outflow, $32.10 groceries and $15.10 supplies — `amount: -47.20` and two lines `-32.10` / `-15.10`.

Reads (`ynab_get_transactions` and the filtered variants) return a `subtransactions` array on split transactions.

**Splitting a transaction that already exists.** Call `ynab_update_transaction` with `transaction_id` and `subtransactions` (same shape as above), and omit `category_id`. The tool reads the transaction first and refuses, before writing anything, a transaction that is already a split, lines that do not add up to its amount, or fewer than two lines. If YNAB accepts the request but does not apply the split, the call fails and puts the original category back.

This was verified against live YNAB on a transaction created through the API. It has **not** been verified on a bank-imported transaction; YNAB's spec makes no exception for imports. A split cannot be undone through the API, so try it first on an import you do want split.

The lines of a transaction that is **already a split cannot be changed** through the API (the spec: "Updating `subtransactions` on an existing split transaction is not supported and will return an error"). Edit those in the YNAB app.

Scheduled transactions cannot be split through the API at all: there is no `subtransactions` field on `SaveScheduledTransaction`, so `ynab_create_scheduled_transaction` takes a single `category_id`. To get a recurring split, create the scheduled transaction here and split its occurrences in the YNAB app. `ynab_get_scheduled_transactions` still returns `subtransactions` for scheduled splits that already exist.

### Account-to-account transfers

YNAB records a transfer as a transaction whose payee is the destination account's transfer payee (not a new payee you create).

1. Call `ynab_get_accounts` and take the **source** account `id` plus the **destination** account `transfer_payee_id`.
2. Call `ynab_create_transaction` with `account_id` = source, `amount` as a negative outflow in dollars, `payee_id` = destination `transfer_payee_id`, and **omit** `category_id`.

A `payee_name` like `Transfer : Checking` is resolved to that existing transfer payee. Do not invent a duplicate non-transfer payee with that name.

### Transaction flags

List/get responses (`ynab_get_transactions`, `ynab_get_transaction`, by account/payee/category, and `ynab_get_money_transfers`) include `flag_color` (`red` / `orange` / `yellow` / `green` / `blue` / `purple`) and `flag_name` (the custom name on that flag, if any). `ynab_create_transaction`, `ynab_update_transaction`, and `ynab_update_transactions` can set `flag_color`; a later get returns both fields. Merchant order-history URLs are not in the YNAB REST API and are not exposed here.

### Category goals

Category reads include a `goal_summary` string. Its forms are:

| `goal_summary` | Meaning |
|---|---|
| `No goal` | The category has no target |
| `Target balance of $X` | Have X in the category |
| `Target balance of $X by DATE` | Have X in the category by a date |
| `Fund $X every PERIOD` | Assign X each period (month, N months, week, year) |
| `Spend $X per period (Refill)` | Refill up to X each period |
| `Spend $X per period (Set Aside)` | Set aside another X each period |
| `Debt payment of $X every PERIOD` | Loan-paired category (mortgage, auto loan); X is the payment |
| `Debt payment goal (YNAB returned no target amount)` | Loan-paired category for which YNAB sent no amount |
| `Unknown goal type: TYPE` | A goal type this server does not recognize yet |

Anything that parses these strings should treat a form it does not recognize as a gap to report, not a category to skip.

### Money movements: budget month vs. date moved

`ynab_get_category_money_movements` has two different notions of time. `month` is the **budget month the money belongs to**, which is how YNAB's API scopes movements; October's budget is often funded in September. `moved_since` / `moved_until` filter by **the date the move was made**, in the budget owner's timezone, and search every budget month when `month` is omitted. Every response reports `total_in_period` (movements before any filter), `count` (movements returned), and `action_count` (distinct actions, where a group counts once), and each grouped movement carries its full `group_id`.

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
   - `APPROVAL_PASSPHRASE` — a passphrase only you know, entered on the approval page whenever an app connects. **Required:** without it the server refuses every approval.
4. Railway builds and deploys automatically using `railway.toml`

### Step 3 — Connect to Claude.ai

1. Open Claude.ai → **Settings → Connectors → Add custom connector**
2. Enter your Railway URL with the `/mcp` path:
   ```
   https://your-app.railway.app/mcp
   ```
3. Leave the **OAuth Client ID** and **OAuth Client Secret** fields empty — the server handles registration automatically
4. Click **Add**

Claude.ai will open a page on your Railway server asking **"Authorize YNAB access?"** — enter your `APPROVAL_PASSPHRASE` and click **Approve**. This happens once. After that, Claude.ai holds a token and reconnects silently.

> **Why a passphrase:** client registration is open so connectors can register themselves, which means anyone who learns your server URL can start a connection. The passphrase is what stops them from approving it. Wrong guesses are limited to 5 per connection attempt and 10 per 15 minutes server-wide (after which approvals lock for 15 minutes), and USER1 gets a Telegram alert on a wrong passphrase or a lockout.

> **Note:** Registered clients and tokens are stored in Postgres (`oauth_clients` and `oauth_tokens`, with tokens saved as SHA-256 hashes), so redeploys and restarts don't log connected apps out. You'll only be asked to approve again if an app stays unused for 30 days, when its refresh token expires.

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

# Required: passphrase you enter on the approval page when connecting an app
APPROVAL_PASSPHRASE=a-few-random-words-only-you-know

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

`USER_CATEGORIES` is a comma-separated list of YNAB category names. Matching is forgiving: case and emoji are ignored, so `Coffee Shops` matches `☕️ Coffee Shops`. A name that matches a set of day-range categories (for example `Eating Out` when the budget has `Eating Out 1st–7th`, `Eating Out 8th–15th`, ...) resolves to the one covering today in that user's timezone. Each user gets their own list — the balance shown is the remaining balance for the current month.

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

- **Transport**: Streamable HTTP (MCP spec) in stateless mode. Each POST to `/mcp` gets a fresh server and transport that are closed when the response ends, so memory stays flat no matter how often clients connect or whether they ever close their session. `GET` and `DELETE /mcp` return 405 (no standalone SSE stream); no tool uses server-initiated messages.
- **Auth**: OAuth 2.0 with dynamic client registration and PKCE. Connectors register themselves automatically; you approve each one once in your browser with `APPROVAL_PASSPHRASE`. Clients and tokens are stored in Postgres, so they survive redeploys.
- **Amounts**: All monetary values returned in dollars (milliunits ÷ 1000), never raw integers
- **Default budget**: All tools default to `last-used` so you don't need to specify a plan ID
- **Transfers**: Accounts include `transfer_payee_id`; create a linked transfer with that id as `payee_id` and no `category_id`
- **Splits**: Create with `subtransactions` (omit parent `category_id`), or split an existing unsplit transaction with `ynab_update_transaction`; reads return split lines. The lines of an existing split cannot be changed via the API
- **Approval**: `ynab_create_transaction` approves new transactions unless `approved: false` is passed; YNAB's own default is unapproved
- **Response size**: MCP clients truncate large tool results, so single-item and filtered reads exist alongside the full lists (`ynab_get_category`, `ynab_get_transaction`, `month` / `type` on `ynab_get_transactions`, `category` and date filters on `ynab_get_category_money_movements`). Prefer them
- **Stale client schemas**: a client holding an old copy of a tool's schema sends list fields as JSON strings; the list fields on the transaction write tools accept that form as well as arrays
- **Flags**: Transaction reads pass through `flag_color` and `flag_name`
- **Scheduler**: Optional background worker (`node-cron`) that fires on configured cron schedules, fetches YNAB category balances, and sends digests via Telegram. Initializes at server startup; silently no-ops if `TELEGRAM_BOT_TOKEN` is absent.

---

## Security

- Your YNAB Personal Access Token is only read from the environment — never committed to code
- The Telegram bot token is environment-only and used outbound only — never in code or logs
- Write tools mutate the household YNAB budget via the personal access token; they cannot create or delete a plan, or delete accounts or payees
- Access requires explicit approval in your browser with `APPROVAL_PASSPHRASE` — unapproved requests are rejected, and approvals are refused entirely if the passphrase isn't set
- Wrong passphrases are rate-limited (5 per connection attempt, 10 per 15 minutes server-wide), and USER1 gets a Telegram alert on a wrong passphrase or lockout
- Access and refresh tokens are stored only as SHA-256 hashes; client secrets are stored as issued because the MCP SDK compares them directly, but a secret alone can't obtain a token without the passphrase or a valid refresh token
- PKCE prevents authorization codes from being stolen or replayed
