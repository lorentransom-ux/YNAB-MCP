import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, ynabWrite, cachedFetch } from '../ynab.js';
import { toUSD, toMilliunits } from '../utils.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_accounts',
    {
      description: 'Get all accounts with current balances, types, and on-budget status.',
      inputSchema: {
        plan_id: z.string().optional().describe(
          'Budget/plan ID. Defaults to "last-used" (the most recently used budget).'
        ),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const response = await cachedFetch(
          `accounts:${planId}`,
          () => api.accounts.getAccounts(planId)
        );
        return response.data.accounts
          .filter((a) => !a.deleted)
          .map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            on_budget: a.on_budget,
            closed: a.closed,
            balance: toUSD(a.balance),
            cleared_balance: toUSD(a.cleared_balance),
            uncleared_balance: toUSD(a.uncleared_balance),
          }));
      })
  );

  server.registerTool(
    'ynab_create_account',
    {
      description:
        'Create a new unlinked (manually tracked) account with a starting balance. ' +
        'The YNAB API cannot create bank-linked accounts — those must be set up in the YNAB app. ' +
        'Returns the created account.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
        name: z.string().describe('The account name.'),
        type: z
          .enum(['checking', 'savings', 'cash', 'creditCard', 'otherAsset', 'otherLiability'])
          .describe('The account type.'),
        balance: z.number().describe(
          'Starting balance in dollars. Negative for debt (e.g. a credit card balance owed).'
        ),
      },
    },
    async (args) =>
      ynabWrite(args, async (api, planId) => {
        const response = await api.accounts.createAccount(planId, {
          account: {
            name: args.name,
            type: args.type,
            balance: toMilliunits(args.balance),
          },
        });
        const a = response.data.account;
        return {
          id: a.id,
          name: a.name,
          type: a.type,
          on_budget: a.on_budget,
          balance: toUSD(a.balance),
        };
      })
  );
}
