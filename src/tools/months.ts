import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getYnabClient, withYnabErrorHandling } from '../ynab.js';
import { toUSD, resolveMonth, buildGoalFields } from '../utils.js';
import type { Category } from 'ynab';

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
    async (args) => {
      return withYnabErrorHandling(async () => {
        const api = getYnabClient();
        const planId = args.plan_id ?? 'last-used';
        const response = await api.months.getPlanMonths(planId);
        const months = response.data.months.map((m) => ({
          month: m.month,
          note: m.note ?? null,
          income: toUSD(m.income),
          budgeted: toUSD(m.budgeted),
          activity: toUSD(m.activity),
          to_be_budgeted: toUSD(m.to_be_budgeted),
          age_of_money: m.age_of_money ?? null,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(months, null, 2) }] };
      });
    }
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
    async (args) => {
      return withYnabErrorHandling(async () => {
        const api = getYnabClient();
        const planId = args.plan_id ?? 'last-used';
        const resolvedMonth = resolveMonth(args.month);
        const response = await api.months.getPlanMonth(planId, resolvedMonth);
        const m = response.data.month;

        const detail = {
          month: m.month,
          note: m.note ?? null,
          income: toUSD(m.income),
          budgeted: toUSD(m.budgeted),
          activity: toUSD(m.activity),
          to_be_budgeted: toUSD(m.to_be_budgeted),
          age_of_money: m.age_of_money ?? null,
          categories: m.categories
            .filter((c: Category) => !c.deleted)
            .map((c: Category) => ({
              id: c.id,
              name: c.name,
              category_group_id: c.category_group_id,
              hidden: c.hidden,
              budgeted: toUSD(c.budgeted),
              activity: toUSD(c.activity),
              balance: toUSD(c.balance),
              note: c.note ?? null,
              ...buildGoalFields(c),
            })),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }] };
      });
    }
  );
}
