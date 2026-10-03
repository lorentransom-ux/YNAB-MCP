import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MoneyMovement } from 'ynab';
import { ynabRead, cachedFetch } from '../ynab.js';
import { toUSD, daysAgo, resolveMonth, compact, DEFAULT_SINCE_DAYS } from '../utils.js';

export function registerMovementTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_money_transfers',
    {
      description:
        'Get transfers between ACCOUNTS: transactions where funds move from one account to another ' +
        '(e.g. checking to savings, or a credit card payment). For money moved between CATEGORIES ' +
        'or to/from Ready to Assign, use ynab_get_category_money_movements instead. ' +
        'Includes flag_color and flag_name. ' +
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
            flag_color: t.flag_color ?? null,
            flag_name: t.flag_name ?? null,
          }));
      })
  );

  server.registerTool(
    'ynab_get_category_money_movements',
    {
      description:
        'Get money moved between CATEGORIES, or between a category and Ready to Assign, in the ' +
        'budget (YNAB "money movements"). Each movement has the amount, the from and to category ' +
        'names, when it was moved, and any note. Defaults to the current month; pass month for ' +
        'another month, or month="all" for the whole history (can be large). Set grouped=true to ' +
        'nest movements under the single action that made them (e.g. one "cover overspending" ' +
        'that moved money from several categories). For transfers between ACCOUNTS, use ' +
        'ynab_get_money_transfers instead.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        month: z.string().optional().describe(
          'Month in YYYY-MM-01 format, "current" (default), or "all" for every month.'
        ),
        grouped: z.boolean().optional().describe(
          'When true, nest movements under their money movement group. Defaults to false.'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const all = args.month === 'all';
        const month = all ? undefined : resolveMonth(args.month ?? 'current');

        // GET /plans/{id}/money_movements  or  /plans/{id}/months/{month}/money_movements
        const movementsResponse = await cachedFetch(
          `money_movements:${planId}:${month ?? 'all'}`,
          () =>
            month
              ? api.money_movements.getMoneyMovementsByMonth(planId, month)
              : api.money_movements.getMoneyMovements(planId)
        );
        const movements = movementsResponse.data.money_movements;

        // The API returns category IDs only; resolve them to names here.
        const categoriesResponse = await cachedFetch(
          `categories:${planId}`,
          () => api.categories.getCategories(planId)
        );
        const names = new Map<string, string>();
        for (const g of categoriesResponse.data.category_groups) {
          for (const c of g.categories) names.set(c.id, c.name);
        }
        // A missing side is Ready to Assign; an ID with no matching category is
        // reported as such rather than dropped.
        const label = (id: string | null | undefined): string =>
          id == null ? 'Ready to Assign' : names.get(id) ?? `Unknown category (id ${id})`;

        const mapMovement = (m: MoneyMovement, withGroupId: boolean) =>
          compact({
            id: m.id,
            month: m.month,
            moved_at: m.moved_at,
            amount: toUSD(m.amount),
            from: label(m.from_category_id),
            to: label(m.to_category_id),
            note: m.note,
            ...(withGroupId && { group_id: m.money_movement_group_id }),
          });

        if (!args.grouped) {
          return {
            month: month ?? 'all',
            count: movements.length,
            money_movements: movements.map((m) => mapMovement(m, true)),
          };
        }

        // GET /plans/{id}/money_movement_groups  or  /plans/{id}/months/{month}/money_movement_groups
        const groupsResponse = await cachedFetch(
          `money_movement_groups:${planId}:${month ?? 'all'}`,
          () =>
            month
              ? api.money_movements.getMoneyMovementGroupsByMonth(planId, month)
              : api.money_movements.getMoneyMovementGroups(planId)
        );
        const groups = groupsResponse.data.money_movement_groups;
        const known = new Set(groups.map((g) => g.id));
        // Movements with no group, or whose group the API did not return, are kept.
        const ungrouped = movements.filter(
          (m) => m.money_movement_group_id == null || !known.has(m.money_movement_group_id)
        );
        return {
          month: month ?? 'all',
          count: movements.length,
          groups: groups.map((g) =>
            compact({
              group_id: g.id,
              created_at: g.group_created_at,
              month: g.month,
              note: g.note,
              money_movements: movements
                .filter((m) => m.money_movement_group_id === g.id)
                .map((m) => mapMovement(m, false)),
            })
          ),
          ...(ungrouped.length > 0 && {
            ungrouped: ungrouped.map((m) => mapMovement(m, true)),
          }),
        };
      })
  );
}
