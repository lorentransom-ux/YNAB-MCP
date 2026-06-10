import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, cachedFetch } from '../ynab.js';
import { toUSD, daysAgo, DEFAULT_SINCE_DAYS } from '../utils.js';

export function registerMovementTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_money_movements',
    {
      description:
        'Get transfers between accounts (money movements). ' +
        'These are transactions where funds move from one account to another. ' +
        `When since_date is omitted, only the last ${DEFAULT_SINCE_DAYS} days are returned; ` +
        'pass an explicit since_date to reach further back.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        since_date: z.string().optional().describe(
          'Return only transfers on or after this date (YYYY-MM-DD). ' +
          `Defaults to ${DEFAULT_SINCE_DAYS} days ago when omitted.`
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const sinceDate = args.since_date ?? daysAgo(DEFAULT_SINCE_DAYS);
        const response = await cachedFetch(
          `transactions:${planId}:${sinceDate}`,
          () => api.transactions.getTransactions(planId, sinceDate)
        );
        return response.data.transactions
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
      })
  );
}
