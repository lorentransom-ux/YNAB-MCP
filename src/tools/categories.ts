import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Category, SaveCategoryResponse } from 'ynab';
import { ynabRead, ynabWrite, cachedFetch, ynabApiJson } from '../ynab.js';
import {
  toUSD,
  toMilliunits,
  buildGoalFields,
  resolveMonth,
  resolveCategoryQuery,
  dayOfMonthInTz,
} from '../utils.js';
import { loadConfig } from '../config.js';

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

// Cap on how many candidate names an ambiguous/no-match error lists.
const MAX_CANDIDATES = 10;

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
        'Get all category groups and their categories. This is a large response (every category); ' +
        'to read one category\'s budgeted amount, activity, or balance, use ynab_get_category instead. ' +
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
    'ynab_get_category',
    {
      description:
        'Get ONE category: budgeted, activity, balance, and goal info. Prefer this over ' +
        'ynab_get_categories whenever the question is about a single category (e.g. "how much is ' +
        'left in Eating Out?"). Pass a loosely worded name; emoji and capitalization are ignored and ' +
        'partial names work ("coffee" finds "Coffee Shops"). Categories split by day-of-month range ' +
        '(e.g. "Eating Out 1st–7th", "Eating Out 8th–15th") resolve to the split covering today; ' +
        'put a day number in the name ("eating out 10") or pass day to pick another split. The ' +
        'other splits are listed by name and ID in related_categories; call again with a ' +
        'category_id for their figures. If the name matches several unrelated ' +
        'categories, or none, the call fails with the candidate names and IDs so you can retry — ' +
        'it never guesses.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        name: z.string().optional().describe(
          'Category name, loosely worded (e.g. "eating out", "coffee", "groceries 8th"). ' +
          'Provide this or category_id.'
        ),
        category_id: z.string().optional().describe(
          'Exact category ID. Takes precedence over name when both are given.'
        ),
        month: z.string().optional().describe(
          'Month in YYYY-MM-01 format, or "current". Defaults to the current month.'
        ),
        day: z.number().int().min(1).max(31).optional().describe(
          'Day of month used to choose between day-range splits. Defaults to today.'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const name = args.name?.trim();
        if (!args.category_id && !name) {
          throw new Error('Provide either name or category_id.');
        }

        // The figures always come from YNAB's single-category endpoint:
        //   GET /plans/{plan_id}/categories/{category_id}                 (current month)
        //   GET /plans/{plan_id}/months/{month}/categories/{category_id}  (a given month)
        const resolvedMonth = args.month ? resolveMonth(args.month) : undefined;
        const fetchOne = async (categoryId: string): Promise<Category> => {
          const response = await cachedFetch(
            `category:${planId}:${resolvedMonth ?? 'current'}:${categoryId}`,
            () =>
              resolvedMonth
                ? api.categories.getMonthCategoryById(planId, resolvedMonth, categoryId)
                : api.categories.getCategoryById(planId, categoryId)
          );
          const category = response.data.category;
          if (category.deleted) {
            throw new Error(`Category ${categoryId} ("${category.name}") has been deleted.`);
          }
          return category;
        };

        // With an ID there is nothing to resolve: one call to the endpoint.
        if (args.category_id) {
          const c = await fetchOne(args.category_id);
          return { ...mapCategory(c, c.category_group_name), matched_by: 'category_id' };
        }

        // The endpoint takes an ID, not a name, so a name is first resolved to an
        // ID against the category list. The list is used ONLY for names and IDs.
        const listResponse = await cachedFetch(
          `categories:${planId}`,
          () => api.categories.getCategories(planId)
        );
        const rows = listResponse.data.category_groups.flatMap((g) =>
          g.categories.map((c) => ({
            id: c.id,
            name: c.name,
            hidden: c.hidden,
            deleted: c.deleted,
            groupName: g.name,
          }))
        );

        const describe = (list: { id: string; name: string }[]) =>
          list
            .slice(0, MAX_CANDIDATES)
            .map((c) => `"${c.name}" (id ${c.id})`)
            .join('; ') +
          (list.length > MAX_CANDIDATES ? `; and ${list.length - MAX_CANDIDATES} more` : '');

        const timeZone = loadConfig().users[0]?.timezone ?? 'UTC';
        const today = args.day ?? dayOfMonthInTz(timeZone);
        const result = resolveCategoryQuery(rows, name!, today);

        if (result.kind === 'none') {
          throw new Error(
            `No category matches "${name}".` +
              (result.suggestions.length > 0
                ? ` Closest: ${describe(result.suggestions)}. Retry with one of these names or IDs.`
                : ' Call ynab_get_category_groups or ynab_get_categories to see what exists.')
          );
        }
        if (result.kind === 'ambiguous') {
          throw new Error(
            `"${name}" matches ${result.candidates.length} categories: ${describe(result.candidates)}. ` +
              'Retry with a more specific name or a category_id.'
          );
        }

        const c = await fetchOne(result.category.id);
        return {
          ...mapCategory(c, c.category_group_name ?? result.category.groupName),
          matched_by: result.via,
          ...(result.via === 'day_range' && {
            selected_for_day: result.day,
            // Names and IDs only; call again with a category_id for another split's figures.
            related_categories: result.siblings.map((s) => ({ id: s.id, name: s.name })),
          }),
        };
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
