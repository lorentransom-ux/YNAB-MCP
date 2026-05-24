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
  phone: string;
  schedule: string;
  timezone: string;
  categories: string[];
  format: FormatOptions;
}

export interface SmsConfig {
  users: UserConfig[];
}

const DEFAULT_FORMAT: FormatOptions = {
  field: 'balance',
  showGoalProgress: false,
  headerNote: '',
};

export function getConfigPath(): string {
  if (process.env.SMS_CONFIG_PATH) return process.env.SMS_CONFIG_PATH;
  // Resolves to <project-root>/data/sms-config.json whether running from src/ or dist/
  return new URL('../data/sms-config.json', import.meta.url).pathname;
}

export function loadConfig(): SmsConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { users: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SmsConfig;
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

export function saveConfig(config: SmsConfig): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

export function seedConfigFromEnv(): void {
  const path = getConfigPath();
  if (existsSync(path)) return;

  const users: UserConfig[] = [];
  for (const prefix of ['USER1', 'USER2']) {
    const name = process.env[`${prefix}_NAME`];
    const phone = process.env[`${prefix}_PHONE`];
    const schedule = process.env[`${prefix}_SCHEDULE`];
    const categoriesRaw = process.env[`${prefix}_CATEGORIES`];
    const timezone = process.env[`${prefix}_TIMEZONE`] ?? 'America/Chicago';

    if (!name || !phone || !schedule || !categoriesRaw) continue;
    if (!cron.validate(schedule)) {
      console.warn(`[Config] Invalid cron expression for ${prefix}: "${schedule}" — skipping`);
      continue;
    }

    const categories = categoriesRaw.split(',').map((c) => c.trim()).filter(Boolean);
    if (categories.length === 0) continue;

    users.push({ name, phone, schedule, timezone, categories, format: { ...DEFAULT_FORMAT } });
  }

  if (users.length > 0) {
    saveConfig({ users });
    console.log(`[Config] Seeded from env vars for: ${users.map((u) => u.name).join(', ')}`);
  }
}
