import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getYnabClient, withYnabErrorHandling, cachedFetch } from '../ynab.js';
import { toUSD } from '../utils.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_accounts',
    {
      description: 'Get all accounts with current balances, types, and on-budget status.',
      inputSchema: {
        plan_id: z.string().optional().describe(
          'Budget/plan ID. Defaults to "last-used" (the most recently used budget).'
        ),
      },
    },
    async (args) => {
      return withYnabErrorHandling(async () => {
        const api = getYnabClient();
        const planId = args.plan_id ?? 'last-used';
        const response = await cachedFetch(
          `accounts:${planId}`,
          () => api.accounts.getAccounts(planId)
        );
        const accounts = response.data.accounts
          .filter((a) => !a.deleted)
          .map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            on_budget: a.on_budget,
            closed: a.closed,
            balance: toUSD(a.balance),
            cleared_balance: toUSD(a.cleared_balance),
            uncleared_balance: toUSD(a.uncleared_balance),
          }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(accounts) }] };
      });
    }
  );
}
