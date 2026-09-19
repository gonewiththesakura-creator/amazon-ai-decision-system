import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from './database.js';
import { migrate } from './migrations.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function testDatabase(): AppDatabase {
  database = openDatabase(':memory:');
  return database;
}

function v13Database(): AppDatabase {
  database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE research_jobs (
      id TEXT PRIMARY KEY,
      data_version TEXT NOT NULL,
      rule_profile_id TEXT NOT NULL,
      rule_profile_version INTEGER NOT NULL,
      prompt_version TEXT NOT NULL
    );
    CREATE TABLE reverse_reviews (
      id TEXT PRIMARY KEY,
      research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL,
      top_failure_modes_json TEXT NOT NULL,
      unknowns_json TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      decided_by TEXT,
      reason TEXT,
      decided_at TEXT
    );
  `);
  const appliedAt = new Date().toISOString();
  const insertMigration = database.prepare(`
    INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
  `);
  for (let version = 1; version <= 13; version += 1) insertMigration.run(version, appliedAt);
  // This deliberately minimal fixture isolates the V14 backfill and does not
  // reproduce the application tables needed by later migrations.
  for (let version = 15; version <= 19; version += 1) insertMigration.run(version, appliedAt);
  return database;
}

function insertResearchJob(
  db: AppDatabase,
  id: string,
  dataVersion: string,
  entityType = 'market',
  entityId = 'migration-market',
): string {
  const profile = db.prepare(`
    SELECT id, version FROM rule_profiles WHERE active = 1 ORDER BY version DESC LIMIT 1
  `).get() as { id: string; version: number };
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO research_jobs (
      id, name, job_type, marketplace, status, entity_type, entity_id,
      rule_profile_id, rule_profile_version, rule_profile_snapshot_json,
      input_json, task_book_json, is_demo, created_by, data_version,
      prompt_version, created_at, updated_at
    ) VALUES (?, 'Migration fixture', 'existing_market', 'US', 'calculating',
      ?, ?, ?, ?, '{}', '{}', '{}', 0, 'test', ?,
      'test-prompt-v1', ?, ?)
  `).run(id, entityType, entityId, profile.id, profile.version, dataVersion, now, now);
  return profile.id;
}

