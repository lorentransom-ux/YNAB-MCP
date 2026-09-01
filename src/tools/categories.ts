import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Category, SaveCategoryResponse } from 'ynab';
import { ynabRead, ynabWrite, cachedFetch, ynabApiJson } from '../ynab.js';
import { toUSD, toMilliunits, buildGoalFields, resolveMonth } from '../utils.js';

const GOAL_FREQUENCY = ['monthly', 'weekly', 'yearly'] as const;
type GoalFrequency = (typeof GOAL_FREQUENCY)[number];

// Spec 1.86.0 SaveCategory, including nullable clears and goal_frequency.
// The ynab 4.1.0 SDK types omit null and drop goal_frequency on serialize.
type CategoryWritePayload = {
  name?: string | null;
  note?: string | null;
  category_group_id?: string;
  goal_target?: number | null;
  goal_target_date?: string | null;
  goal_needs_whole_amount?: boolean | null;
  goal_frequency?: GoalFrequency;
};

const goalFrequencySchema = z
  .enum(GOAL_FREQUENCY)
  .optional()
  .describe(
    'When specified, configures a recurring NEED target of goal_target that repeats at this ' +
      'frequency (monthly, weekly, or yearly), replacing any existing target. Requires goal_target. ' +
      'Cannot be combined with goal_target_date. Not supported for Credit Card Payment categories.'
  );

const goalTargetCreateSchema = z
  .number()
  .optional()
  .describe(
    'Goal target amount in dollars (converted to milliunits). If specified and the category has no ' +
      'goal yet, a monthly NEED goal is created (MF for Credit Card Payment categories).'
  );

const goalTargetUpdateSchema = z
  .number()
  .nullable()
  .optional()
  .describe(
    'Goal target amount in dollars (converted to milliunits). If specified and the category has no ' +
      'goal yet, a monthly NEED goal is created (MF for Credit Card Payment categories). ' +
      'Pass null to remove an existing target.'
  );

const goalTargetDateCreateSchema = z
  .string()
  .optional()
  .describe(
    'Goal target date in ISO format (e.g. 2016-12-01). Cannot be combined with goal_frequency.'
  );

const goalTargetDateUpdateSchema = z
  .string()
  .nullable()
  .optional()
  .describe(
    'Goal target date in ISO format (e.g. 2016-12-01). Cannot be combined with goal_frequency. ' +
      'Pass null to clear it.'
  );

const goalNeedsWholeCreateSchema = z
  .boolean()
  .optional()
  .describe(
    'Only supported for NEED goals. true = "Set aside another..."; false = "Refill up to...".'
  );

const goalNeedsWholeUpdateSchema = z
  .boolean()
  .nullable()
  .optional()
  .describe(
    'Only supported for NEED goals. true = "Set aside another..."; false = "Refill up to...". ' +
      'Pass null to clear it.'
  );

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

function mapCategoryGroup(g: { id: string; name: string; hidden: boolean }) {
  return { id: g.id, name: g.name, hidden: g.hidden };
}

type GoalWriteArgs = {
  goal_target?: number | null;
  goal_target_date?: string | null;
  goal_needs_whole_amount?: boolean | null;
  goal_frequency?: GoalFrequency;
};

function assertGoalWriteRules(args: GoalWriteArgs): void {
  if (args.goal_frequency === undefined) return;
  if (args.goal_target == null) {
    throw new Error('goal_frequency requires goal_target.');
  }
  if (args.goal_target_date != null) {
    throw new Error('goal_frequency cannot be combined with goal_target_date.');
  }
}

