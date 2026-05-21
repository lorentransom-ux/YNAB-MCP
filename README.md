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

### Prerequisites

Install the Railway CLI:

```bash
npm install -g @railway/cli
railway login
```

### Deploy

```bash
railway init        # creates a new Railway project
railway up          # builds and deploys
```

After deployment, add your environment variable in the Railway dashboard:

1. Open your project → **Variables**
2. Add `YNAB_TOKEN` = your token

Railway automatically provides the `PORT` variable — no configuration needed.

Your deployed server URL will be something like `https://your-app.railway.app`.

---

## Connect to Claude.ai

1. Open Claude.ai and go to **Settings → Connectors**
2. Click **Add custom connector**
3. Enter your Railway URL with the `/mcp` path:
   ```
   https://your-app.railway.app/mcp
   ```
4. Save — Claude can now access your YNAB data

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
