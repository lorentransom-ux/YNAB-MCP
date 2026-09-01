import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, ynabWrite, cachedFetch } from '../ynab.js';
import { toUSD, toMilliunits } from '../utils.js';
import type { ScheduledTransactionDetail } from 'ynab';

const frequencySchema = z.enum([
  'never',
  'daily',
  'weekly',
  'everyOtherWeek',
  'twiceAMonth',
  'every4Weeks',
  'monthly',
  'everyOtherMonth',
  'every3Months',
  'every4Months',
  'twiceAYear',
  'yearly',
  'everyOtherYear',
]);

const flagColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);

const AMOUNT_DESC =
  'Amount in dollars. Negative for outflows/spending (e.g. -12.34), positive for inflows.';

// NOTE: the YNAB API cannot create split scheduled transactions — SaveScheduledTransaction
// has no subtransactions field (spec 1.85.0), and the SDK serializer drops it silently, so
// passing splits here would produce an uncategorized scheduled transaction while appearing
// to succeed. Splits are read-only on this resource: mapSubtransactions below surfaces the
// ones created in the YNAB app. Regular splits go through ynab_create_transaction.
function mapSubtransactions(t: ScheduledTransactionDetail) {
  const subs = Array.isArray(t.subtransactions) ? t.subtransactions : [];
  const live = subs.filter((s) => !s.deleted);
  if (!live.length) return undefined;
  return live.map((s) => ({
    id: s.id,
    amount: toUSD(s.amount),
    payee_name: s.payee_name ?? null,
    category_id: s.category_id ?? null,
    category_name: s.category_name ?? null,
    memo: s.memo ?? null,
  }));
}

function mapScheduled(t: ScheduledTransactionDetail) {
  const subtransactions = mapSubtransactions(t);
  return {
    id: t.id,
    date_first: t.date_first,
    date_next: t.date_next,
    frequency: t.frequency,
    amount: toUSD(t.amount),
    payee_name: t.payee_name ?? null,
    category_name: t.category_name ?? null,
    account_name: t.account_name,
    memo: t.memo ?? null,
    ...(subtransactions ? { subtransactions } : {}),
  };
}

export function registerScheduledTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_scheduled_transactions',
    {
      description:
        'Get all upcoming and recurring scheduled transactions. ' +
        'Returns frequency, next occurrence date, amount, payee name, and category name. ' +
        'Split scheduled transactions include a subtransactions array.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const response = await cachedFetch(
          `scheduled:${planId}`,
          () => api.scheduledTransactions.getScheduledTransactions(planId)
        );
        return response.data.scheduled_transactions
          .filter((t) => !t.deleted)
          .map(mapScheduled);
      })
  );

  server.registerTool(
    'ynab_create_scheduled_transaction',
    {
      description:
        'Create a recurring or one-time future (scheduled) transaction. ' +
        'Requires account_id (from ynab_get_accounts) and a future date. ' +
        'The YNAB API cannot create a SPLIT scheduled transaction (one amount divided across ' +
        'several categories) — pass a single category_id here, then split the occurrence in the ' +
        'YNAB app, or use ynab_create_transaction for a one-off split. ' +
        'Returns the created scheduled transaction.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        account_id: z.string().describe('The account the scheduled transaction belongs to.'),
        date: z.string().describe('First occurrence date (YYYY-MM-DD). Must be in the future.'),
        amount: z.number().describe(AMOUNT_DESC),
        frequency: frequencySchema.optional().describe(
          'How often the transaction repeats. "never" (the default) schedules a single future transaction.'
        ),
        payee_id: z.string().optional().describe('Existing payee ID. Prefer payee_name unless the ID is known.'),
        payee_name: z.string().optional().describe('Payee name. Matched to an existing payee or created.'),
        category_id: z.string().optional().describe(
          'Category ID (from ynab_get_categories). Omit to leave uncategorized.'
        ),
        memo: z.string().optional().describe('Optional memo.'),
        flag_color: flagColorSchema.optional().describe('Optional flag color.'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.scheduledTransactions.createScheduledTransaction(planId, {
          scheduled_transaction: {
            account_id: args.account_id,
            date: args.date,
            amount: toMilliunits(args.amount),
            ...(args.frequency !== undefined && { frequency: args.frequency }),
            ...(args.payee_id !== undefined && { payee_id: args.payee_id }),
            ...(args.payee_name !== undefined && { payee_name: args.payee_name }),
            ...(args.category_id !== undefined && { category_id: args.category_id }),
            ...(args.memo !== undefined && { memo: args.memo }),
            ...(args.flag_color !== undefined && { flag_color: args.flag_color }),
          },
        });
        return mapScheduled(response.data.scheduled_transaction);
      })
  );

  server.registerTool(
    'ynab_update_scheduled_transaction',
    {
      description:
        'Update an existing scheduled transaction. Only the provided fields are changed; ' +
        'the rest keep their current values. ' +
        'Requires scheduled_transaction_id (from ynab_get_scheduled_transactions). ' +
        'The YNAB API cannot add or change splits on an existing scheduled transaction. ' +
        'Returns the updated scheduled transaction.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        scheduled_transaction_id: z.string().describe('The scheduled transaction to update.'),
        account_id: z.string().optional().describe('Move it to a different account.'),
        date: z.string().optional().describe('New upcoming date (YYYY-MM-DD). Must be in the future.'),
        amount: z.number().optional().describe(AMOUNT_DESC),
        frequency: frequencySchema.optional().describe('New repeat frequency.'),
        payee_id: z.string().optional().describe('New payee ID.'),
        payee_name: z.string().optional().describe('New payee name. Matched to an existing payee or created.'),
        category_id: z.string().optional().describe('New category ID (from ynab_get_categories).'),
        memo: z.string().optional().describe('New memo.'),
        flag_color: flagColorSchema.optional().describe('New flag color.'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        // YNAB's PUT replaces the whole scheduled transaction, so fetch the
        // current one and merge the caller's changes over it.
        const existing = (
          await api.scheduledTransactions.getScheduledTransactionById(
            planId,
            args.scheduled_transaction_id
          )
        ).data.scheduled_transaction;
        const response = await api.scheduledTransactions.updateScheduledTransaction(
          planId,
          args.scheduled_transaction_id,
          {
            scheduled_transaction: {
              account_id: args.account_id ?? existing.account_id,
              date: args.date ?? existing.date_next,
              amount: args.amount !== undefined ? toMilliunits(args.amount) : existing.amount,
              frequency: args.frequency ?? existing.frequency,
              payee_id: args.payee_id ?? (args.payee_name !== undefined ? undefined : existing.payee_id),
              ...(args.payee_name !== undefined && { payee_name: args.payee_name }),
              category_id: args.category_id ?? existing.category_id,
              memo: args.memo ?? existing.memo,
              flag_color: args.flag_color ?? existing.flag_color,
            },
          }
        );
        return mapScheduled(response.data.scheduled_transaction);
      })
  );

  server.registerTool(
    'ynab_delete_scheduled_transaction',
    {
      description:
        'Delete a scheduled transaction. ' +
        'Requires scheduled_transaction_id (from ynab_get_scheduled_transactions). ' +
        'Returns the deleted scheduled transaction for confirmation.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        scheduled_transaction_id: z.string().describe('The scheduled transaction to delete.'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.scheduledTransactions.deleteScheduledTransaction(
          planId,
          args.scheduled_transaction_id
        );
        return { deleted: true, ...mapScheduled(response.data.scheduled_transaction) };
      })
  );
}