function goalTargetMilliunits(value: number | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return toMilliunits(value);
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
    'ynab_get_category_groups',
    {
      description:
        'List category groups with their IDs, names, and hidden status. ' +
        'Use this to get a category_group_id for ynab_create_category or ' +
        'ynab_update_category_group. Unlike ynab_get_categories, this also returns groups ' +
        'that are hidden or that contain no categories yet — including one you just created.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const response = await cachedFetch(
          `categories:${planId}`,
          () => api.categories.getCategories(planId)
        );
        return response.data.category_groups
          .filter((g) => !g.deleted)
          .map(mapCategoryGroup);
      })
  );

  server.registerTool(
    'ynab_create_category',
    {
      description:
        'Create a new category in a category group. Required: name and category_group_id ' +
        '(from ynab_get_categories or ynab_create_category_group). Optionally set a goal ' +
        'target (goal_target, goal_target_date, goal_needs_whole_amount, goal_frequency). ' +
        'goal_frequency requires goal_target, cannot be combined with goal_target_date, and ' +
        'is not supported for Credit Card Payment categories. This does NOT assign budgeted ' +
        'amounts — use ynab_set_category_budget for that. Returns the created category.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        name: z.string().describe('The category name.'),
        category_group_id: z.string().describe(
          'The category group to put this category in. An internal category group may not be specified.'
        ),
        note: z.string().optional().describe('Optional category note.'),
        goal_target: goalTargetCreateSchema,
        goal_target_date: goalTargetDateCreateSchema,
        goal_needs_whole_amount: goalNeedsWholeCreateSchema,
        goal_frequency: goalFrequencySchema,
      },
    },
    async (args) =>
      ynabWrite(args, async (_api, planId) => {
        assertGoalWriteRules(args);
        const category: CategoryWritePayload = {
          name: args.name,
          category_group_id: args.category_group_id,
          ...(args.note !== undefined && { note: args.note }),
          ...(args.goal_target !== undefined && { goal_target: toMilliunits(args.goal_target) }),
          ...(args.goal_target_date !== undefined && { goal_target_date: args.goal_target_date }),
          ...(args.goal_needs_whole_amount !== undefined && {
            goal_needs_whole_amount: args.goal_needs_whole_amount,
          }),
          ...(args.goal_frequency !== undefined && { goal_frequency: args.goal_frequency }),
        };
        const response = await ynabApiJson<SaveCategoryResponse>(
          'POST',
          `/plans/${encodeURIComponent(planId)}/categories`,
          { category }
        );
        return mapCategory(response.data.category);
      })
  );

  server.registerTool(
    'ynab_update_category',
    {
      description:
        'Update a category\'s name, note, category group, or goal target fields. ' +
        'Only the provided fields are changed. This does NOT change budgeted amounts — ' +
        'use ynab_set_category_budget for that. Goal writes set or remove the category\'s ' +
        'target (goal_target, goal_target_date, goal_needs_whole_amount, goal_frequency); ' +
        'they are not the same as assigning money. goal_frequency requires goal_target, ' +
        'cannot be combined with goal_target_date, and is not supported for Credit Card ' +
        'Payment categories. Returns the updated category.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        category_id: z.string().describe('The category to update (from ynab_get_categories).'),
        name: z.string().optional().describe('New category name.'),
        note: z.string().nullable().optional().describe('New category note. Pass null to clear it.'),
        category_group_id: z.string().optional().describe('Move the category to a different category group.'),
        goal_target: goalTargetUpdateSchema,
        goal_target_date: goalTargetDateUpdateSchema,
        goal_needs_whole_amount: goalNeedsWholeUpdateSchema,
        goal_frequency: goalFrequencySchema,
      },
    },
    async (args) =>
      ynabWrite(args, async (_api, planId) => {
        assertGoalWriteRules(args);
        const goalTarget = goalTargetMilliunits(args.goal_target);
        const category: CategoryWritePayload = {
          ...(args.name !== undefined && { name: args.name }),
          ...(args.note !== undefined && { note: args.note }),
          ...(args.category_group_id !== undefined && { category_group_id: args.category_group_id }),
          ...(goalTarget !== undefined && { goal_target: goalTarget }),
          ...(args.goal_target_date !== undefined && { goal_target_date: args.goal_target_date }),
          ...(args.goal_needs_whole_amount !== undefined && {
            goal_needs_whole_amount: args.goal_needs_whole_amount,
          }),
          ...(args.goal_frequency !== undefined && { goal_frequency: args.goal_frequency }),
        };
        const response = await ynabApiJson<SaveCategoryResponse>(
          'PATCH',
          `/plans/${encodeURIComponent(planId)}/categories/${encodeURIComponent(args.category_id)}`,
          { category }
        );
        return mapCategory(response.data.category);
      })
  );

  server.registerTool(
    'ynab_create_category_group',
    {
      description:
        'Create a new category group. The name must be at most 50 characters. ' +
        'Returns the created category group (id, name, hidden).',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        name: z.string().max(50).describe('The category group name (max 50 characters).'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.categories.createCategoryGroup(planId, {
          category_group: { name: args.name },
        });
        return mapCategoryGroup(response.data.category_group);
      })
  );

  server.registerTool(
    'ynab_update_category_group',
    {
      description:
        'Rename a category group. The name must be at most 50 characters. ' +
        'Returns the updated category group (id, name, hidden).',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        category_group_id: z.string().describe('The category group to update (from ynab_get_categories).'),
        name: z.string().max(50).describe('The new category group name (max 50 characters).'),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.categories.updateCategoryGroup(planId, args.category_group_id, {
          category_group: { name: args.name },
        });
        return mapCategoryGroup(response.data.category_group);
      })
  );
}
