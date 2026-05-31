import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPlanTools } from './tools/plans.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerCategoryTools } from './tools/categories.js';
import { registerMonthTools } from './tools/months.js';
import { registerTransactionTools } from './tools/transactions.js';
import { registerPayeeTools } from './tools/payees.js';
import { registerScheduledTools } from './tools/scheduled.js';
import { registerMovementTools } from './tools/movements.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'ynab-mcp', version: '1.0.0' });
  registerPlanTools(server);
  registerAccountTools(server);
  registerCategoryTools(server);
  registerMonthTools(server);
  registerTransactionTools(server);
  registerPayeeTools(server);
  registerScheduledTools(server);
  registerMovementTools(server);
  return server;
}
