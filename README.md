# YNAB MCP Server

A TypeScript MCP (Model Context Protocol) server that connects to the YNAB API for personal budget reporting — designed to be hosted on Railway, connected to Claude.ai as a custom connector, and optionally configured to send scheduled SMS budget summaries via Twilio.

## Features

12 read-only budget tools plus 2 tools for managing SMS notifications — all accessible via Claude chat.

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

**SMS config tools** (chat with Claude to update — no dashboard needed):

| Tool | Description |
|------|-------------|
| `ynab_get_sms_config` | Show current notification config for all users |
| `ynab_update_sms_config` | Update categories, schedule, timezone, or message format for a user |

Plus optional scheduled SMS notifications — each person gets their own schedule and category list, delivered as standard SMS to their existing phone.

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

## SMS Notifications (Optional)

The server can text each person a summary of their chosen YNAB category balances on a schedule they control. Texts are delivered as standard SMS to their existing cell phones — no new numbers or apps needed.

**Example message:**
```
YNAB – May 2026 (Loren)
Groceries: $156.23 left
Dining Out: -$45.00 left
Entertainment: $80.00 left
```

### Twilio Setup

1. Create a free account at **twilio.com**
2. Buy a phone number (~$1/month) — this is the number texts will come from. Save it in your contacts as "YNAB" so it's recognizable.
3. From the Twilio Console, copy your **Account SID** and **Auth Token**

### Environment Variables

Add these to your Railway service's **Variables** tab:

```
# Twilio credentials
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_PHONE=+15559876543

# User 1
USER1_NAME=Loren
USER1_PHONE=+15551234567
USER1_SCHEDULE=0 8 * * 1
USER1_CATEGORIES=Groceries,Dining Out,Entertainment
USER1_TIMEZONE=America/Chicago

# User 2
USER2_NAME=Wife
USER2_PHONE=+15557654321
USER2_SCHEDULE=0 9 * * 5
USER2_CATEGORIES=Groceries,Clothing,Personal Care
USER2_TIMEZONE=America/Chicago

# Optional: pin to a specific YNAB budget ID (defaults to your last-used budget)
# YNAB_BUDGET_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

All SMS variables are optional. If Twilio credentials are absent the scheduler starts up silently and does nothing. USER1 and USER2 are independent — you can configure just one.

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

---

## SMS Chat — Ask Budget Questions by Text

Text your Twilio number a plain-English question and get a direct answer back. No app, no login — just SMS.

**Examples:**
```
You: How much is left in groceries?
YNAB: Groceries: $87.43 left this month.

You: How much did we spend eating out this week?
YNAB: Dining Out activity last 14 days: $124.50 across 6 transactions.

You: Are we over budget anywhere?
YNAB: Yes — Clothing is -$23.10 and Entertainment is -$8.00.
```

Replies are kept under 280 characters. Each text is a fresh query — no conversation history is retained between messages.

### Setup

1. Add `ANTHROPIC_API_KEY` to your Railway service's **Variables** tab (get one at console.anthropic.com)
2. In the **Twilio Console** → Phone Numbers → your number → **Messaging** tab:
   - Set **"A message comes in"** webhook to: `https://your-app.railway.app/sms`
   - Method: `HTTP POST`

Only phone numbers listed in `USER1_PHONE` / `USER2_PHONE` will receive replies — texts from other numbers are silently ignored.

### Local testing with ngrok

```bash
ngrok http 3000
# Copy the https URL, set it as the Twilio webhook temporarily
# Then text your Twilio number and watch the logs
```

---

## Adjusting SMS Config via Claude Chat

Once the server is running and connected to Claude.ai, you can update your SMS settings conversationally — no Railway dashboard needed for day-to-day changes.

**Example conversations:**

```
You: Show me my current SMS config
Claude: [calls ynab_get_sms_config]

You: Add "Rent" and "Utilities" to my text
Claude: [calls ynab_update_sms_config → updates Loren's category list]

You: Move my wife's text to Wednesday mornings at 9
Claude: [calls ynab_update_sms_config with schedule="0 9 * * 3"]

You: Show both of us the budgeted amount instead of remaining balance
Claude: [calls ynab_update_sms_config twice, once per user, with format_field="budgeted"]

You: Add a header note to my text that says "Weekly check-in"
Claude: [calls ynab_update_sms_config with header_note="Weekly check-in"]
```

**What's adjustable per user:**
- `categories` — which YNAB categories appear (full replacement list)
- `schedule` — when texts fire (cron expression; takes effect immediately)
- `timezone` — IANA timezone for schedule and month label
- `format_field` — which dollar amount to show: `balance` (remaining), `budgeted`, or `activity` (spent)
- `show_goal_progress` — append `(X% funded)` for categories with goals
- `header_note` — custom line prepended to the message

**What stays in Railway env vars** (phone numbers and Twilio credentials are not updatable via chat):
- `USER1_PHONE`, `USER2_PHONE`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_PHONE`

### Config persistence — Railway Volume

Config changes made via Claude are saved to `data/sms-config.json`. On Railway, this file lives on the service's ephemeral filesystem and **resets on redeploy** unless you attach a persistent volume:

1. Railway dashboard → your service → **Volumes** tab → **Add Volume**
2. Mount path: `/data`
3. Add env var: `SMS_CONFIG_PATH=/data/sms-config.json`

Without a volume, the config is re-seeded from your `USER1_*`/`USER2_*` env vars on each restart — which is fine, but any changes made via Claude will be lost on the next deploy.

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

# Optional — SMS notifications (omit to disable)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_PHONE=+15559876543

USER1_NAME=Loren
USER1_PHONE=+15551234567
USER1_SCHEDULE=*/2 * * * *
USER1_CATEGORIES=Groceries,Dining Out
USER1_TIMEZONE=America/Chicago

USER2_NAME=Wife
USER2_PHONE=+15557654321
USER2_SCHEDULE=0 9 * * 5
USER2_CATEGORIES=Groceries,Clothing
USER2_TIMEZONE=America/Chicago
```

> **Tip:** For local testing, set `USER1_SCHEDULE=*/2 * * * *` to fire every 2 minutes so you can verify a text arrives quickly, then change it to your real schedule before deploying.

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
- **Scheduler**: Optional background worker (`node-cron`) that fires on configured cron schedules, fetches YNAB category balances, and sends SMS summaries via Twilio. Initializes at server startup; silently no-ops if Twilio credentials are absent.

---

## Security

- Your YNAB Personal Access Token is only read from the environment — never committed to code
- Twilio credentials and recipient phone numbers are environment-only — never in code or logs
- All tools are read-only; no write operations are exposed
- Access requires explicit approval in your browser — unapproved requests are rejected
- PKCE prevents authorization codes from being stolen or replayed
- Sessions are isolated per Claude connection
