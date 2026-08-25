import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, ynabWrite, cachedFetch } from '../ynab.js';
import { toUSD, toMilliunits, daysAgo, DEFAULT_SINCE_DAYS } from '../utils.js';
import type { TransactionDetail, HybridTransaction, ExistingTransaction, Payee } from 'ynab';

// Shared enums for transaction write tools, matching the YNAB API's values.
const clearedSchema = z.enum(['cleared', 'uncleared', 'reconciled']);
const flagColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);

const AMOUNT_DESC =
  'Amount in dollars. Negative for outflows/spending (e.g. -12.34), positive for inflows.';

const splitLineSchema = z.object({
  amount: z.number().describe(AMOUNT_DESC),
  category_id: z.string().describe(
    'Category ID for this split line (from ynab_get_categories).'
  ),
  memo: z.string().optional().describe('Optional memo on this split line.'),
});

type TransactionWithFlagName = (TransactionDetail | HybridTransaction) & {
  flag_name?: string | null;
};

function mapSubtransactions(t: TransactionDetail | HybridTransaction) {
  const detail = t as TransactionDetail;
  const subs = Array.isArray(detail.subtransactions) ? detail.subtransactions : [];
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

function mapTransaction(t: TransactionDetail | HybridTransaction) {
  const tx = t as TransactionWithFlagName;
  const subtransactions = mapSubtransactions(t);
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
    flag_color: t.flag_color ?? null,
    flag_name: tx.flag_name ?? null,
    ...(subtransactions ? { subtransactions } : {}),
  };
}

function isTransferName(name: string | undefined): boolean {
  return typeof name === 'string' && /^transfer\s*:/i.test(name.trim());
}

function buildSplitLines(
  parentAmount: number,
  splits: { amount: number; category_id: string; memo?: string }[]
): { amount: number; category_id: string; memo?: string }[] {
  if (splits.length < 2) {
    throw new Error('A split needs at least two lines, each with amount and category_id.');
  }
  const parentMilli = toMilliunits(parentAmount);
  const lines = splits.map((s) => ({
    amount: toMilliunits(s.amount),
    category_id: s.category_id,
    ...(s.memo !== undefined && { memo: s.memo }),
  }));
  const sum = lines.reduce((acc, s) => acc + (s.amount ?? 0), 0);
  if (sum !== parentMilli) {
    throw new Error(
      `Split line amounts must add up to the transaction amount (${parentAmount}). ` +
        `They currently add up to ${sum / 1000}.`
    );
  }
  return lines;
}

async function loadPayees(api: { payees: { getPayees: (planId: string) => Promise<{ data: { payees: Payee[] } }> } }, planId: string) {
  const response = await cachedFetch(`payees:${planId}`, () => api.payees.getPayees(planId));
  return response.data.payees.filter((p) => !p.deleted);
}

