import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, ynabWrite, cachedFetch } from '../ynab.js';
import { toUSD, toMilliunits, resolveMonth } from '../utils.js';
import { mapCategory } from './categories.js';

export function registerMonthTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_months',
    {
      description:
        'List all budget months available, with income, budgeted, and activity totals. ' +
        'Useful for determining the available date range before querying specific months.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const response = await cachedFetch(
          `months:${planId}`,
          () => api.months.getPlanMonths(planId)
        );
        return response.data.months.map((m) => ({
          month: m.month,
          note: m.note ?? null,
          income: toUSD(m.income),
          budgeted: toUSD(m.budgeted),
          activity: toUSD(m.activity),
          to_be_budgeted: toUSD(m.to_be_budgeted),
          age_of_money: m.age_of_money ?? null,
        }));
      })
  );

  server.registerTool(
    'ynab_get_month_detail',
    {
      description:
        'Get the full category breakdown for a specific budget month, including ' +
        'budgeted, activity, and balance for each category plus goal information.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        month: z.string().describe(
          'Month in YYYY-MM-01 format, or "current" for the current month.'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const resolvedMonth = resolveMonth(args.month);
        const response = await cachedFetch(
          `month:${planId}:${resolvedMonth}`,
          () => api.months.getPlanMonth(planId, resolvedMonth)
        );
        const m = response.data.month;

        return {
          month: m.month,
          note: m.note ?? null,
          income: toUSD(m.income),
          budgeted: toUSD(m.budgeted),
          activity: toUSD(m.activity),
          to_be_budgeted: toUSD(m.to_be_budgeted),
          age_of_money: m.age_of_money ?? null,
          categories: m.categories
            .filter((c) => !c.deleted)
            .map((c) => mapCategory(c)),
        };
      })
  );

  server.registerTool(
    'ynab_set_category_budget',
    {
      description:
        'Set the budgeted (assigned) amount for a category in a specific month. ' +
        'This sets the absolute assigned amount, not a delta. ' +
        'To move money between categories, call this twice: decrease one category and ' +
        'increase the other (read current amounts with ynab_get_month_detail first). ' +
        'Returns the updated category with its new budgeted amount and balance.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        month: z.string().describe('Month in YYYY-MM-01 format, or "current" for the current month.'),
        category_id: z.string().describe('The category to assign money to (from ynab_get_categories).'),
        budgeted: z.number().describe(
          'The total amount to assign for the month, in dollars (e.g. 250 or 250.50). ' +
          'Replaces the current assigned amount.'
        ),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.categories.updateMonthCategory(
          planId,
          resolveMonth(args.month),
          args.category_id,
          { category: { budgeted: toMilliunits(args.budgeted) } }
        );
        return mapCategory(response.data.category);
      })
  );
}
