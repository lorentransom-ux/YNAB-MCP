import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MoneyMovement } from 'ynab';
import { ynabRead, cachedFetch } from '../ynab.js';
import {
  toUSD,
  daysAgo,
  resolveMonth,
  compact,
  matchCategoriesByWords,
  DEFAULT_SINCE_DAYS,
} from '../utils.js';
import { loadConfig } from '../config.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
        'names, when it was moved, any note, and the group_id of the action that made it (movements ' +
        'sharing a group_id were made together; no group_id means it was moved on its own). A whole month can be over a hundred movements, ' +
        'so pass category whenever the question is about one category (e.g. "where did Eating ' +
        'Out get its money?"): only movements into or out of it are returned. category is a ' +
        'loose name; "eating out" covers every "Eating Out ..." split, and "ready to assign" ' +
        'works too. IMPORTANT: month is the BUDGET month the money belongs to, not when the move ' +
        'was made; October\'s budget is often funded in September. To ask what was moved ON ' +
        'certain dates, pass moved_since and/or moved_until; with those and no month, every ' +
        'budget month is searched so nothing is missed. Without date filters, month defaults to ' +
        'the current budget month; month="all" is the whole history. The response always reports ' +
        'total_in_period (movements before any filter) next to count (movements returned) and ' +
        'action_count (distinct actions: each group counts once). Set grouped=true to nest movements under the single action that ' +
        'made them (e.g. one assignment that funded several categories). For transfers between ' +
        'ACCOUNTS, use ynab_get_money_transfers instead.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        category: z.string().optional().describe(
          'Return only movements into or out of this category. Loose name (emoji and ' +
          'capitalization ignored, partial names work), or "ready to assign".'
        ),
        month: z.string().optional().describe(
          'BUDGET month in YYYY-MM-01 format, "current", or "all" for every month. Defaults to ' +
          '"current", or to "all" when moved_since or moved_until is given.'
        ),
        moved_since: z.string().optional().describe(
          'Return only movements made on or after this date (YYYY-MM-DD, in the budget owner\'s timezone).'
        ),
        moved_until: z.string().optional().describe(
          'Return only movements made on or before this date (YYYY-MM-DD, in the budget owner\'s timezone).'
        ),
        grouped: z.boolean().optional().describe(
          'When true, nest movements under their money movement group. Defaults to false.'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        for (const [key, value] of [
          ['moved_since', args.moved_since],
          ['moved_until', args.moved_until],
        ] as const) {
          if (value !== undefined && !ISO_DATE.test(value)) {
            throw new Error(`${key} must be a date in YYYY-MM-DD format; got "${value}".`);
          }
        }
        if (args.moved_since && args.moved_until && args.moved_since > args.moved_until) {
          throw new Error(
            `moved_since (${args.moved_since}) is after moved_until (${args.moved_until}).`
          );
        }
        const byDate = args.moved_since !== undefined || args.moved_until !== undefined;

        // A move made on a given date can belong to any budget month (next month is
        // often funded early), so a date filter with no month searches every month.
        const all = args.month === 'all' || (args.month === undefined && byDate);
        const month = all ? undefined : resolveMonth(args.month ?? 'current');

        // GET /plans/{id}/money_movements  or  /plans/{id}/months/{month}/money_movements
        const movementsResponse = await cachedFetch(
          `money_movements:${planId}:${month ?? 'all'}`,
          () =>
            month
              ? api.money_movements.getMoneyMovementsByMonth(planId, month)
              : api.money_movements.getMoneyMovements(planId)
        );
        let movements = movementsResponse.data.money_movements;
        const totalInPeriod = movements.length;

        // The API returns category IDs only; resolve them to names here.
        const categoriesResponse = await cachedFetch(
          `categories:${planId}`,
          () => api.categories.getCategories(planId)
        );
        const categories = categoriesResponse.data.category_groups.flatMap((g) => g.categories);
        const names = new Map(categories.map((c) => [c.id, c.name]));
        // A missing side is Ready to Assign; an ID with no matching category is
        // reported as such rather than dropped.
        const label = (id: string | null | undefined): string =>
          id == null ? 'Ready to Assign' : names.get(id) ?? `Unknown category (id ${id})`;

        // Optional filter: keep only movements touching the named category.
        let matched: string[] | undefined;
        const wanted = args.category?.trim();
        if (wanted) {
          if (/^(ready\s+to\s+assign|rta)$/i.test(wanted)) {
            matched = ['Ready to Assign'];
            movements = movements.filter(
              (m) => m.from_category_id == null || m.to_category_id == null
            );
          } else {
            const hits = matchCategoriesByWords(categories, wanted);
            if (hits.length === 0) {
              throw new Error(
                `No category matches "${wanted}". Use ynab_get_category to find the category name, ` +
                  'or omit category to see every movement.'
              );
            }
            const ids = new Set(hits.map((c) => c.id));
            matched = hits.map((c) => c.name);
            movements = movements.filter(
              (m) =>
                (m.from_category_id != null && ids.has(m.from_category_id)) ||
                (m.to_category_id != null && ids.has(m.to_category_id))
            );
          }
        }

        // Optional filter: keep only movements made within a date range. moved_at is
        // a UTC timestamp; compare its calendar date in the budget owner's timezone
        // so an evening move is not counted on the next day.
        const timeZone = loadConfig().users[0]?.timezone ?? 'UTC';
        if (byDate) {
          const localDate = (iso: string | undefined): string | undefined => {
            if (!iso) return undefined;
            const d = new Date(iso);
            return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString('en-CA', { timeZone });
          };
          movements = movements.filter((m) => {
            const d = localDate(m.moved_at);
            // A movement with no usable timestamp cannot be placed in a date range.
            if (!d) return false;
            return (
              (!args.moved_since || d >= args.moved_since) &&
              (!args.moved_until || d <= args.moved_until)
            );
          });
        }

        // The month is stated once at the top unless the request spans every month.
        // The movement's own ID is omitted because no tool or endpoint takes it.
        // group_id is kept in full so it is never ambiguous which movements were
        // made together: on each row in the flat list, on each group when grouped.
        const mapMovement = (m: MoneyMovement, withGroupId: boolean) =>
          compact({
            ...(all && { month: m.month }),
            moved_at: m.moved_at,
            amount: toUSD(m.amount),
            from: label(m.from_category_id),
            to: label(m.to_category_id),
            note: m.note || undefined,
            ...(withGroupId && { group_id: m.money_movement_group_id }),
          });

        // Distinct actions: every group counts once, every ungrouped movement once.
        const groupIds = new Set<string>();
        let singles = 0;
        for (const m of movements) {
          if (m.money_movement_group_id) groupIds.add(m.money_movement_group_id);
          else singles++;
        }

        const header = {
          budget_month: month ?? 'all',
          ...(matched && { category_filter: matched }),
          ...(byDate && {
            moved_since: args.moved_since,
            moved_until: args.moved_until,
            dates_in_timezone: timeZone,
          }),
          // Always shown, so a filtered answer never hides how much it left out.
          total_in_period: totalInPeriod,
          count: movements.length,
          action_count: groupIds.size + singles,
        };

        if (!args.grouped) {
          return { ...header, money_movements: movements.map((m) => mapMovement(m, true)) };
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
          ...header,
          groups: groups
            .map((g) => ({
              g,
              members: movements.filter((m) => m.money_movement_group_id === g.id),
            }))
            // With a category filter, groups left with no movements are omitted.
            .filter(({ members }) => members.length > 0)
            .map(({ g, members }) =>
              compact({
                group_id: g.id,
                created_at: g.group_created_at,
                ...(all && { month: g.month }),
                note: g.note || undefined,
                money_movements: members.map((m) => mapMovement(m, false)),
              })
            ),
          ...(ungrouped.length > 0 && {
            ungrouped: ungrouped.map((m) => mapMovement(m, true)),
          }),
        };
      })
  );
}
