import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getYnabClient, withYnabErrorHandling } from '../ynab.js';
import { toUSD } from '../utils.js';

export function registerScheduledTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_scheduled_transactions',
    {
      description:
        'Get all upcoming and recurring scheduled transactions. ' +
        'Returns frequency, next occurrence date, amount, payee name, and category name.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
      },
    },
    async (args) => {
      return withYnabErrorHandling(async () => {
        const api = getYnabClient();
        const planId = args.plan_id ?? 'last-used';
        const response = await api.scheduledTransactions.getScheduledTransactions(planId);
        const scheduled = response.data.scheduled_transactions
          .filter((t) => !t.deleted)
          .map((t) => ({
            id: t.id,
            date_first: t.date_first,
            date_next: t.date_next,
            frequency: t.frequency,
            amount: toUSD(t.amount),
            payee_name: t.payee_name ?? null,
            category_name: t.category_name ?? null,
            account_name: t.account_name,
            memo: t.memo ?? null,
          }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(scheduled, null, 2) }] };
      });
    }
  );
}
