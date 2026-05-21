import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getYnabClient, withYnabErrorHandling } from '../ynab.js';
import { toUSD, buildGoalFields, resolveMonth } from '../utils.js';
import type { Category } from 'ynab';

function mapCategory(cat: Category, groupName?: string) {
  return {
    id: cat.id,
    name: cat.name,
    ...(groupName !== undefined && { category_group_name: groupName }),
    category_group_id: cat.category_group_id,
    hidden: cat.hidden,
    budgeted: toUSD(cat.budgeted),
    activity: toUSD(cat.activity),
    balance: toUSD(cat.balance),
    note: cat.note ?? null,
    ...buildGoalFields(cat),
  };
}

export function registerCategoryTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_categories',
    {
      description:
        'Get all category groups and their categories. ' +
        'Accepts an optional month param (YYYY-MM-01 or "current") to return data for that month. ' +
        'Includes budgeted, activity, and balance amounts, plus goal information for each category.',
      inputSchema: {
        plan_id: z.string().optional().describe(
          'Budget/plan ID. Defaults to "last-used".'
        ),
        month: z.string().optional().describe(
          'Month in YYYY-MM-01 format, or "current" for the current month. ' +
          'When provided, returns category data for that specific month.'
        ),
      },
    },
    async (args) => {
      return withYnabErrorHandling(async () => {
        const api = getYnabClient();
        const planId = args.plan_id ?? 'last-used';

        let categories: ReturnType<typeof mapCategory>[];

        if (args.month) {
          const resolvedMonth = resolveMonth(args.month);
          const response = await api.months.getPlanMonth(planId, resolvedMonth);
          categories = response.data.month.categories
            .filter((c) => !c.deleted)
            .map((c) => mapCategory(c));
        } else {
          const response = await api.categories.getCategories(planId);
          categories = response.data.category_groups
            .filter((g) => !g.hidden)
            .flatMap((g) =>
              g.categories
                .filter((c) => !c.deleted)
                .map((c) => mapCategory(c, g.name))
            );
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(categories, null, 2) }] };
      });
    }
  );
}
