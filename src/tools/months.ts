import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getYnabClient, withYnabErrorHandling, cachedFetch } from '../ynab.js';
import { toUSD, resolveMonth } from '../utils.js';
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
    async (args) => {
      return withYnabErrorHandling(async () => {
        const api = getYnabClient();
        const planId = args.plan_id ?? 'last-used';
        const response = await cachedFetch(
          `months:${planId}`,
          () => api.months.getPlanMonths(planId)
        );
        const months = response.data.months.map((m) => ({
          month: m.month,
          note: m.note ?? null,
          income: toUSD(m.income),
          budgeted: toUSD(m.budgeted),
          activity: toUSD(m.activity),
          to_be_budgeted: toUSD(m.to_be_budgeted),
          age_of_money: m.age_of_money ?? null,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(months) }] };
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
        const response = await cachedFetch(
          `month:${planId}:${resolvedMonth}`,
          () => api.months.getPlanMonth(planId, resolvedMonth)
        );
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
            .filter((c) => !c.deleted)
            .map((c) => mapCategory(c)),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(detail) }] };
      });
    }
  );
}
