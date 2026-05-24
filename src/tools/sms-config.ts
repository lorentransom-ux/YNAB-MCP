import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import cron from 'node-cron';
import { loadConfig, saveConfig } from '../config.js';
import { refreshUserSchedule } from '../scheduler.js';

function redactPhone(phone: string): string {
  return phone.length >= 4 ? `***-***-${phone.slice(-4)}` : '***';
}

export function registerSmsConfigTools(server: McpServer): void {
  server.registerTool(
    'ynab_get_sms_config',
    {
      description:
        'Returns the current SMS notification configuration for all users: ' +
        'categories, schedule, timezone, and message format options. ' +
        'Phone numbers are partially redacted.',
      inputSchema: {},
    },
    async () => {
      const config = loadConfig();

      if (config.users.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No SMS users are configured yet.' }],
        };
      }

      const display = config.users.map((u) => ({
        name: u.name,
        phone: redactPhone(u.phone),
        schedule: u.schedule,
        timezone: u.timezone,
        categories: u.categories,
        format: u.format,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(display, null, 2) }],
      };
    }
  );

  server.registerTool(
    'ynab_update_sms_config',
    {
      description:
        'Updates the SMS notification config for one user. Specify the user by name and include ' +
        'only the fields you want to change. Categories is a full replacement list. ' +
        'All changes including schedule updates take effect immediately.',
      inputSchema: {
        user: z.string().describe('Name of the user to update (case-insensitive)'),
        categories: z
          .array(z.string())
          .optional()
          .describe('Full replacement list of YNAB category names to include in the text'),
        schedule: z
          .string()
          .optional()
          .describe('Cron expression for when to send (e.g. "0 8 * * 1" = Monday 8am). Takes effect immediately.'),
        timezone: z
          .string()
          .optional()
          .describe('IANA timezone name (e.g. "America/Chicago", "America/New_York")'),
        format_field: z
          .enum(['balance', 'budgeted', 'activity'])
          .optional()
          .describe('Which amount to show per category: balance (remaining), budgeted, or activity (spent so far)'),
        show_goal_progress: z
          .boolean()
          .optional()
          .describe('Show goal progress percentage for categories that have a goal'),
        header_note: z
          .string()
          .optional()
          .describe('Optional custom note prepended to the message, or empty string to remove it'),
      },
    },
    async (args) => {
      const config = loadConfig();

      const userIndex = config.users.findIndex(
        (u) => u.name.toLowerCase() === args.user.toLowerCase()
      );

      if (userIndex === -1) {
        const names = config.users.map((u) => u.name).join(', ') || 'none';
        return {
          content: [
            {
              type: 'text' as const,
              text: `User "${args.user}" not found. Configured users: ${names}`,
            },
          ],
          isError: true as const,
        };
      }

      if (args.schedule !== undefined && !cron.validate(args.schedule)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron expression: "${args.schedule}". Example: "0 8 * * 1" for Monday 8am.`,
            },
          ],
          isError: true as const,
        };
      }

      if (args.timezone !== undefined) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: args.timezone });
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid timezone: "${args.timezone}". Use an IANA name like "America/Chicago".` }],
            isError: true as const,
          };
        }
      }

      const user = config.users[userIndex];
      const changes: string[] = [];

      if (args.categories !== undefined) {
        changes.push(`categories: [${args.categories.join(', ')}]`);
        user.categories = args.categories;
      }
      if (args.schedule !== undefined) {
        changes.push(`schedule: "${args.schedule}"`);
        user.schedule = args.schedule;
      }
      if (args.timezone !== undefined) {
        changes.push(`timezone: ${args.timezone}`);
        user.timezone = args.timezone;
      }
      if (args.format_field !== undefined) {
        changes.push(`format.field: ${args.format_field}`);
        user.format.field = args.format_field;
      }
      if (args.show_goal_progress !== undefined) {
        changes.push(`format.showGoalProgress: ${args.show_goal_progress}`);
        user.format.showGoalProgress = args.show_goal_progress;
      }
      if (args.header_note !== undefined) {
        changes.push(`format.headerNote: "${args.header_note}"`);
        user.format.headerNote = args.header_note;
      }

      if (changes.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No changes provided.' }],
        };
      }

      saveConfig(config);

      if (args.schedule !== undefined) {
        refreshUserSchedule(user.name);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Updated ${user.name}:\n${changes.map((c) => `  • ${c}`).join('\n')}`,
          },
        ],
      };
    }
  );
}
