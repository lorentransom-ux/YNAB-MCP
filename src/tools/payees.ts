import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ynabRead, cachedFetch } from '../ynab.js';

export function registerPayeeTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_payees',
    {
      description:
        'Get all payees with their IDs and names. ' +
        'Use this to resolve payee names to IDs before calling ynab_get_transactions_by_payee.',
      inputSchema: {
        plan_id: z.string().optional().describe('Budget/plan ID. Defaults to "last-used".'),
      },
    },
    async (args) =>
      ynabRead(args, async (api, planId) => {
        const response = await cachedFetch(
          `payees:${planId}`,
          () => api.payees.getPayees(planId)
        );
        return response.data.payees
          .filter((p) => !p.deleted)
          .map((p) => ({
            id: p.id,
            name: p.name,
            transfer_account_id: p.transfer_account_id ?? null,
          }));
      })
  );
}
