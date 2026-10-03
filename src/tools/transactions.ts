import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, ynabWrite, cachedFetch } from '../ynab.js';
import { toUSD, toMilliunits, daysAgo, resolveMonth, compact, DEFAULT_SINCE_DAYS } from '../utils.js';
import type {
  TransactionDetail,
  HybridTransaction,
  ExistingTransaction,
  SaveTransactionWithIdOrImportId,
  Payee,
} from 'ynab';

// Shared enums for transaction write tools, matching the YNAB API's values.
const clearedSchema = z.enum(['cleared', 'uncleared', 'reconciled']);
const flagColorSchema = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
const transactionTypeSchema = z.enum(['uncategorized', 'unapproved']);

// Most transactions one ynab_update_transactions call will send to YNAB.
const MAX_BULK_UPDATES = 100;

const AMOUNT_DESC =
  'Amount in dollars. Negative for outflows/spending (e.g. -12.34), positive for inflows.';

// Some MCP clients keep an old copy of a tool's schema after the server changes
// it. A client that does not know a field is an array sends it as a JSON string,
// which would otherwise fail with "Expected array, received string". Accept that
// form too. The published schema is still an array, and a string that is not
// valid JSON still fails validation.
function jsonArray<T extends z.ZodTypeAny>(array: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, array);
}

