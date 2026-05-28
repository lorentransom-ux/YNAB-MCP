import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getYnabClient, withYnabErrorHandling, cachedFetch } from '../ynab.js';
import { toUSD } from '../utils.js';

export function registerMovementTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_money_movements',
    {
      description:
        'Get transfers between accounts (money movements). ' +
        'These are transactions where funds move from one account to another. ' +
        'Optional since_date filter.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        since_date: z.string().optional().describe(
          'Return only transfers on or after this date (YYYY-MM-DD).'
        ),
      },
    },
    async (args) => {
      return withYnabErrorHandling(async () => {
        const api = getYnabClient();
        const planId = args.plan_id ?? 'last-used';
        const response = await cachedFetch(
          `transactions:${planId}:${args.since_date ?? ''}`,
          () => api.transactions.getTransactions(planId, args.since_date)
        );
        const transfers = response.data.transactions
          .filter((t) => !t.deleted && t.transfer_account_id != null)
          .map((t) => ({
            id: t.id,
            date: t.date,
            amount: toUSD(t.amount),
            payee_name: t.payee_name ?? null,
            account_name: t.account_name,
            transfer_account_id: t.transfer_account_id,
            memo: t.memo ?? null,
            cleared: t.cleared,
          }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(transfers) }] };
      });
    }
  );
}
