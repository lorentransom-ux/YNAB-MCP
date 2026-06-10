import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, cachedFetch } from '../ynab.js';
import { toUSD, daysAgo, DEFAULT_SINCE_DAYS } from '../utils.js';
import type { TransactionDetail, HybridTransaction } from 'ynab';

function mapTransaction(t: TransactionDetail | HybridTransaction) {
  return {
    id: t.id,
    date: t.date,
    amount: toUSD(t.amount),
    payee_name: t.payee_name ?? null,
    category_name: t.category_name ?? null,
    account_name: t.account_name,
    memo: t.memo ?? null,
    cleared: t.cleared,
    approved: t.approved,
    transfer_account_id: t.transfer_account_id ?? null,
  };
}

export function registerTransactionTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_transactions',
    {
      description:
        'Get all transactions with optional date filters. ' +
        'Returns payee name, category name, account name, amount, date, memo, and cleared status. ' +
        `When since_date is omitted, only the last ${DEFAULT_SINCE_DAYS} days are returned; ` +
        'pass an explicit since_date to reach further back.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        since_date: z.string().optional().describe(
          'Return only transactions on or after this date (YYYY-MM-DD). ' +
          `Defaults to ${DEFAULT_SINCE_DAYS} days ago when omitted.`
        ),
        until_date: z.string().optional().describe(
          'Return only transactions on or before this date (YYYY-MM-DD). Filtered client-side.'
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
          .filter((t) => !t.deleted && (!args.until_date || t.date <= args.until_date!))
          .map(mapTransaction);
      })
  );

  server.registerTool(
    'ynab_get_transactions_by_account',
    {
      description:
        'Get transactions filtered to a specific account. ' +
        'Requires account_id. If you only have an account name, call ynab_get_accounts first ' +
        'to look up the account ID from the account name.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        account_id: z.string().describe('The account ID to filter transactions by.'),
        since_date: z.string().optional().describe(
          'Return only transactions on or after this date (YYYY-MM-DD).'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const response = await cachedFetch(
          `transactions:account:${planId}:${args.account_id}:${args.since_date ?? ''}`,
          () => api.transactions.getTransactionsByAccount(planId, args.account_id, args.since_date)
        );
        return response.data.transactions
          .filter((t) => !t.deleted)
          .map(mapTransaction);
      })
  );

  server.registerTool(
    'ynab_get_transactions_by_category',
    {
      description:
        'Get transactions filtered to a specific category. ' +
        'Requires category_id. If you only have a category name, call ynab_get_categories first ' +
        'to look up the category ID from the category name.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        category_id: z.string().describe('The category ID to filter transactions by.'),
        since_date: z.string().optional().describe(
          'Return only transactions on or after this date (YYYY-MM-DD).'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const response = await cachedFetch(
          `transactions:category:${planId}:${args.category_id}:${args.since_date ?? ''}`,
          () => api.transactions.getTransactionsByCategory(planId, args.category_id, args.since_date)
        );
        return response.data.transactions
          .filter((t) => !t.deleted)
          .map(mapTransaction);
      })
  );

  server.registerTool(
    'ynab_get_transactions_by_payee',
    {
      description:
        'Get transactions filtered to a specific payee. ' +
        'Requires payee_id. If you only have a payee name, call ynab_get_payees first ' +
        'to look up the payee ID from the payee name.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        payee_id: z.string().describe('The payee ID to filter transactions by.'),
        since_date: z.string().optional().describe(
          'Return only transactions on or after this date (YYYY-MM-DD).'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const response = await cachedFetch(
          `transactions:payee:${planId}:${args.payee_id}:${args.since_date ?? ''}`,
          () => api.transactions.getTransactionsByPayee(planId, args.payee_id, args.since_date)
        );
        return response.data.transactions
          .filter((t) => !t.deleted)
          .map(mapTransaction);
      })
  );
}
