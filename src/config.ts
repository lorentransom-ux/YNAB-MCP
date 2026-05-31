import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import cron from 'node-cron';

export interface FormatOptions {
  field: 'balance' | 'budgeted' | 'activity';
  showGoalProgress: boolean;
  headerNote: string;
}

export interface UserConfig {
  name: string;
  schedule: string;
  timezone: string;
  categories: string[];
  format: FormatOptions;
  // Numeric Telegram chat ID — how this user receives their scheduled digest and is
  // authorized for chat. Optional so a user can be configured before their chat ID is
  // known (discover it from the unrecognized-chat log line, then add it).
  telegramChatId?: number;
}

export interface AppConfig {
  users: UserConfig[];
}

const DEFAULT_FORMAT: FormatOptions = {
  field: 'balance',
  showGoalProgress: false,
  headerNote: '',
};

export function getConfigPath(): string {
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  // Resolves to <project-root>/data/config.json whether running from src/ or dist/
  return new URL('../data/config.json', import.meta.url).pathname;
}

export function loadConfig(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { users: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as AppConfig;
    if (!Array.isArray(parsed?.users)) {
      console.error('[Config] Config file missing "users" array — falling back to empty config');
      return { users: [] };
    }
    return parsed;
  } catch (err) {
    console.error('[Config] Failed to parse config file:', err instanceof Error ? err.message : err);
    return { users: [] };
  }
}

export function saveConfig(config: AppConfig): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

export interface ConfigUpdate {
  categories?: string[];
  schedule?: string;
  timezone?: string;
  format_field?: FormatOptions['field'];
  show_goal_progress?: boolean;
  header_note?: string;
}

// Validates and persists a partial update to one user's digest settings, identified
// by name. Returns the list of human-readable changes applied, or an error string.
// Does not touch the cron scheduler — callers refresh the schedule if it changed.
export function applyConfigUpdate(
  userName: string,
  update: ConfigUpdate
): { changes: string[] } | { error: string } {
  const config = loadConfig();
  const user = config.users.find((u) => u.name.toLowerCase() === userName.toLowerCase());
  if (!user) {
    const names = config.users.map((u) => u.name).join(', ') || 'none';
    return { error: `User "${userName}" not found. Configured users: ${names}` };
  }

  if (update.schedule !== undefined && !cron.validate(update.schedule)) {
    return { error: `Invalid cron expression: "${update.schedule}". Example: "0 8 * * 1" for Monday 8am.` };
  }
  if (update.timezone !== undefined) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: update.timezone });
    } catch {
      return { error: `Invalid timezone: "${update.timezone}". Use an IANA name like "America/Chicago".` };
    }
  }

  const changes: string[] = [];
  if (update.categories !== undefined) {
    changes.push(`categories: [${update.categories.join(', ')}]`);
    user.categories = update.categories;
  }
  if (update.schedule !== undefined) {
    changes.push(`schedule: "${update.schedule}"`);
    user.schedule = update.schedule;
  }
  if (update.timezone !== undefined) {
    changes.push(`timezone: ${update.timezone}`);
    user.timezone = update.timezone;
  }
  if (update.format_field !== undefined) {
    changes.push(`amount shown: ${update.format_field}`);
    user.format.field = update.format_field;
  }
  if (update.show_goal_progress !== undefined) {
    changes.push(`goal progress: ${update.show_goal_progress ? 'on' : 'off'}`);
    user.format.showGoalProgress = update.show_goal_progress;
  }
  if (update.header_note !== undefined) {
    changes.push(`header note: "${update.header_note}"`);
    user.format.headerNote = update.header_note;
  }

  if (changes.length === 0) return { changes };

  saveConfig(config);
  return { changes };
}

export function seedConfigFromEnv(): void {
  const path = getConfigPath();
  if (existsSync(path)) return;

  const users: UserConfig[] = [];
  for (const prefix of ['USER1', 'USER2']) {
    const name = process.env[`${prefix}_NAME`];
    const schedule = process.env[`${prefix}_SCHEDULE`];
    const categoriesRaw = process.env[`${prefix}_CATEGORIES`];
    const timezone = process.env[`${prefix}_TIMEZONE`] ?? 'America/Chicago';

    if (!name || !schedule || !categoriesRaw) continue;
    if (!cron.validate(schedule)) {
      console.warn(`[Config] Invalid cron expression for ${prefix}: "${schedule}" — skipping`);
      continue;
    }

    const categories = categoriesRaw.split(',').map((c) => c.trim()).filter(Boolean);
    if (categories.length === 0) continue;

    const user: UserConfig = { name, schedule, timezone, categories, format: { ...DEFAULT_FORMAT } };

    const telegramIdRaw = process.env[`${prefix}_TELEGRAM_ID`];
    if (telegramIdRaw) {
      const telegramChatId = Number(telegramIdRaw);
      if (Number.isInteger(telegramChatId)) user.telegramChatId = telegramChatId;
      else console.warn(`[Config] Invalid ${prefix}_TELEGRAM_ID: "${telegramIdRaw}" — ignoring`);
    }

    users.push(user);
  }

  if (users.length > 0) {
    saveConfig({ users });
    console.log(`[Config] Seeded from env vars for: ${users.map((u) => u.name).join(', ')}`);
  }
}
