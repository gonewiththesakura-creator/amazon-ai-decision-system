import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';

export type AppDatabase = DatabaseSync;

export function resolveDatabasePath(configuredPath?: string): string {
  const databasePath = configuredPath ?? process.env.DATABASE_PATH ?? './data/opportunity-intelligence.db';
  if (databasePath === ':memory:') return databasePath;
  return resolve(databasePath);
}

export function openDatabase(configuredPath?: string): AppDatabase {
  const databasePath = resolveDatabasePath(configuredPath);
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  if (databasePath !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  migrate(database);
  ensureSystemRows(database);
  return database;
}

function ensureSystemRows(database: AppDatabase): void {
  database.prepare(`
    INSERT OR IGNORE INTO app_settings (
      id, mode, role, marketplace, currency, timezone, default_market_id,
      ai_model, refresh_frequency, last_successful_sync
    ) VALUES (1, 'empty', 'admin', 'US', 'USD', 'Asia/Shanghai', '', ?, 'manual', NULL)
  `).run('rule-engine-v1');

  // The first release only ships the deterministic engine. Keep provenance truthful
  // even if an older local database stored a not-yet-supported external model name.
  database.prepare(`
    UPDATE app_settings SET ai_model = 'rule-engine-v1' WHERE ai_model <> 'rule-engine-v1'
  `).run();

  const sources = [
    ['source-mock', 'Mock Adapter', 'mock', 'connected', '{}', null, '显式标记的本地演示数据源'],
    ['source-sellersprite-import', 'SellerSprite Import', 'import', 'connected', '{}', null, '卖家精灵 CSV / XLSX 文件导入'],
    ['source-amazon-import', 'Amazon Report Import', 'amazon', 'connected', '{}', null, 'Amazon 报表文件导入'],
    ['source-sellersprite-mcp', 'SellerSprite MCP', 'mcp', 'needs_configuration', '{}', null, '卖家精灵 MCP 接口预留，需配置连接'],
  ] as const;

  const statement = database.prepare(`
    INSERT OR IGNORE INTO data_sources (
      id, name, type, status, config_json, last_sync_at, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const source of sources) statement.run(...source);

  seedRuleProfiles(database);
}

function seedRuleProfiles(database: AppDatabase): void {
  const definitions = [
    { filename: 'existing-market-v1.json', jobTypes: ['existing_market'] },
    { filename: 'owned-sku-relative-v1.json', jobTypes: ['owned_product'] },
    { filename: 'new-product-default-v1.json', jobTypes: ['adjacent_product', 'new_opportunity'] },
  ] as const;
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const insert = database.prepare(`
    INSERT OR IGNORE INTO rule_profiles (
      id, name, version, active, job_types_json, hard_gates_json,
      scoring_json, thresholds_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const definition of definitions) {
    const cwdPath = resolve(process.cwd(), 'rules', definition.filename);
    const filePath = existsSync(cwdPath)
      ? cwdPath
      : resolve(moduleRoot, 'rules', definition.filename);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string' || typeof parsed.version !== 'number') {
      throw new Error(`Invalid rule profile: ${definition.filename}`);
    }
    insert.run(
      parsed.id,
      parsed.name,
      parsed.version,
      parsed.active === false ? 0 : 1,
      JSON.stringify(definition.jobTypes),
      JSON.stringify(parsed.hardGates ?? {}),
      JSON.stringify(parsed.scoring ?? {}),
      JSON.stringify(parsed.thresholds ?? {}),
      new Date().toISOString(),
    );
    database.prepare(`
      UPDATE rule_profiles SET name = ?, active = ?, job_types_json = ?, hard_gates_json = ?,
        scoring_json = ?, thresholds_json = ?
      WHERE id = ? AND version = ? AND NOT EXISTS (
        SELECT 1 FROM research_jobs
        WHERE research_jobs.rule_profile_id = rule_profiles.id
          AND research_jobs.rule_profile_version = rule_profiles.version
      )
    `).run(
      parsed.name,
      parsed.active === false ? 0 : 1,
      JSON.stringify(definition.jobTypes),
      JSON.stringify(parsed.hardGates ?? {}),
      JSON.stringify(parsed.scoring ?? {}),
      JSON.stringify(parsed.thresholds ?? {}),
      parsed.id,
      parsed.version,
    );
  }
}

export function transaction<T>(database: AppDatabase, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
