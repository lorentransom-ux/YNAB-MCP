# YNAB MCP Server

A TypeScript MCP (Model Context Protocol) server that connects to the YNAB API for personal budget reporting. Designed to be hosted on Railway and connected to Claude.ai as a custom connector.

## Features

12 read-only tools covering every major YNAB reporting use case:

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

---

## Setup

### 1. Generate a YNAB Personal Access Token

1. Log in to YNAB and go to **app.ynab.com/settings/developer**
2. Click **New Token** under Personal Access Tokens
3. Copy the token — you won't see it again

### 2. Set the Environment Variable

The server reads a single environment variable:

```
YNAB_TOKEN=your_token_here
```

For local development, create a `.env` file (it's gitignored) or export it in your shell:

```bash
export YNAB_TOKEN=your_token_here
```

---

## Local Development

```bash
npm install
npm run dev
```

The server starts on port 3000 by default. Check health at `http://localhost:3000/health`.

---

## Deploy to Railway

1. Go to **railway.app** → **New Project** → **Deploy from GitHub repo** → select this repo
2. Set the branch to `claude/ynab-mcp-server-jPImi` (or merge to main first)
3. Open your service → **Variables** tab and add two variables:
   - `YNAB_TOKEN` = your YNAB personal access token
   - `MCP_AUTH_TOKEN` = a strong random secret you generate (e.g. run `openssl rand -hex 32` in your terminal)
4. Railway builds automatically using `railway.toml`
5. Go to **Settings** → **Generate Domain** to get your public URL

---

## Connect to Claude.ai

The server requires an `Authorization: Bearer <token>` header on every request. Claude.ai custom connectors support this natively.

1. Open Claude.ai → **Settings → Connectors → Add custom connector**
2. Enter your Railway URL:
   ```
   https://your-app.railway.app/mcp
   ```
3. Under **Authentication**, choose **Bearer token** and paste your `MCP_AUTH_TOKEN` value
4. Save — Claude can now access your YNAB data

Anyone who requests your URL without the correct token gets a `401 Unauthorized` response.

---

## Architecture

- **Transport**: Streamable HTTP (MCP spec) with stateful sessions
- **Auth**: Bearer token via `YNAB_TOKEN` env var
- **Amounts**: All monetary values returned in dollars (milliunits ÷ 1000), never raw integers
- **Default budget**: All tools default to `last-used` so you don't need to specify a plan ID

---

## Security

- Your YNAB Personal Access Token is only read from the environment — never committed to code
- All tools are read-only; no write operations are exposed
- Sessions are isolated per Claude connection