function restoreV15DevelopmentProjects(db: AppDatabase): void {
  const triggerSql = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'trg_decisions_%'
    ORDER BY name
  `).all().map((row) => String((row as { sql: unknown }).sql));
  db.exec(`
    DROP TRIGGER IF EXISTS trg_decisions_complete_workflow_lineage;
    DROP TRIGGER IF EXISTS trg_decisions_v2_entity_requires_lineage;
    CREATE TABLE development_projects_v15 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      product_type TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      marketplace TEXT NOT NULL,
      supply_chain_relation TEXT NOT NULL DEFAULT '',
      market_node_id TEXT REFERENCES market_nodes(id),
      market_size REAL NOT NULL DEFAULT 0,
      growth_30d REAL NOT NULL DEFAULT 0,
      competition_score REAL NOT NULL DEFAULT 0,
      opportunity_score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('develop', 'test', 'watch', 'reject')),
      score_breakdown_json TEXT NOT NULL,
      insight_id TEXT REFERENCES ai_insights(id),
      source_opportunity_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO development_projects_v15 SELECT * FROM development_projects;
    DROP TABLE development_projects;
    ALTER TABLE development_projects_v15 RENAME TO development_projects;
  `);
  for (const sql of triggerSql) db.exec(sql);
  db.prepare('DELETE FROM schema_migrations WHERE version IN (16, 17)').run();
}

describe('database migrations', () => {
  it('applies the complete migration chain with a valid schema', () => {
    const db = testDatabase();
    const versions = db.prepare(`
      SELECT version FROM schema_migrations ORDER BY version
    `).all() as Array<{ version: number }>;

    expect(versions.map((row) => Number(row.version))).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' });
  });

  it('upgrades V19 observations without losing master or workflow records', () => {
    const db = new DatabaseSync(':memory:');
    database = db;
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE app_settings (id INTEGER PRIMARY KEY, mode TEXT NOT NULL);
      CREATE TABLE market_nodes (id TEXT PRIMARY KEY, marketplace TEXT NOT NULL);
      CREATE TABLE products (
        id TEXT PRIMARY KEY, asin TEXT NOT NULL, sku TEXT, brand TEXT NOT NULL,
        title TEXT NOT NULL, image_url TEXT NOT NULL, marketplace TEXT NOT NULL,
        product_type TEXT NOT NULL, is_owned INTEGER NOT NULL, market_node_id TEXT NOT NULL,
        source_type TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE market_snapshots (
        id TEXT PRIMARY KEY, market_node_id TEXT NOT NULL, date TEXT NOT NULL,
        product_count INTEGER NOT NULL, seller_count INTEGER NOT NULL, brand_count INTEGER NOT NULL,
        monthly_sales REAL NOT NULL, monthly_revenue REAL NOT NULL, avg_price REAL NOT NULL,
        median_price REAL NOT NULL, avg_rating REAL NOT NULL, median_reviews REAL NOT NULL,
        top10_share REAL NOT NULL DEFAULT 0, top20_share REAL NOT NULL DEFAULT 0,
        new_product_share REAL NOT NULL DEFAULT 0, price_bands_json TEXT NOT NULL DEFAULT '[]',
        concentration_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL, source_type TEXT NOT NULL, collected_at TEXT NOT NULL,
        period TEXT NOT NULL, is_estimated INTEGER NOT NULL, confidence REAL NOT NULL
      );
      CREATE TABLE product_snapshots (
        id TEXT PRIMARY KEY, product_id TEXT NOT NULL, date TEXT NOT NULL,
        price REAL NOT NULL, rating REAL NOT NULL, review_count INTEGER NOT NULL,
        bsr INTEGER NOT NULL, estimated_sales REAL NOT NULL, estimated_revenue REAL NOT NULL,
        seller_count INTEGER NOT NULL, growth_7d REAL NOT NULL DEFAULT 0,
        growth_30d REAL NOT NULL DEFAULT 0, growth_90d REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL, source_type TEXT NOT NULL,
        collected_at TEXT NOT NULL, period TEXT NOT NULL, is_estimated INTEGER NOT NULL,
        confidence REAL NOT NULL
      );
      CREATE TABLE rule_profiles (id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE decisions (id TEXT PRIMARY KEY, decision TEXT NOT NULL);
    `);
    const appliedAt = '2026-09-19T00:00:00.000Z';
    const migration = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
    for (let version = 1; version <= 19; version += 1) migration.run(version, appliedAt);
    db.prepare("INSERT INTO app_settings (id, mode) VALUES (1, 'demo')").run();
    db.prepare("INSERT INTO market_nodes (id, marketplace) VALUES ('market-us', 'US')").run();
    db.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at
      ) VALUES ('legacy-product', 'B0LEGACY01', 'LEGACY-01', 'Legacy', 'Legacy title', '',
        'US', 'pillow', 1, 'market-us', 'import', ?)
    `).run(appliedAt);
    db.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, source, source_type, collected_at, period,
        is_estimated, confidence
      ) VALUES ('legacy-observation', 'legacy-product', '2026-09-01', 30, 4.4, 12, 100,
        20, 600, 1, 'SellerSprite import', 'import', ?, '30D', 1, 0.8)
    `).run(appliedAt);
    db.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, source, source_type, collected_at, period,
        is_estimated, confidence
      ) VALUES ('legacy-observation-duplicate', 'legacy-product', '2026-09-01', 30, 4.4, 12, 100,
        20, 600, 1, 'SellerSprite import', 'import', ?, '30D', 1, 0.8)
    `).run(appliedAt);
    db.prepare("INSERT INTO rule_profiles (id, version) VALUES ('legacy-rule', 1)").run();
    db.prepare("INSERT INTO decisions (id, decision) VALUES ('legacy-decision', 'watch')").run();

    migrate(db);

    const productColumns = db.prepare('PRAGMA table_info(products)').all()
      .map((column) => String((column as { name: unknown }).name));
    const snapshotColumns = db.prepare('PRAGMA table_info(product_snapshots)').all()
      .map((column) => String((column as { name: unknown }).name));
    expect(productColumns).toEqual(expect.arrayContaining([
      'status', 'updated_at', 'variation_family_id', 'parent_asin', 'is_parent', 'variation_attributes_json',
    ]));
    expect(snapshotColumns).toEqual(expect.arrayContaining(['observation_date', 'dedup_key']));
    expect(db.prepare(`
      SELECT observation_date, dedup_key FROM product_snapshots WHERE id = 'legacy-observation'
    `).get()).toMatchObject({ observation_date: '2026-09-01' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count, COUNT(DISTINCT dedup_key) AS unique_count
      FROM product_snapshots WHERE product_id = 'legacy-product'
    `).get()).toEqual({ count: 2, unique_count: 2 });
    expect(db.prepare("SELECT id FROM products WHERE id = 'legacy-product'").get()).toMatchObject({ id: 'legacy-product' });
    expect(db.prepare("SELECT id FROM rule_profiles WHERE id = 'legacy-rule'").get()).toMatchObject({ id: 'legacy-rule' });
    expect(db.prepare("SELECT id FROM decisions WHERE id = 'legacy-decision'").get()).toMatchObject({ id: 'legacy-decision' });
    for (const table of [
      'variation_families', 'provider_capability_snapshots', 'mcp_call_logs', 'mcp_response_cache',
      'competitor_candidates', 'data_coverage_runs', 'metric_facts',
    ]) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table))
        .toMatchObject({ name: table });
    }
    expect(db.prepare('PRAGMA table_info(mcp_call_logs)').all()
      .map((column) => String((column as { name: unknown }).name)))
      .toEqual(expect.arrayContaining([
        'provider_id', 'actual_tool', 'parameter_hash', 'research_job_id', 'entity_type', 'entity_id',
        'started_at', 'completed_at', 'duration_ms', 'status', 'cache_hit', 'result_count', 'error_code',
      ]));
    expect(() => db.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('duplicate-observation', 'legacy-product', '2026-09-01', 30, 4.4, 12, 100,
        20, 600, 1, 'SellerSprite import', 'import', ?, '30D', 1, 0.8,
        '2026-09-01', (SELECT dedup_key FROM product_snapshots WHERE id = 'legacy-observation'))
    `).run(appliedAt)).toThrow(/UNIQUE/);
  });

  it('backfills immutable Reverse Review and Approval lineage when upgrading from V13', () => {
    const db = v13Database();
    db.prepare(`
      INSERT INTO research_jobs (
        id, data_version, rule_profile_id, rule_profile_version, prompt_version
      ) VALUES ('lineage-job', 'workflow-lineage-v4', 'profile-lineage', 4, 'prompt-lineage-v2')
    `).run();
    const insertReview = db.prepare(`
      INSERT INTO reverse_reviews (
        id, research_job_id, verdict, top_failure_modes_json,
        unknowns_json, recommendation, created_at
      ) VALUES (?, 'lineage-job', 'proceed_with_caution', '[]', '[]', 'review', ?)
    `);
    insertReview.run('review-before-approval', '2026-09-10T08:00:00.000Z');
    insertReview.run('review-after-approval', '2026-09-10T10:00:00.000Z');
    db.prepare(`
      INSERT INTO approvals (
        id, research_job_id, action, status, requested_by, requested_at
      ) VALUES (
        'lineage-approval', 'lineage-job', 'approve next validation',
        'pending', 'migration fixture', '2026-09-10T09:00:00.000Z'
      )
    `).run();

    migrate(db);

    const reviews = db.prepare(`
      SELECT data_version, rule_profile_id, rule_profile_version, prompt_version
      FROM reverse_reviews ORDER BY created_at
    `).all();
    expect(reviews).toEqual([
      {
        data_version: 'workflow-lineage-v4',
        rule_profile_id: 'profile-lineage',
        rule_profile_version: 4,
        prompt_version: 'prompt-lineage-v2',
      },
      {
        data_version: 'workflow-lineage-v4',
        rule_profile_id: 'profile-lineage',
        rule_profile_version: 4,
        prompt_version: 'prompt-lineage-v2',
      },
    ]);
    expect(db.prepare(`
      SELECT data_version, rule_profile_id, rule_profile_version,
        prompt_version, reverse_review_id
      FROM approvals WHERE id = 'lineage-approval'
    `).get()).toEqual({
      data_version: 'workflow-lineage-v4',
      rule_profile_id: 'profile-lineage',
      rule_profile_version: 4,
      prompt_version: 'prompt-lineage-v2',
      reverse_review_id: 'review-before-approval',
    });
    expect(db.prepare(`SELECT version FROM schema_migrations WHERE version = 14`).get())
      .toMatchObject({ version: 14 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('backfills pre-versioned workflow artifacts for databases already on V12', () => {
    const db = testDatabase();
    const jobId = randomUUID();
    const dataVersion = 'migration-current-v3';
    const profileId = insertResearchJob(db, jobId, dataVersion);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO evidence_records (
        id, research_job_id, claim, metric_name, metric_value_json, source,
        collected_at, calculation, confidence, created_at
      ) VALUES ('migration-evidence', ?, 'Legacy evidence', 'growth', '12',
        'legacy import', ?, 'legacy calculation', 0.8, ?)
    `).run(jobId, now, now);
    db.prepare(`
      INSERT INTO review_insights (
        id, research_job_id, issue, frequency, competitors_affected,
        is_cross_market_issue, supply_chain_solvable, cost_impact,
        opportunity_level, evidence_ids_json, created_at
      ) VALUES ('migration-review', ?, 'Legacy issue', 0.4, 3, 1, 1,
        'low', 'medium', '["migration-evidence"]', ?)
    `).run(jobId, now);
    db.prepare(`
      INSERT INTO rule_executions (
        id, research_job_id, rule_profile_id, rule_version, input_json,
        output_json, hard_gate_status, score, created_at
      ) VALUES ('migration-execution', ?, ?, 1, '{}', '{}', 'pass', 72, ?)
    `).run(jobId, profileId, now);

    expect(db.prepare(`
      SELECT data_version FROM rule_executions WHERE id = 'migration-execution'
    `).get()).toMatchObject({ data_version: 'legacy-v1' });

    db.prepare('DELETE FROM schema_migrations WHERE version = 13').run();
    migrate(db);

    for (const table of ['evidence_records', 'review_insights', 'rule_executions']) {
      expect(db.prepare(`SELECT data_version FROM ${table} WHERE research_job_id = ?`).get(jobId))
        .toMatchObject({ data_version: dataVersion });
    }
  });

  it('allows appending snapshots but rejects overwriting an existing observation', () => {
    const db = testDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO market_nodes (
        id, name, level, marketplace, status, source_type, created_at
      ) VALUES ('migration-market', 'Migration Market', 1, 'US', 'active', 'import', ?)
    `).run(now);
    const insert = db.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count,
        monthly_sales, monthly_revenue, avg_price, median_price, avg_rating,
        median_reviews, source, source_type, collected_at, period,
        is_estimated, confidence
      ) VALUES (?, 'migration-market', ?, 10, 8, 6, 100, 3000, 30, 29,
        4.3, 50, 'migration test', 'import', ?, 'daily', 0, 0.9)
    `);
    insert.run('migration-snapshot-1', '2026-08-01', now);
    insert.run('migration-snapshot-2', '2026-09-01', now);
    db.prepare(`
      INSERT INTO products (
        id, asin, sku, brand, title, image_url, marketplace, product_type,
        is_owned, market_node_id, source_type, created_at
      ) VALUES ('migration-product', 'B0MIGRATION', 'MIGRATION-1', 'Migration',
        'Migration Product', '', 'US', 'test', 1, 'migration-market', 'import', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr,
        estimated_sales, estimated_revenue, seller_count, source, source_type,
        collected_at, period, is_estimated, confidence
      ) VALUES ('migration-product-snapshot', 'migration-product', '2026-09-01',
        30, 4.3, 50, 1000, 100, 3000, 1, 'migration test', 'import', ?,
        'daily', 0, 0.9)
    `).run(now);
    db.prepare(`
      INSERT INTO keywords (id, marketplace, market_node_id, keyword, source, created_at)
      VALUES ('migration-keyword', 'US', 'migration-market', 'migration keyword',
        'migration test', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO keyword_snapshots (
        id, keyword_id, date, search_volume, trend, source_metadata_json, created_at
      ) VALUES ('migration-keyword-snapshot', 'migration-keyword', '2026-09-01',
        500, 0.2, '{}', ?)
    `).run(now);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM market_snapshots WHERE market_node_id = 'migration-market'
    `).get()).toMatchObject({ count: 2 });
    expect(() => db.prepare(`
      UPDATE market_snapshots SET monthly_sales = 999 WHERE id = 'migration-snapshot-1'
    `).run()).toThrow(/immutable/);
    expect(db.prepare(`
      SELECT monthly_sales FROM market_snapshots WHERE id = 'migration-snapshot-1'
    `).get()).toMatchObject({ monthly_sales: 100 });
    expect(() => db.prepare(`
      UPDATE product_snapshots SET estimated_sales = 999
      WHERE id = 'migration-product-snapshot'
    `).run()).toThrow(/immutable/);
    expect(() => db.prepare(`
      UPDATE keyword_snapshots SET search_volume = 999
      WHERE id = 'migration-keyword-snapshot'
    `).run()).toThrow(/immutable/);
  });

  it('stores absent real-provider snapshot metrics as NULL instead of inventing zero', () => {
    const db = testDatabase();
    const now = '2026-09-19T00:00:00.000Z';
    db.prepare(`
      INSERT INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
      VALUES ('nullable-market', 'Nullable Market', 1, 'US', 'active', 'mcp', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO products (
        id, asin, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at
      ) VALUES ('nullable-product', 'B0NULL0001', 'Brand', 'Title', '', 'US', 'pillow', 1,
        'nullable-market', 'mcp', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('nullable-market-observation', 'nullable-market', '2026-09-18',
        'SellerSprite MCP', 'mcp', ?, '30D', 1, 0.8, '2026-09-18', 'nullable-market-key')
    `).run(now);
    db.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, source, source_type, collected_at, period,
        is_estimated, confidence, observation_date, dedup_key
      ) VALUES ('nullable-product-observation', 'nullable-product', '2026-09-18',
        'SellerSprite MCP', 'mcp', ?, '30D', 1, 0.8, '2026-09-18', 'nullable-product-key')
    `).run(now);

    expect(db.prepare(`
      SELECT median_price, median_reviews, top20_share FROM market_snapshots
      WHERE id = 'nullable-market-observation'
    `).get()).toEqual({ median_price: null, median_reviews: null, top20_share: null });
    expect(db.prepare(`
      SELECT bsr, review_count, seller_count, growth_30d FROM product_snapshots
      WHERE id = 'nullable-product-observation'
    `).get()).toEqual({ bsr: null, review_count: null, seller_count: null, growth_30d: null });
  });

  it('keeps discovered competitor candidates separate for each owned product', () => {
    const db = testDatabase();
    const now = '2026-09-19T00:00:00.000Z';
    db.prepare(`
      INSERT INTO market_nodes (id, name, level, marketplace, status, source_type, created_at)
      VALUES ('candidate-market', 'Candidate Market', 1, 'US', 'active', 'mcp', ?)
    `).run(now);
    const insertProduct = db.prepare(`
      INSERT INTO products (
        id, asin, brand, title, image_url, marketplace, product_type, is_owned,
        market_node_id, source_type, created_at
      ) VALUES (?, ?, 'Brand', 'Title', '', 'US', 'pillow', 1, 'candidate-market', 'import', ?)
    `);
    insertProduct.run('owned-a', 'B0OWNEDA01', now);
    insertProduct.run('owned-b', 'B0OWNEDB01', now);
    const insertCandidate = db.prepare(`
      INSERT INTO competitor_candidates (
        id, marketplace, asin, source_product_id, source, source_type, status, created_at
      ) VALUES (?, 'US', 'B0COMP0001', ?, 'SellerSprite MCP', 'mcp', 'pending_review', ?)
    `);
    insertCandidate.run('candidate-a', 'owned-a', now);
    insertCandidate.run('candidate-b', 'owned-b', now);

    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM competitor_candidates WHERE asin = 'B0COMP0001'
    `).get()).toEqual({ count: 2 });
  });

  it('keeps development project data and V15 lineage guards while making unknown metrics nullable', () => {
    const db = testDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO market_nodes (
        id, name, level, marketplace, status, source_type, created_at
      ) VALUES ('development-market', 'Development Market', 1, 'US', 'active', 'import', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary, score,
        facts_json, opportunities_json, risks_json, recommendations_json,
        evidence_json, confidence, model, data_version, input_hash, generated_at
      ) VALUES (
        'development-insight', 'development_project', 'development-project',
        'development_analysis', 'ready', 'Development insight', 'Verified input', 71,
        '[]', '[]', '[]', '[]', '[]', 0.8, 'rule-engine-v1',
        'development-v1', 'development-hash', ?
      )
    `).run(now);
    db.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary, score,
        facts_json, opportunities_json, risks_json, recommendations_json,
        evidence_json, confidence, model, data_version, input_hash, generated_at
      ) VALUES
        ('placeholder-insight', 'development_project', 'placeholder-project',
          'development_analysis', '数据不足', 'Insufficient', 'Missing input', NULL,
          '[]', '[]', '[]', '[]', '[]', 0.1, 'rule-engine-v1',
          'empty', 'placeholder-hash', ?),
        ('verified-zero-insight', 'development_project', 'verified-zero-project',
          'development_analysis', 'ready', 'Verified zero', 'Observed zeros', 0,
          '[]', '[]', '[]', '[]', '[{"id":"verified-zero"}]', 0.8,
          'rule-engine-v1', 'zero-v1', 'verified-zero-hash', ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO development_projects (
        id, name, product_type, keywords_json, notes, marketplace,
        supply_chain_relation, market_node_id, market_size, growth_30d,
        competition_score, opportunity_score, status, score_breakdown_json,
        insight_id, source_opportunity_id, created_at, updated_at
      ) VALUES (
        'development-project', 'Development Project', 'test-product', '["keyword"]',
        'notes', 'US', 'existing supplier', 'development-market', 12345, 8.5,
        42, 71, 'watch', '{"demand":10}', 'development-insight',
        'source-opportunity', ?, ?
      )
    `).run(now, now);
    const insertZeroProject = db.prepare(`
      INSERT INTO development_projects (
        id, name, product_type, keywords_json, notes, marketplace,
        supply_chain_relation, market_node_id, market_size, growth_30d,
        competition_score, opportunity_score, status, score_breakdown_json,
        insight_id, created_at, updated_at
      ) VALUES (?, ?, 'test-product', '[]', '', 'US', '', 'development-market',
        0, 0, 0, 0, 'watch', '{}', ?, ?, ?)
    `);
    insertZeroProject.run(
      'placeholder-project', 'Placeholder Project', 'placeholder-insight', now, now,
    );
    insertZeroProject.run(
      'verified-zero-project', 'Verified Zero Project', 'verified-zero-insight', now, now,
    );
    const before = db.prepare(`
      SELECT * FROM development_projects WHERE id = 'development-project'
    `).get();

    restoreV15DevelopmentProjects(db);
    expect(db.prepare(`PRAGMA table_info(development_projects)`).all()
      .filter((column) => ['market_size', 'growth_30d', 'competition_score', 'opportunity_score']
        .includes(String((column as { name: unknown }).name)))
      .every((column) => Number((column as { notnull: unknown }).notnull) === 1)).toBe(true);
    migrate(db);

    expect(db.prepare(`
      SELECT * FROM development_projects WHERE id = 'development-project'
    `).get()).toEqual(before);
    const metricColumns = db.prepare(`PRAGMA table_info(development_projects)`).all()
      .filter((column) => ['market_size', 'growth_30d', 'competition_score', 'opportunity_score']
        .includes(String((column as { name: unknown }).name))) as Array<{ name: string; notnull: number }>;
    expect(metricColumns).toHaveLength(4);
    expect(metricColumns.every((column) => Number(column.notnull) === 0)).toBe(true);
    expect(db.prepare(`
      SELECT market_size, growth_30d, competition_score, opportunity_score,
        score_breakdown_json
      FROM development_projects WHERE id = 'placeholder-project'
    `).get()).toEqual({
      market_size: null,
      growth_30d: null,
      competition_score: null,
      opportunity_score: null,
      score_breakdown_json: 'null',
    });
    expect(db.prepare(`
      SELECT market_size, growth_30d, competition_score, opportunity_score
      FROM development_projects WHERE id = 'verified-zero-project'
    `).get()).toEqual({
      market_size: 0,
      growth_30d: 0,
      competition_score: 0,
      opportunity_score: 0,
    });
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(development_projects)`).all()
      .map((foreignKey) => ({
        from: String((foreignKey as { from: unknown }).from),
        table: String((foreignKey as { table: unknown }).table),
        to: String((foreignKey as { to: unknown }).to),
      }));
    expect(foreignKeys).toEqual(expect.arrayContaining([
      { from: 'market_node_id', table: 'market_nodes', to: 'id' },
      { from: 'insight_id', table: 'ai_insights', to: 'id' },
    ]));

    db.prepare(`
      UPDATE development_projects
      SET market_size = NULL, growth_30d = NULL,
        competition_score = NULL, opportunity_score = NULL
      WHERE id = 'development-project'
    `).run();
    expect(db.prepare(`
      SELECT market_size, growth_30d, competition_score, opportunity_score
      FROM development_projects WHERE id = 'development-project'
    `).get()).toEqual({
      market_size: null,
      growth_30d: null,
      competition_score: null,
      opportunity_score: null,
    });

    const triggers = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_decisions_%'
      ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    expect(triggers.map((trigger) => trigger.name)).toEqual([
      'trg_decisions_complete_workflow_lineage',
      'trg_decisions_v2_entity_requires_lineage',
    ]);
    expect(triggers.find((trigger) => trigger.name === 'trg_decisions_complete_workflow_lineage')?.sql)
      .toContain('FROM development_projects project');
    expect(triggers.every((trigger) => !trigger.sql.includes('development_projects_v16'))).toBe(true);

    insertResearchJob(
      db,
      'development-job',
      'development-v1',
      'development_project',
      'development-project',
    );
    expect(() => db.prepare(`
      INSERT INTO decisions (
        id, entity_type, entity_id, decision, reason, ai_insight_id,
        data_version, decided_by, decided_at
      ) VALUES (
        'untraceable-decision', 'development_project', 'development-project',
        'watch', 'No workflow lineage', 'development-insight',
        'development-v1', 'migration test', ?
      )
    `).run(now)).toThrow(/V2 entity decision requires workflow lineage/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('removes only exact legacy no-data opportunities and repairs their references', () => {
    const db = testDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO research_results (
        id, query, summary, nodes_json, combinations_json,
        opportunity_ids_json, tasks_created, generated_at
      ) VALUES ('legacy-result', 'legacy query', 'legacy summary', '[]', '[]',
        '["legacy-placeholder","evidence-backed-zero"]', 1, ?)
    `).run(now);
    const insertOpportunity = db.prepare(`
      INSERT INTO opportunities (
        id, name, source_type, market_name, opportunity_score, market_growth,
        competition_score, price_room, recommended_action, status, summary,
        evidence_json, research_result_id, created_at, updated_at, marketplace
      ) VALUES (?, ?, 'ai_research', 'Legacy Market', 0, 0, 0, '待采集', ?,
        'pending_review', ?, ?, 'legacy-result', ?, ?, 'US')
    `);
    insertOpportunity.run(
      'legacy-placeholder', 'Legacy Placeholder', '先完成数据采集',
      '当前数据不足，仅完成市场拆解，不对机会做强结论。', '[]', now, now,
    );
    insertOpportunity.run(
      'evidence-backed-zero', 'Evidence-backed Zero', '先完成数据采集',
      '当前数据不足，仅完成市场拆解，不对机会做强结论。',
      '[{"id":"verified-evidence"}]', now, now,
    );
    const insertWatch = db.prepare(`
      INSERT INTO watchlist_items (
        id, item_type, item_id, name, marketplace, frequency, status,
        latest_finding, anomaly, created_at
      ) VALUES (?, 'opportunity', ?, ?, 'US', 'manual', 'active', '', 0, ?)
    `);
    insertWatch.run('watch-placeholder', 'legacy-placeholder', 'Legacy Placeholder', now);
    insertWatch.run('watch-verified', 'evidence-backed-zero', 'Evidence-backed Zero', now);
    db.prepare(`
      INSERT INTO data_tasks (
        id, name, task_type, target, source, status, total, success, failed,
        created_at, marketplace
      ) VALUES ('legacy-task', 'Legacy collection task', 'opportunity_research',
        'legacy-placeholder', '待配置数据源', 'pending', 0, 0, 0, ?, 'US')
    `).run(now);

    db.prepare('DELETE FROM schema_migrations WHERE version = 17').run();
    migrate(db);

    expect(db.prepare(`SELECT id FROM opportunities WHERE id = 'legacy-placeholder'`).get())
      .toBeUndefined();
    expect(db.prepare(`SELECT id FROM opportunities WHERE id = 'evidence-backed-zero'`).get())
      .toMatchObject({ id: 'evidence-backed-zero' });
    const result = db.prepare(`
      SELECT opportunity_ids_json FROM research_results WHERE id = 'legacy-result'
    `).get() as { opportunity_ids_json: string };
    expect(JSON.parse(result.opportunity_ids_json)).toEqual(['evidence-backed-zero']);
    expect(db.prepare(`SELECT id FROM watchlist_items WHERE id = 'watch-placeholder'`).get())
      .toBeUndefined();
    expect(db.prepare(`SELECT id FROM watchlist_items WHERE id = 'watch-verified'`).get())
      .toMatchObject({ id: 'watch-verified' });
    expect(db.prepare(`SELECT id FROM data_tasks WHERE id = 'legacy-task'`).get())
      .toMatchObject({ id: 'legacy-task' });
  });

  it('migrates only calculated market scores into nullable canonical columns', () => {
    const db = testDatabase();
    const now = new Date().toISOString();
    db.exec(`
      ALTER TABLE market_nodes DROP COLUMN competition_score;
      ALTER TABLE market_nodes DROP COLUMN opportunity_score;
      ALTER TABLE market_nodes RENAME COLUMN competition_score_legacy TO competition_score;
      ALTER TABLE market_nodes RENAME COLUMN opportunity_score_legacy TO opportunity_score;
      DELETE FROM schema_migrations WHERE version = 18;
    `);
    const insertMarket = db.prepare(`
      INSERT INTO market_nodes (
        id, name, level, marketplace, status, competition_score,
        opportunity_score, source_type, created_at
      ) VALUES (?, ?, 1, 'US', ?, ?, ?, 'import', ?)
    `);
    insertMarket.run('calculated-market', 'Calculated Market', '继续观察', 42, 71, now);
    insertMarket.run('waiting-market', 'Waiting Market', '等待30D对照', 0, 0, now);
    insertMarket.run('empty-market', 'Empty Market', '待导入数据', 0, 0, now);
    const insertSnapshot = db.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count,
        monthly_sales, monthly_revenue, avg_price, median_price, avg_rating,
        median_reviews, source, source_type, collected_at, period,
        is_estimated, confidence
      ) VALUES (?, ?, ?, 10, 8, 6, 100, 3000, 30, 29, 4.3,
        50, 'migration test', 'import', ?, '30D', 0, 0.9)
    `);
    insertSnapshot.run('calculated-baseline', 'calculated-market', '2026-08-02', now);
    insertSnapshot.run('calculated-current', 'calculated-market', '2026-09-01', now);
    insertSnapshot.run('waiting-snapshot', 'waiting-market', '2026-09-01', now);

    migrate(db);
    db.prepare(`
      UPDATE market_nodes SET competition_score = 0, opportunity_score = 0
      WHERE id = 'waiting-market'
    `).run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 19').run();
    migrate(db);

    expect(db.prepare(`
      SELECT competition_score, opportunity_score
      FROM market_nodes WHERE id = 'calculated-market'
    `).get()).toEqual({ competition_score: 42, opportunity_score: 71 });
    expect(db.prepare(`
      SELECT competition_score, opportunity_score
      FROM market_nodes WHERE id = 'waiting-market'
    `).get()).toEqual({ competition_score: null, opportunity_score: null });
    expect(db.prepare(`
      SELECT competition_score, opportunity_score
      FROM market_nodes WHERE id = 'empty-market'
    `).get()).toEqual({ competition_score: null, opportunity_score: null });
    db.prepare(`
      INSERT INTO market_nodes (
        id, name, level, marketplace, status, source_type, created_at
      ) VALUES ('new-empty-market', 'New Empty Market', 1, 'US', '待导入数据', 'import', ?)
    `).run(now);
    expect(db.prepare(`
      SELECT competition_score, opportunity_score,
        competition_score_legacy, opportunity_score_legacy
      FROM market_nodes WHERE id = 'new-empty-market'
    `).get()).toEqual({
      competition_score: null,
      opportunity_score: null,
      competition_score_legacy: 0,
      opportunity_score_legacy: 0,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
