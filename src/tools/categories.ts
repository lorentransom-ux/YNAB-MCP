import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, ynabWrite, cachedFetch } from '../ynab.js';
import { toUSD, buildGoalFields, resolveMonth } from '../utils.js';
import type { Category } from 'ynab';

export function mapCategory(cat: Category, groupName?: string) {
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
    async (args) =>
      ynabRead(args, async (api, planId) => {
        if (args.month) {
          const resolvedMonth = resolveMonth(args.month);
          const response = await cachedFetch(
            `month:${planId}:${resolvedMonth}`,
            () => api.months.getPlanMonth(planId, resolvedMonth)
          );
          return response.data.month.categories
            .filter((c) => !c.deleted)
            .map((c) => mapCategory(c));
        }

        const response = await cachedFetch(
          `categories:${planId}`,
          () => api.categories.getCategories(planId)
        );
        return response.data.category_groups
          .filter((g) => !g.hidden)
          .flatMap((g) =>
            g.categories
              .filter((c) => !c.deleted)
              .map((c) => mapCategory(c, g.name))
          );
      })
  );

  server.registerTool(
    'ynab_update_category',
    {
      description:
        'Update a category\'s name, note, or category group. ' +
        'Only the provided fields are changed. This does NOT change budgeted amounts — ' +
        'use ynab_set_category_budget for that. Returns the updated category.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        category_id: z.string().describe('The category to update (from ynab_get_categories).'),
        name: z.string().optional().describe('New category name.'),
        note: z.string().optional().describe('New category note.'),
        category_group_id: z.string().optional().describe('Move the category to a different category group.'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.categories.updateCategory(planId, args.category_id, {
          category: {
            ...(args.name !== undefined && { name: args.name }),
            ...(args.note !== undefined && { note: args.note }),
            ...(args.category_group_id !== undefined && { category_group_id: args.category_group_id }),
          },
        });
        return mapCategory(response.data.category);
      })
  );
}