const splitLineSchema = z.object({
  amount: z.number().describe(AMOUNT_DESC),
  category_id: z.string().describe(
    'Category ID for this split line (from ynab_get_category).'
  ),
  memo: z.string().optional().describe('Optional memo on this split line.'),
});

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
    flag_name: t.flag_name ?? null,
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
        'A full month can be a large response; to keep it small, pass type ("unapproved" or ' +
        '"uncategorized") to get only the transactions that still need attention, or use ' +
        'ynab_get_transactions_by_category / _by_payee / _by_account. ' +
        'Pass month to get one budget month. ' +
        `When neither month nor since_date is given, only the last ${DEFAULT_SINCE_DAYS} days are returned; ` +
        'pass an explicit since_date to reach further back.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        month: z.string().optional().describe(
          'Return only this budget month: YYYY-MM-01 format, or "current". ' +
          'since_date and until_date can narrow it further.'
        ),
        type: transactionTypeSchema.optional().describe(
          'Return only "unapproved" or only "uncategorized" transactions.'
        ),
        since_date: z.string().optional().describe(
          'Return only transactions on or after this date (YYYY-MM-DD). ' +
          `Defaults to ${DEFAULT_SINCE_DAYS} days ago when month is not given.`
        ),
        until_date: z.string().optional().describe(
          'Return only transactions on or before this date (YYYY-MM-DD).'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const keep = (t: TransactionDetail) =>
          !t.deleted && (!args.until_date || t.date <= args.until_date);

        if (args.month) {
          // GET /plans/{id}/months/{month}/transactions
          const month = resolveMonth(args.month);
          const response = await cachedFetch(
            `transactions_month:${planId}:${month}:${args.since_date ?? ''}:${args.until_date ?? ''}:${args.type ?? ''}`,
            () =>
              api.transactions.getTransactionsByMonth(
                planId,
                month,
                args.since_date,
                args.until_date,
                args.type
              )
          );
          return response.data.transactions.filter(keep).map(mapTransaction);
        }

        const sinceDate = args.since_date ?? daysAgo(DEFAULT_SINCE_DAYS);
        if (args.type) {
          const response = await cachedFetch(
            `transactions:${planId}:${sinceDate}:${args.until_date ?? ''}:${args.type}`,
            () => api.transactions.getTransactions(planId, sinceDate, args.until_date, args.type)
          );
          return response.data.transactions.filter(keep).map(mapTransaction);
        }

        const response = await cachedFetch(
          `transactions:${planId}:${sinceDate}`,
          () => api.transactions.getTransactions(planId, sinceDate)
        );
        return response.data.transactions.filter(keep).map(mapTransaction);
      })
  );

  server.registerTool(
    'ynab_get_transaction',
    {
      description:
        'Get ONE transaction by ID, with its account, payee, and category IDs. Use it to follow ' +
        'an ID another tool returned: the other side of a transfer (transfer_transaction_id), the ' +
        'parent of a split line, or a transaction you just created or updated.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        transaction_id: z.string().describe('The transaction ID.'),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        // GET /plans/{id}/transactions/{transaction_id}
        const response = await api.transactions.getTransactionById(planId, args.transaction_id);
        const t = response.data.transaction;
        return {
          ...mapTransaction(t),
          ...compact({
            deleted: t.deleted ? true : undefined,
            account_id: t.account_id,
            payee_id: t.payee_id,
            category_id: t.category_id,
            transfer_transaction_id: t.transfer_transaction_id,
            matched_transaction_id: t.matched_transaction_id,
          }),
        };
      })
  );

  server.registerTool(
    'ynab_get_transactions_by_account',
    {
      description:
        'Get transactions filtered to a specific account. ' +
        'Requires account_id. If you only have an account name, call ynab_get_accounts first ' +
        'to look up the account ID from the account name. Includes flag_color, flag_name, ' +
        'and subtransactions on splits. ' +
        `When since_date is omitted, only the last ${DEFAULT_SINCE_DAYS} days are returned; ` +
        'pass an explicit since_date to reach further back.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        account_id: z.string().describe('The account ID to filter transactions by.'),
        since_date: z.string().optional().describe(
          'Return only transactions on or after this date (YYYY-MM-DD). ' +
          `Defaults to ${DEFAULT_SINCE_DAYS} days ago when omitted.`
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const sinceDate = args.since_date ?? daysAgo(DEFAULT_SINCE_DAYS);
        const response = await cachedFetch(
          `transactions:account:${planId}:${args.account_id}:${sinceDate}`,
          () => api.transactions.getTransactionsByAccount(planId, args.account_id, sinceDate)
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
        'Split transactions that include this category are returned with their subtransactions. ' +
        `When since_date is omitted, only the last ${DEFAULT_SINCE_DAYS} days are returned; ` +
        'pass an explicit since_date to reach further back.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        category_id: z.string().describe('The category ID to filter transactions by.'),
        since_date: z.string().optional().describe(
          'Return only transactions on or after this date (YYYY-MM-DD). ' +
          `Defaults to ${DEFAULT_SINCE_DAYS} days ago when omitted.`
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const sinceDate = args.since_date ?? daysAgo(DEFAULT_SINCE_DAYS);
        const response = await cachedFetch(
          `transactions:category:${planId}:${args.category_id}:${sinceDate}`,
          () => api.transactions.getTransactionsByCategory(planId, args.category_id, sinceDate)
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
        'and subtransactions on splits. ' +
        `When since_date is omitted, only the last ${DEFAULT_SINCE_DAYS} days are returned; ` +
        'pass an explicit since_date to reach further back.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        payee_id: z.string().describe('The payee ID to filter transactions by.'),
        since_date: z.string().optional().describe(
          'Return only transactions on or after this date (YYYY-MM-DD). ' +
          `Defaults to ${DEFAULT_SINCE_DAYS} days ago when omitted.`
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const sinceDate = args.since_date ?? daysAgo(DEFAULT_SINCE_DAYS);
        const response = await cachedFetch(
          `transactions:payee:${planId}:${args.payee_id}:${sinceDate}`,
          () => api.transactions.getTransactionsByPayee(planId, args.payee_id, sinceDate)
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
        'category_id. Line amounts must add up to amount. To split a transaction that already ' +
        'exists, use ynab_update_transaction with subtransactions instead of creating a new ' +
        'one. New transactions are approved unless approved is false. Returns the created transaction including flag_color, flag_name, and ' +
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
          'Category ID (from ynab_get_category). Omit for transfers, splits, and to leave a transaction uncategorized.'
        ),
        subtransactions: jsonArray(z.array(splitLineSchema)).optional().describe(
          'Split lines for a multi-category transaction. Omit category_id on the parent. At least two lines; amounts must sum to amount.'
        ),
        memo: z.string().optional().describe('Optional memo.'),
        cleared: clearedSchema.optional().describe('Cleared status. Defaults to "uncleared".'),
        approved: z.boolean().optional().describe('Whether the transaction is approved. Defaults to true: the server approves a new transaction unless you pass false.'),
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

        // YNAB records a transfer as a transaction whose payee is the destination
        // account's transfer payee, carrying no category. Resolve that here so the
        // caller can pass either the transfer_payee_id or a "Transfer : X" name.
        let isTransfer = false;
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
            isTransfer = true;
          } else if (payeeId) {
            isTransfer = Boolean(payees.find((p) => p.id === payeeId)?.transfer_account_id);
          }
          if (isTransfer) {
            payeeName = undefined;
            categoryId = undefined;
          }
        }

        if (isTransfer && splits?.length) {
          throw new Error(
            'A transfer cannot also be split across categories. ' +
              'Create a regular (non-transfer) transaction with subtransactions instead.'
          );
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
            // YNAB leaves a transaction unapproved when this is omitted. A transaction
            // entered through this tool was dictated by its owner, so approve it by
            // default, as the YNAB app does for manual entries.
            approved: args.approved ?? true,
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
        'To turn an UNSPLIT transaction into a split across categories, pass subtransactions ' +
        '(at least two lines, each with amount and category_id, adding up to the transaction ' +
        'amount) and omit category_id. A transaction that is ALREADY a split cannot have its ' +
        'lines changed through the YNAB API; edit that in the YNAB app. If YNAB does not ' +
        'apply the split, the call fails and says so. Returns the updated transaction ' +
        'including flag_color, flag_name, and subtransactions when split.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        transaction_id: z.string().describe('The transaction to update.'),
        account_id: z.string().optional().describe('Move the transaction to a different account.'),
        date: z.string().optional().describe('New date (YYYY-MM-DD).'),
        amount: z.number().optional().describe(AMOUNT_DESC),
        payee_id: z.string().optional().describe('New payee ID.'),
        payee_name: z.string().optional().describe('New payee name. Matched to an existing payee or created.'),
        category_id: z.string().optional().describe('New category ID (from ynab_get_category). Cannot change the category of an existing split. Omit when passing subtransactions.'),
        subtransactions: jsonArray(z.array(splitLineSchema)).optional().describe(
          'Split lines that turn an unsplit transaction into a split. At least two lines; amounts ' +
          'must add up to the transaction amount (same sign). Not allowed on a transaction that is already split.'
        ),
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
        const splits = args.subtransactions;
        if (!splits?.length) {
          const response = await api.transactions.updateTransaction(
            planId,
            args.transaction_id,
            { transaction }
          );
          return mapTransaction(response.data.transaction);
        }

        // --- Turning an unsplit transaction into a split ---
        if (args.category_id) {
          throw new Error(
            'Omit category_id when splitting. Each split line has its own category_id. Nothing was changed.'
          );
        }
        // Read the transaction first: to refuse an existing split before calling
        // YNAB (the API rejects changes to existing split lines), to check the lines
        // against the real amount, and to know the category to restore if needed.
        const current = (await api.transactions.getTransactionById(planId, args.transaction_id))
          .data.transaction;
        if (current.deleted) {
          throw new Error(`Transaction ${args.transaction_id} has been deleted. Nothing was changed.`);
        }
        if ((current.subtransactions ?? []).some((line) => !line.deleted)) {
          throw new Error(
            `Transaction ${args.transaction_id} is already a split. The YNAB API cannot change ` +
              'the lines of an existing split; edit it in the YNAB app. Nothing was changed.'
          );
        }
        const total = args.amount ?? current.amount / 1000;
        const lines = buildSplitLines(total, splits); // throws if the lines do not add up

        const response = await api.transactions.updateTransaction(planId, args.transaction_id, {
          transaction: {
            ...transaction,
            // The spec's instruction for a split: null category on the parent.
            category_id: null as unknown as string,
            subtransactions: lines,
          },
        });
        const updated = response.data.transaction;
        const applied = (updated.subtransactions ?? []).filter((line) => !line.deleted);
        if (applied.length !== lines.length) {
          // YNAB accepted the request but did not split it. The parent's category may
          // have been cleared by the request, so put the original back and say so.
          let restore = 'The transaction had no category before, so there was nothing to restore.';
          if (current.category_id) {
            try {
              await api.transactions.updateTransaction(planId, args.transaction_id, {
                transaction: { category_id: current.category_id },
              });
              restore = `Its original category (${current.category_name ?? current.category_id}) was put back.`;
            } catch {
              restore =
                `Its original category (${current.category_name ?? current.category_id}, id ` +
                `${current.category_id}) could NOT be put back; set it with ynab_update_transaction.`;
            }
          }
          throw new Error(
            `YNAB accepted the update but did not split transaction ${args.transaction_id}: ` +
              `expected ${lines.length} split lines, got ${applied.length}. ${restore} ` +
              'Other fields sent in this call may have been applied; check with ynab_get_transaction.'
          );
        }
        return mapTransaction(updated);
      })
  );

  server.registerTool(
    'ynab_update_transactions',
    {
      description:
        'Update SEVERAL existing transactions in one call (e.g. approve, recategorize, or re-memo ' +
        'a batch while reconciling). Each item needs transaction_id plus at least one field to ' +
        'change; only the provided fields are changed. For a single transaction use ' +
        `ynab_update_transaction. At most ${MAX_BULK_UPDATES} per call. Cannot add splits here; to split ` +
        'one transaction use ynab_update_transaction with subtransactions. ' +
        'Fails with the list of IDs if YNAB does not confirm every transaction. ' +
        'Returns the updated transactions.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        transactions: jsonArray(
          z
            .array(
              z.object({
                transaction_id: z.string().describe('The transaction to update.'),
                account_id: z.string().optional().describe('Move the transaction to a different account.'),
                date: z.string().optional().describe('New date (YYYY-MM-DD).'),
                amount: z.number().optional().describe(AMOUNT_DESC),
                payee_id: z.string().optional().describe('New payee ID.'),
                payee_name: z.string().optional().describe('New payee name. Matched to an existing payee or created.'),
                category_id: z.string().optional().describe('New category ID. Cannot change the category of an existing split.'),
                memo: z.string().optional().describe('New memo.'),
                cleared: clearedSchema.optional().describe('New cleared status.'),
                approved: z.boolean().optional().describe('Set true to approve.'),
                flag_color: flagColorSchema.optional().describe('New flag color.'),
              })
            )
            .min(1)
            .max(MAX_BULK_UPDATES)
        )
          .describe('The transactions to update.'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const ids = args.transactions.map((t) => t.transaction_id);
        const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (repeated.length > 0) {
          throw new Error(
            `transaction_id listed more than once: ${[...new Set(repeated)].join(', ')}. Nothing was updated.`
          );
        }

        const transactions: SaveTransactionWithIdOrImportId[] = args.transactions.map((t) => {
          const fields = {
            ...(t.account_id !== undefined && { account_id: t.account_id }),
            ...(t.date !== undefined && { date: t.date }),
            ...(t.amount !== undefined && { amount: toMilliunits(t.amount) }),
            ...(t.payee_id !== undefined && { payee_id: t.payee_id }),
            ...(t.payee_name !== undefined && { payee_name: t.payee_name }),
            ...(t.category_id !== undefined && { category_id: t.category_id }),
            ...(t.memo !== undefined && { memo: t.memo }),
            ...(t.cleared !== undefined && { cleared: t.cleared }),
            ...(t.approved !== undefined && { approved: t.approved }),
            ...(t.flag_color !== undefined && { flag_color: t.flag_color }),
          };
          if (Object.keys(fields).length === 0) {
            throw new Error(
              `Transaction ${t.transaction_id} has no fields to change. Nothing was updated.`
            );
          }
          return { id: t.transaction_id, ...fields };
        });

        // PATCH /plans/{id}/transactions
        const response = await api.transactions.updateTransactions(planId, { transactions });

        // Confirm YNAB reported every requested transaction as saved.
        const saved = new Set(response.data.transaction_ids);
        const missing = ids.filter((id) => !saved.has(id));
        if (missing.length > 0) {
          throw new Error(
            `YNAB confirmed ${ids.length - missing.length} of ${ids.length} updates. ` +
              `NOT confirmed: ${missing.join(', ')}. The confirmed ones were saved; ` +
              'check the unconfirmed IDs with ynab_get_transaction.'
          );
        }

        const returned = response.data.transactions ?? [];
        return {
          updated: ids.length,
          transactions: returned.map((t) => compact(mapTransaction(t))),
        };
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
