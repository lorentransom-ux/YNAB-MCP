import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getYnabClient, withYnabErrorHandling, cachedFetch } from '../ynab.js';

export function registerPlanTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_plans',
    {
      description: 'List all YNAB budgets (plans) with their IDs and names.',
    },
    async () => {
      return withYnabErrorHandling(async () => {
        const api = getYnabClient();
        const response = await cachedFetch('plans', () => api.plans.getPlans());
        const plans = response.data.plans.map((p) => ({
          id: p.id,
          name: p.name,
          last_modified_on: p.last_modified_on,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(plans) }] };
      });
    }
  );
}