export function registerTransactionTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_transactions',
    {
      description:
        'Get all transactions with optional date filters. ' +
        'Returns payee name, category name, account name, amount, date, memo, cleared status, ' +
        'flag_color, and flag_name (custom name on that flag, if any). ' +
        'Split transactions include a subtransactions array (each line has amount and category). ' +
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
        'to look up the account ID from the account name. Includes flag_color, flag_name, ' +
        'and subtransactions on splits.',
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
        'to look up the category ID from the category name. Includes flag_color and flag_name. ' +
        'Split transactions that include this category are returned with their subtransactions.',
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
        'to look up the payee ID from the payee name. Includes flag_color, flag_name, ' +
        'and subtransactions on splits.',
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

  server.registerTool(
    'ynab_create_transaction',
    {
      description:
        'Create a new transaction in an account. ' +
        'Requires account_id (from ynab_get_accounts) and either payee_name or payee_id. ' +
        'A payee_name that does not exist yet is created automatically, except transfers. ' +
        'To record an account-to-account transfer: account_id is the source, amount is a ' +
        'negative outflow in dollars, payee_id is the destination account\'s transfer_payee_id ' +
        '(from ynab_get_accounts), and omit category_id. Do not invent a Transfer payee. ' +
        'A payee_name like "Transfer : Checking" is resolved to that existing transfer payee. ' +
        'To split across categories (groceries + supplies, etc.): omit category_id and pass ' +
        'subtransactions. Each line needs amount (dollars, same sign as the parent) and ' +
        'category_id. Line amounts must add up to amount. The YNAB API cannot add splits to ' +
        'an already-imported bank transaction; split those in the YNAB app, or create a new ' +
        'split here. Returns the created transaction including flag_color, flag_name, and ' +
        'subtransactions when split.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        account_id: z.string().describe('The account the transaction belongs to. For a transfer, this is the source account.'),
        date: z.string().describe('Transaction date (YYYY-MM-DD). Cannot be in the future.'),
        amount: z.number().describe(AMOUNT_DESC),
        payee_id: z.string().optional().describe(
          'Existing payee ID. For a transfer, use the destination account\'s transfer_payee_id from ynab_get_accounts. Prefer this over payee_name unless the ID is unknown.'
        ),
        payee_name: z.string().optional().describe(
          'Payee name. Matched to an existing payee or created. Names like "Transfer : AccountName" are resolved to the existing transfer payee and never create a duplicate.'
        ),
        category_id: z.string().optional().describe(
          'Category ID (from ynab_get_categories). Omit for transfers, splits, and to leave a transaction uncategorized.'
        ),
        subtransactions: z.array(splitLineSchema).optional().describe(
          'Split lines for a multi-category transaction. Omit category_id on the parent. At least two lines; amounts must sum to amount.'
        ),
        memo: z.string().optional().describe('Optional memo.'),
        cleared: clearedSchema.optional().describe('Cleared status. Defaults to "uncleared".'),
        approved: z.boolean().optional().describe('Whether the transaction is approved. Defaults to true for API-created transactions.'),
        flag_color: flagColorSchema.optional().describe('Optional flag color.'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        let payeeId = args.payee_id;
        let payeeName = args.payee_name;
        let categoryId = args.category_id;
        const splits = args.subtransactions;

        if (splits?.length && categoryId) {
          throw new Error(
            'Omit category_id when splitting. Each split line has its own category_id.'
          );
        }

        if (isTransferName(payeeName) || payeeId) {
          const payees = await loadPayees(api, planId);
          if (isTransferName(payeeName) && !payeeId) {
            const target = payeeName!.trim().toLowerCase();
            const match = payees.find(
              (p) => p.transfer_account_id && p.name.toLowerCase() === target
            );
            if (!match) {
              throw new Error(
                `No existing transfer payee named "${payeeName}". ` +
                  'Use the destination account\'s transfer_payee_id from ynab_get_accounts. ' +
                  'Do not create a new payee for transfers.'
              );
            }
            payeeId = match.id;
            payeeName = undefined;
            categoryId = undefined;
          } else if (payeeId) {
            const match = payees.find((p) => p.id === payeeId);
            if (match?.transfer_account_id) {
              payeeName = undefined;
              categoryId = undefined;
            }
          }
        }

        if (splits?.length && categoryId === undefined && payeeId) {
          // Transfers cannot also be category splits.
          const payees = await loadPayees(api, planId);
          const match = payees.find((p) => p.id === payeeId);
          if (match?.transfer_account_id) {
            throw new Error(
              'A transfer cannot also be split across categories. ' +
                'Create a regular (non-transfer) transaction with subtransactions instead.'
            );
          }
        }

        const subtransactions = splits?.length
          ? buildSplitLines(args.amount, splits)
          : undefined;

        const response = await api.transactions.createTransaction(planId, {
          transaction: {
            account_id: args.account_id,
            date: args.date,
            amount: toMilliunits(args.amount),
            ...(payeeId !== undefined && { payee_id: payeeId }),
            ...(payeeName !== undefined && { payee_name: payeeName }),
            ...(categoryId !== undefined && { category_id: categoryId }),
            ...(subtransactions !== undefined && { subtransactions }),
            ...(args.memo !== undefined && { memo: args.memo }),
            ...(args.cleared !== undefined && { cleared: args.cleared }),
            ...(args.approved !== undefined && { approved: args.approved }),
            ...(args.flag_color !== undefined && { flag_color: args.flag_color }),
          },
        });
        const created = response.data.transaction;
        return created ? mapTransaction(created) : { created: true };
      })
  );

  server.registerTool(
    'ynab_update_transaction',
    {
      description:
        'Update an existing transaction. Only the provided fields are changed. ' +
        'Use this to recategorize, edit amounts/memos, approve, or mark transactions cleared. ' +
        'Requires transaction_id (from ynab_get_transactions). ' +
        'The YNAB API cannot add or change splits on an existing transaction. ' +
        'To record a multi-category purchase, create a new split with ynab_create_transaction ' +
        '(or split the import in the YNAB app). Returns the updated transaction including ' +
        'flag_color, flag_name, and subtransactions when already split.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        transaction_id: z.string().describe('The transaction to update.'),
        account_id: z.string().optional().describe('Move the transaction to a different account.'),
        date: z.string().optional().describe('New date (YYYY-MM-DD).'),
        amount: z.number().optional().describe(AMOUNT_DESC),
        payee_id: z.string().optional().describe('New payee ID.'),
        payee_name: z.string().optional().describe('New payee name. Matched to an existing payee or created.'),
        category_id: z.string().optional().describe('New category ID (from ynab_get_categories). Cannot change the category of an existing split.'),
        memo: z.string().optional().describe('New memo.'),
        cleared: clearedSchema.optional().describe('New cleared status.'),
        approved: z.boolean().optional().describe('Set true to approve an unapproved transaction.'),
        flag_color: flagColorSchema.optional().describe('New flag color.'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const transaction: ExistingTransaction = {
          ...(args.account_id !== undefined && { account_id: args.account_id }),
          ...(args.date !== undefined && { date: args.date }),
          ...(args.amount !== undefined && { amount: toMilliunits(args.amount) }),
          ...(args.payee_id !== undefined && { payee_id: args.payee_id }),
          ...(args.payee_name !== undefined && { payee_name: args.payee_name }),
          ...(args.category_id !== undefined && { category_id: args.category_id }),
          ...(args.memo !== undefined && { memo: args.memo }),
          ...(args.cleared !== undefined && { cleared: args.cleared }),
          ...(args.approved !== undefined && { approved: args.approved }),
          ...(args.flag_color !== undefined && { flag_color: args.flag_color }),
        };
        const response = await api.transactions.updateTransaction(
          planId,
          args.transaction_id,
          { transaction }
        );
        return mapTransaction(response.data.transaction);
      })
  );

  server.registerTool(
    'ynab_delete_transaction',
    {
      description:
        'Delete a transaction. Requires transaction_id (from ynab_get_transactions). ' +
        'Returns the deleted transaction for confirmation.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        transaction_id: z.string().describe('The transaction to delete.'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.transactions.deleteTransaction(planId, args.transaction_id);
        return { deleted: true, ...mapTransaction(response.data.transaction) };
      })
  );

  server.registerTool(
    'ynab_import_transactions',
    {
      description:
        'Trigger an import of transactions from all linked (bank-connected) accounts. ' +
        'Equivalent to pressing "Import" in the YNAB app. ' +
        'Returns the IDs of newly imported transactions.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.transactions.importTransactions(planId);
        const ids = response.data.transaction_ids;
        return { imported_count: ids.length, transaction_ids: ids };
      })
  );
}
