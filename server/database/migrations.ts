import type { DatabaseSync } from 'node:sqlite';

function assertVariationFamilyIntegrity(database: DatabaseSync, version: number): void {
  const orphan = database.prepare(`
    SELECT product.id FROM products product
    LEFT JOIN variation_families family ON family.id = product.variation_family_id
    WHERE product.variation_family_id IS NOT NULL
      AND (family.id IS NULL OR family.marketplace <> product.marketplace)
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (orphan) {
    throw new Error(`V${version} found missing/cross-market variation family for product ${orphan.id}; review legacy identity before migration.`);
  }

  const inconsistentParent = database.prepare(`
    SELECT product.id FROM products product
    LEFT JOIN variation_families family ON family.id = product.variation_family_id
    WHERE (product.variation_family_id IS NULL
        AND product.parent_asin IS NOT NULL AND TRIM(product.parent_asin) <> '')
      OR (product.variation_family_id IS NOT NULL
        AND UPPER(TRIM(COALESCE(product.parent_asin, '')))
          <> UPPER(TRIM(COALESCE(family.parent_asin, ''))))
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (inconsistentParent) {
    throw new Error(`V${version} found parent ASIN inconsistent with variation family for product ${inconsistentParent.id}; review legacy identity before migration.`);
  }
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('empty', 'demo', 'live')),
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        marketplace TEXT NOT NULL,
        currency TEXT NOT NULL,
        timezone TEXT NOT NULL,
        default_market_id TEXT NOT NULL,
        ai_model TEXT NOT NULL,
        refresh_frequency TEXT NOT NULL CHECK (refresh_frequency IN ('manual', 'daily', 'weekly')),
        last_successful_sync TEXT
      );

      CREATE TABLE IF NOT EXISTS data_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('mock', 'import', 'mcp', 'amazon')),
        status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected', 'needs_configuration')),
        config_json TEXT NOT NULL DEFAULT '{}',
        last_sync_at TEXT,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES market_nodes(id),
        level INTEGER NOT NULL,
        marketplace TEXT NOT NULL,
        category_id TEXT,
        keywords_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        competition_score REAL NOT NULL DEFAULT 0,
        opportunity_score REAL NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT 'import',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_market_nodes_parent ON market_nodes(parent_id);

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id TEXT PRIMARY KEY,
        market_node_id TEXT NOT NULL REFERENCES market_nodes(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        product_count INTEGER NOT NULL,
        seller_count INTEGER NOT NULL,
        brand_count INTEGER NOT NULL,
        monthly_sales REAL NOT NULL,
        monthly_revenue REAL NOT NULL,
        avg_price REAL NOT NULL,
        median_price REAL NOT NULL,
        avg_rating REAL NOT NULL,
        median_reviews REAL NOT NULL,
        top10_share REAL NOT NULL DEFAULT 0,
        top20_share REAL NOT NULL DEFAULT 0,
        new_product_share REAL NOT NULL DEFAULT 0,
        price_bands_json TEXT NOT NULL DEFAULT '[]',
        concentration_json TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        source_type TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        period TEXT NOT NULL,
        is_estimated INTEGER NOT NULL,
        confidence REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_market_snapshots_node_date
        ON market_snapshots(market_node_id, date DESC);

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        asin TEXT NOT NULL,
        sku TEXT,
        internal_name TEXT,
        brand TEXT NOT NULL,
        title TEXT NOT NULL,
        image_url TEXT NOT NULL,
        marketplace TEXT NOT NULL,
        product_type TEXT NOT NULL,
        is_owned INTEGER NOT NULL DEFAULT 0,
        market_node_id TEXT NOT NULL REFERENCES market_nodes(id),
        keywords_json TEXT NOT NULL DEFAULT '[]',
        monitoring_enabled INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT 'import',
        created_at TEXT NOT NULL,
        UNIQUE(asin, marketplace)
      );
      CREATE INDEX IF NOT EXISTS idx_products_market ON products(market_node_id);
      CREATE INDEX IF NOT EXISTS idx_products_owned ON products(is_owned);

      CREATE TABLE IF NOT EXISTS product_snapshots (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        price REAL NOT NULL,
        rating REAL NOT NULL,
        review_count INTEGER NOT NULL,
        bsr INTEGER NOT NULL,
        estimated_sales REAL NOT NULL,
        estimated_revenue REAL NOT NULL,
        seller_count INTEGER NOT NULL,
        growth_7d REAL NOT NULL DEFAULT 0,
        growth_30d REAL NOT NULL DEFAULT 0,
        growth_90d REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        source_type TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        period TEXT NOT NULL,
        is_estimated INTEGER NOT NULL,
        confidence REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_product_snapshots_product_date
        ON product_snapshots(product_id, date DESC);

      CREATE TABLE IF NOT EXISTS competitor_relations (
        id TEXT PRIMARY KEY,
        owned_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        competitor_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK (relation_type IN ('direct', 'top100', 'benchmark', 'fast_growth')),
        similarity_score REAL NOT NULL,
        reason TEXT NOT NULL,
        ai_tags_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(owned_product_id, competitor_product_id, relation_type)
      );

      CREATE TABLE IF NOT EXISTS ai_insights (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        insight_type TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        score REAL,
        facts_json TEXT NOT NULL DEFAULT '[]',
        opportunities_json TEXT NOT NULL DEFAULT '[]',
        risks_json TEXT NOT NULL DEFAULT '[]',
        recommendations_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL,
        model TEXT NOT NULL,
        data_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        UNIQUE(entity_type, entity_id, insight_type, input_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_insights_entity
        ON ai_insights(entity_type, entity_id, generated_at DESC);

      CREATE TABLE IF NOT EXISTS development_projects (
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

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('develop', 'test', 'watch', 'reject')),
        reason TEXT NOT NULL,
        ai_insight_id TEXT NOT NULL REFERENCES ai_insights(id),
        data_version TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_entity
        ON decisions(entity_type, entity_id, decided_at DESC);

      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        market_node_id TEXT REFERENCES market_nodes(id),
        market_name TEXT NOT NULL,
        opportunity_score REAL NOT NULL,
        market_growth REAL NOT NULL,
        competition_score REAL NOT NULL,
        price_room TEXT NOT NULL,
        recommended_action TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending_review', 'researching', 'promoted', 'rejected')),
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        rejection_reason TEXT,
        research_result_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_results (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        summary TEXT NOT NULL,
        nodes_json TEXT NOT NULL,
        combinations_json TEXT NOT NULL,
        opportunity_ids_json TEXT NOT NULL,
        tasks_created INTEGER NOT NULL,
        generated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watchlist_items (
        id TEXT PRIMARY KEY,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        name TEXT NOT NULL,
        frequency TEXT NOT NULL CHECK (frequency IN ('manual', 'daily', 'weekly')),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
        last_run_at TEXT,
        next_run_at TEXT,
        latest_finding TEXT NOT NULL DEFAULT '',
        anomaly INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(item_type, item_id)
      );

      CREATE TABLE IF NOT EXISTS data_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_id TEXT REFERENCES data_sources(id),
        task_type TEXT NOT NULL,
        target TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'partial', 'failed')),
        started_at TEXT,
        completed_at TEXT,
        total INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        error_log TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_data_tasks_created ON data_tasks(created_at DESC);

      CREATE TABLE IF NOT EXISTS import_batches (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('csv', 'xlsx')),
        entity_type TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        success_count INTEGER NOT NULL,
        failure_count INTEGER NOT NULL,
        errors_json TEXT NOT NULL DEFAULT '[]',
        task_id TEXT NOT NULL REFERENCES data_tasks(id),
        imported_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE opportunities ADD COLUMN marketplace TEXT NOT NULL DEFAULT 'US';
      CREATE INDEX IF NOT EXISTS idx_opportunities_marketplace
        ON opportunities(marketplace, updated_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE watchlist_items RENAME TO watchlist_items_legacy;
      CREATE TABLE watchlist_items (
        id TEXT PRIMARY KEY,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        name TEXT NOT NULL,
        marketplace TEXT NOT NULL,
        frequency TEXT NOT NULL CHECK (frequency IN ('manual', 'daily', 'weekly')),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
        last_run_at TEXT,
        next_run_at TEXT,
        latest_finding TEXT NOT NULL DEFAULT '',
        anomaly INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(marketplace, item_type, item_id)
      );
      INSERT INTO watchlist_items (
        id, item_type, item_id, name, marketplace, frequency, status, last_run_at,
        next_run_at, latest_finding, anomaly, created_at
      )
      SELECT legacy.id, legacy.item_type, legacy.item_id, legacy.name,
        CASE
          WHEN legacy.item_type IN ('owned_product', 'competitor')
            THEN COALESCE((SELECT marketplace FROM products WHERE id = legacy.item_id), 'US')
          WHEN legacy.item_type = 'market'
            THEN COALESCE((SELECT marketplace FROM market_nodes WHERE id = legacy.item_id), 'US')
          WHEN legacy.item_type = 'development_project'
            THEN COALESCE((SELECT marketplace FROM development_projects WHERE id = legacy.item_id), 'US')
          WHEN legacy.item_type = 'opportunity'
            THEN COALESCE((SELECT marketplace FROM opportunities WHERE id = legacy.item_id), 'US')
          ELSE COALESCE((SELECT marketplace FROM app_settings WHERE id = 1), 'US')
        END,
        legacy.frequency, legacy.status, legacy.last_run_at, legacy.next_run_at,
        legacy.latest_finding, legacy.anomaly, legacy.created_at
      FROM watchlist_items_legacy legacy;
      DROP TABLE watchlist_items_legacy;
      CREATE INDEX idx_watchlist_marketplace
        ON watchlist_items(marketplace, anomaly DESC, created_at DESC);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE data_tasks ADD COLUMN marketplace TEXT NOT NULL DEFAULT 'US';
      UPDATE data_tasks SET marketplace = COALESCE(
        (SELECT marketplace FROM products WHERE products.id = data_tasks.target),
        (SELECT marketplace FROM market_nodes WHERE market_nodes.id = data_tasks.target),
        (SELECT marketplace FROM development_projects WHERE development_projects.id = data_tasks.target),
        (SELECT marketplace FROM opportunities WHERE opportunities.id = data_tasks.target),
        (SELECT marketplace FROM app_settings WHERE id = 1),
        'US'
      );
      CREATE INDEX IF NOT EXISTS idx_data_tasks_marketplace_created
        ON data_tasks(marketplace, created_at DESC);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE rule_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        job_types_json TEXT NOT NULL,
        hard_gates_json TEXT NOT NULL,
        scoring_json TEXT NOT NULL,
        thresholds_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(name, version)
      );

      CREATE TABLE research_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        job_type TEXT NOT NULL CHECK (job_type IN (
          'existing_market', 'owned_product', 'adjacent_product', 'new_opportunity'
        )),
        marketplace TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'draft', 'planned', 'collecting', 'normalizing', 'validating',
          'calculating', 'analyzing', 'reverse_review', 'waiting_approval',
          'approved', 'watch', 'rejected', 'monitoring', 'failed', 'needs_data'
        )),
        entity_type TEXT,
        entity_id TEXT,
        rule_profile_id TEXT NOT NULL REFERENCES rule_profiles(id),
        rule_profile_version INTEGER NOT NULL,
        rule_profile_snapshot_json TEXT NOT NULL,
        input_json TEXT NOT NULL DEFAULT '{}',
        task_book_json TEXT NOT NULL DEFAULT '{}',
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        data_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );
      CREATE INDEX idx_research_jobs_marketplace_updated
        ON research_jobs(marketplace, updated_at DESC);

      CREATE TABLE research_steps (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        step_type TEXT NOT NULL CHECK (step_type IN (
          'plan', 'collect_market', 'collect_products', 'collect_keywords',
          'collect_reviews', 'normalize', 'validate', 'calculate', 'hard_gate',
          'score', 'ai_analysis', 'review_gap', 'reverse_review', 'approval',
          'snapshot', 'report'
        )),
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'running', 'completed', 'skipped', 'failed', 'needs_data'
        )),
        input_json TEXT NOT NULL DEFAULT '{}',
        output_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(research_job_id, step_type)
      );
      CREATE INDEX idx_research_steps_job ON research_steps(research_job_id, created_at);

      CREATE TABLE normalized_records (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        record_type TEXT NOT NULL,
        source_record_id TEXT,
        fields_json TEXT NOT NULL,
        data_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_normalized_records_job ON normalized_records(research_job_id, created_at);

      CREATE TABLE keywords (
        id TEXT PRIMARY KEY,
        marketplace TEXT NOT NULL,
        market_node_id TEXT REFERENCES market_nodes(id) ON DELETE SET NULL,
        keyword TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(marketplace, keyword)
      );

      CREATE TABLE keyword_snapshots (
        id TEXT PRIMARY KEY,
        keyword_id TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        search_volume REAL,
        trend REAL,
        competing_products REAL,
        aba_click_share REAL,
        aba_conversion_share REAL,
        bid REAL,
        source_metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_keyword_snapshots_keyword_date
        ON keyword_snapshots(keyword_id, date DESC);

      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        research_job_id TEXT REFERENCES research_jobs(id) ON DELETE SET NULL,
        product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
        external_review_id TEXT,
        review_text TEXT NOT NULL,
        rating REAL,
        review_date TEXT,
        source TEXT NOT NULL,
        source_record_id TEXT,
        collected_at TEXT NOT NULL,
        normalized_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_reviews_job ON reviews(research_job_id, collected_at DESC);

      CREATE TABLE review_insights (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        issue TEXT NOT NULL,
        frequency REAL NOT NULL,
        competitors_affected INTEGER NOT NULL,
        is_cross_market_issue INTEGER NOT NULL,
        supply_chain_solvable INTEGER,
        cost_impact TEXT,
        opportunity_level TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_review_insights_job ON review_insights(research_job_id, created_at DESC);

      CREATE TABLE missing_data_items (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        label TEXT NOT NULL,
        missing_reason TEXT NOT NULL,
        required_for_decision INTEGER NOT NULL,
        manual_validation_required INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'waived')),
        resolved_value_json TEXT,
        resolved_by TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(research_job_id, field_name)
      );
      CREATE INDEX idx_missing_data_job ON missing_data_items(research_job_id, status);

      CREATE TABLE evidence_records (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        insight_id TEXT REFERENCES ai_insights(id) ON DELETE SET NULL,
        claim TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        metric_value_json TEXT NOT NULL,
        source TEXT NOT NULL,
        source_record_id TEXT,
        collected_at TEXT NOT NULL,
        calculation TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_evidence_job ON evidence_records(research_job_id, created_at);

      CREATE TABLE rule_executions (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        rule_profile_id TEXT NOT NULL REFERENCES rule_profiles(id),
        rule_version INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        hard_gate_status TEXT NOT NULL CHECK (hard_gate_status IN ('pass', 'reject', 'needs_data')),
        score REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_rule_executions_job ON rule_executions(research_job_id, created_at DESC);

      CREATE TABLE score_results (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        rule_execution_id TEXT NOT NULL REFERENCES rule_executions(id) ON DELETE CASCADE,
        total REAL NOT NULL,
        breakdown_json TEXT NOT NULL,
        calculation_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_score_results_job ON score_results(research_job_id, created_at DESC);

      CREATE TABLE reverse_reviews (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        verdict TEXT NOT NULL CHECK (verdict IN (
          'proceed', 'proceed_with_caution', 'needs_data', 'reject'
        )),
        top_failure_modes_json TEXT NOT NULL,
        unknowns_json TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_reverse_reviews_job ON reverse_reviews(research_job_id, created_at DESC);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'approved', 'watch', 'needs_data', 'rejected'
        )),
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_by TEXT,
        reason TEXT,
        decided_at TEXT
      );
      CREATE INDEX idx_approvals_job ON approvals(research_job_id, requested_at DESC);

      ALTER TABLE data_tasks ADD COLUMN research_job_id TEXT;
      CREATE INDEX idx_data_tasks_research_job ON data_tasks(research_job_id, created_at DESC);

      ALTER TABLE ai_insights ADD COLUMN research_job_id TEXT;
      ALTER TABLE ai_insights ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'legacy-v1';
      ALTER TABLE ai_insights ADD COLUMN evidence_ids_json TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX idx_ai_insights_research_job
        ON ai_insights(research_job_id, generated_at DESC);

      ALTER TABLE decisions RENAME TO decisions_legacy;
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN (
          'develop', 'test', 'watch', 'reject', 'approved', 'needs_data'
        )),
        reason TEXT NOT NULL,
        ai_insight_id TEXT NOT NULL REFERENCES ai_insights(id),
        data_version TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        research_job_id TEXT REFERENCES research_jobs(id) ON DELETE SET NULL,
        reverse_review_id TEXT REFERENCES reverse_reviews(id) ON DELETE SET NULL,
        approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL
      );
      INSERT INTO decisions (
        id, entity_type, entity_id, decision, reason, ai_insight_id, data_version,
        decided_by, decided_at
      )
      SELECT id, entity_type, entity_id, decision, reason, ai_insight_id, data_version,
        decided_by, decided_at
      FROM decisions_legacy;
      DROP TABLE decisions_legacy;
      CREATE INDEX idx_decisions_entity ON decisions(entity_type, entity_id, decided_at DESC);
      CREATE INDEX idx_decisions_research_job ON decisions(research_job_id, decided_at DESC);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE competitor_relations RENAME TO competitor_relations_legacy;
      CREATE TABLE competitor_relations (
        id TEXT PRIMARY KEY,
        owned_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        competitor_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK (relation_type IN (
          'direct', 'top100', 'benchmark', 'fast_growth', 'price_peer'
        )),
        similarity_score REAL NOT NULL,
        reason TEXT NOT NULL,
        ai_tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(owned_product_id, competitor_product_id, relation_type)
      );
      INSERT INTO competitor_relations (
        id, owned_product_id, competitor_product_id, relation_type, similarity_score,
        reason, ai_tags_json, created_at, last_verified_at
      )
      SELECT id, owned_product_id, competitor_product_id, relation_type, similarity_score,
        reason, ai_tags_json, datetime('now'), datetime('now')
      FROM competitor_relations_legacy;
      DROP TABLE competitor_relations_legacy;
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS score_results (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        rule_execution_id TEXT NOT NULL REFERENCES rule_executions(id) ON DELETE CASCADE,
        total REAL NOT NULL,
        breakdown_json TEXT NOT NULL,
        calculation_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_score_results_job
        ON score_results(research_job_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS keywords (
        id TEXT PRIMARY KEY,
        marketplace TEXT NOT NULL,
        market_node_id TEXT REFERENCES market_nodes(id) ON DELETE SET NULL,
        keyword TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(marketplace, keyword)
      );
      CREATE TABLE IF NOT EXISTS keyword_snapshots (
        id TEXT PRIMARY KEY,
        keyword_id TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        search_volume REAL,
        trend REAL,
        competing_products REAL,
        aba_click_share REAL,
        aba_conversion_share REAL,
        bid REAL,
        source_metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_keyword_snapshots_keyword_date
        ON keyword_snapshots(keyword_id, date DESC);

      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        research_job_id TEXT REFERENCES research_jobs(id) ON DELETE SET NULL,
        product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
        external_review_id TEXT,
        review_text TEXT NOT NULL,
        rating REAL,
        review_date TEXT,
        source TEXT NOT NULL,
        source_record_id TEXT,
        collected_at TEXT NOT NULL,
        normalized_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_job ON reviews(research_job_id, collected_at DESC);
      CREATE TABLE IF NOT EXISTS review_insights (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        issue TEXT NOT NULL,
        frequency REAL NOT NULL,
        competitors_affected INTEGER NOT NULL,
        is_cross_market_issue INTEGER NOT NULL,
        supply_chain_solvable INTEGER,
        cost_impact TEXT,
        opportunity_level TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_insights_job
        ON review_insights(research_job_id, created_at DESC);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE missing_data_items RENAME TO missing_data_items_legacy;
      CREATE TABLE missing_data_items (
        id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        label TEXT NOT NULL,
        missing_reason TEXT NOT NULL,
        required_for_decision INTEGER NOT NULL,
        manual_validation_required INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'waived')),
        resolved_value_json TEXT,
        resolved_by TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(research_job_id, field_name)
      );
      INSERT OR IGNORE INTO missing_data_items (
        id, research_job_id, field_name, label, missing_reason, required_for_decision,
        manual_validation_required, status, resolved_value_json, resolved_by,
        resolved_at, created_at
      )
      SELECT id, research_job_id, field_name, label, missing_reason, required_for_decision,
        manual_validation_required, status, resolved_value_json, resolved_by,
        resolved_at, created_at
      FROM missing_data_items_legacy
      ORDER BY created_at DESC;
      DROP TABLE missing_data_items_legacy;
      CREATE INDEX idx_missing_data_job ON missing_data_items(research_job_id, status);
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE evidence_records ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE evidence_records ADD COLUMN period TEXT NOT NULL DEFAULT 'point_in_time';
      ALTER TABLE evidence_records ADD COLUMN is_estimated INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE evidence_records ADD COLUMN data_version TEXT NOT NULL DEFAULT 'legacy-v1';
      CREATE INDEX IF NOT EXISTS idx_evidence_job_version
        ON evidence_records(research_job_id, data_version, created_at);
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE ai_insights ADD COLUMN missing_data_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE ai_insights ADD COLUMN possible_causes_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE ai_insights ADD COLUMN hard_gate TEXT;
      ALTER TABLE ai_insights ADD COLUMN decision_recommendation TEXT;
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE review_insights ADD COLUMN data_version TEXT NOT NULL DEFAULT 'legacy-v1';
      CREATE INDEX IF NOT EXISTS idx_review_insights_job_version
        ON review_insights(research_job_id, data_version, created_at DESC);

      ALTER TABLE rule_executions ADD COLUMN data_version TEXT NOT NULL DEFAULT 'legacy-v1';
      CREATE INDEX IF NOT EXISTS idx_rule_executions_job_version
        ON rule_executions(research_job_id, data_version, created_at DESC);
    `,
  },
  {
    version: 13,
    sql: `
      -- V10/V12 introduced version columns after these records already existed.
      -- The parent job is the only recoverable version source for those legacy rows.
      UPDATE evidence_records
      SET data_version = (
        SELECT job.data_version FROM research_jobs job
        WHERE job.id = evidence_records.research_job_id
      )
      WHERE data_version = 'legacy-v1'
        AND EXISTS (
          SELECT 1 FROM research_jobs job
          WHERE job.id = evidence_records.research_job_id
        );

      UPDATE review_insights
      SET data_version = (
        SELECT job.data_version FROM research_jobs job
        WHERE job.id = review_insights.research_job_id
      )
      WHERE data_version = 'legacy-v1'
        AND EXISTS (
          SELECT 1 FROM research_jobs job
          WHERE job.id = review_insights.research_job_id
        );

      UPDATE rule_executions
      SET data_version = (
        SELECT job.data_version FROM research_jobs job
        WHERE job.id = rule_executions.research_job_id
      )
      WHERE data_version = 'legacy-v1'
        AND EXISTS (
          SELECT 1 FROM research_jobs job
          WHERE job.id = rule_executions.research_job_id
        );

      CREATE TRIGGER IF NOT EXISTS trg_market_snapshots_immutable
      BEFORE UPDATE ON market_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'market_snapshots are immutable; append a new snapshot');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_product_snapshots_immutable
      BEFORE UPDATE ON product_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'product_snapshots are immutable; append a new snapshot');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_keyword_snapshots_immutable
      BEFORE UPDATE ON keyword_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'keyword_snapshots are immutable; append a new snapshot');
      END;
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE reverse_reviews ADD COLUMN data_version TEXT;
      ALTER TABLE reverse_reviews ADD COLUMN rule_profile_id TEXT;
      ALTER TABLE reverse_reviews ADD COLUMN rule_profile_version INTEGER;
      ALTER TABLE reverse_reviews ADD COLUMN prompt_version TEXT;

      -- Legacy reviews predate immutable lineage columns. The current parent job
      -- is the only recoverable source for those historical rows.
      UPDATE reverse_reviews
      SET data_version = (
            SELECT job.data_version FROM research_jobs job
            WHERE job.id = reverse_reviews.research_job_id
          ),
          rule_profile_id = (
            SELECT job.rule_profile_id FROM research_jobs job
            WHERE job.id = reverse_reviews.research_job_id
          ),
          rule_profile_version = (
            SELECT job.rule_profile_version FROM research_jobs job
            WHERE job.id = reverse_reviews.research_job_id
          ),
          prompt_version = (
            SELECT job.prompt_version FROM research_jobs job
            WHERE job.id = reverse_reviews.research_job_id
          )
      WHERE EXISTS (
        SELECT 1 FROM research_jobs job
        WHERE job.id = reverse_reviews.research_job_id
      );

      CREATE INDEX IF NOT EXISTS idx_reverse_reviews_current
        ON reverse_reviews(
          research_job_id, data_version, rule_profile_id,
          rule_profile_version, prompt_version, created_at DESC
        );

      ALTER TABLE approvals ADD COLUMN data_version TEXT;
      ALTER TABLE approvals ADD COLUMN rule_profile_id TEXT;
      ALTER TABLE approvals ADD COLUMN rule_profile_version INTEGER;
      ALTER TABLE approvals ADD COLUMN prompt_version TEXT;
      ALTER TABLE approvals ADD COLUMN reverse_review_id TEXT REFERENCES reverse_reviews(id);

      UPDATE approvals
      SET data_version = (
            SELECT job.data_version FROM research_jobs job
            WHERE job.id = approvals.research_job_id
          ),
          rule_profile_id = (
            SELECT job.rule_profile_id FROM research_jobs job
            WHERE job.id = approvals.research_job_id
          ),
          rule_profile_version = (
            SELECT job.rule_profile_version FROM research_jobs job
            WHERE job.id = approvals.research_job_id
          ),
          prompt_version = (
            SELECT job.prompt_version FROM research_jobs job
            WHERE job.id = approvals.research_job_id
          )
      WHERE EXISTS (
        SELECT 1 FROM research_jobs job
        WHERE job.id = approvals.research_job_id
      );

      UPDATE approvals
      SET reverse_review_id = COALESCE(
        (
          SELECT review.id FROM reverse_reviews review
          WHERE review.research_job_id = approvals.research_job_id
            AND review.data_version = approvals.data_version
            AND review.rule_profile_id = approvals.rule_profile_id
            AND review.rule_profile_version = approvals.rule_profile_version
            AND review.prompt_version = approvals.prompt_version
            AND review.created_at <= approvals.requested_at
          ORDER BY review.created_at DESC, review.rowid DESC LIMIT 1
        ),
        (
          SELECT review.id FROM reverse_reviews review
          WHERE review.research_job_id = approvals.research_job_id
            AND review.data_version = approvals.data_version
            AND review.rule_profile_id = approvals.rule_profile_id
            AND review.rule_profile_version = approvals.rule_profile_version
            AND review.prompt_version = approvals.prompt_version
          ORDER BY review.created_at DESC, review.rowid DESC LIMIT 1
        )
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_current
        ON approvals(
          research_job_id, data_version, rule_profile_id,
          rule_profile_version, prompt_version, requested_at DESC
        );
    `,
  },
  {
    version: 15,
    sql: `
      -- A Decision that claims workflow provenance must reference one exact,
      -- internally consistent version of the job, insight, review and approval.
      CREATE TRIGGER IF NOT EXISTS trg_decisions_complete_workflow_lineage
      BEFORE INSERT ON decisions
      WHEN NEW.research_job_id IS NOT NULL
        OR NEW.reverse_review_id IS NOT NULL
        OR NEW.approval_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'workflow decision requires complete lineage')
        WHERE NEW.research_job_id IS NULL
          OR NEW.reverse_review_id IS NULL
          OR NEW.approval_id IS NULL;

        SELECT RAISE(ABORT, 'workflow decision lineage is stale or mismatched')
        WHERE NOT EXISTS (
          SELECT 1
          FROM research_jobs job
          JOIN ai_insights insight ON insight.id = NEW.ai_insight_id
          JOIN reverse_reviews review ON review.id = NEW.reverse_review_id
          JOIN approvals approval ON approval.id = NEW.approval_id
          WHERE job.id = NEW.research_job_id
            AND NEW.data_version = job.data_version
            AND insight.research_job_id = job.id
            AND insight.data_version = job.data_version
            AND insight.prompt_version = job.prompt_version
            AND review.research_job_id = job.id
            AND review.data_version = job.data_version
            AND review.rule_profile_id = job.rule_profile_id
            AND review.rule_profile_version = job.rule_profile_version
            AND review.prompt_version = job.prompt_version
            AND approval.research_job_id = job.id
            AND approval.data_version = job.data_version
            AND approval.rule_profile_id = job.rule_profile_id
            AND approval.rule_profile_version = job.rule_profile_version
            AND approval.prompt_version = job.prompt_version
            AND approval.reverse_review_id = review.id
            AND (
              (
                NEW.entity_type = 'research_job'
                AND NEW.entity_id = job.id
                AND (
                  NEW.decision = approval.status
                  OR (NEW.decision = 'reject' AND approval.status = 'rejected')
                )
              )
              OR (
                NEW.entity_type = 'development_project'
                AND approval.status = 'approved'
                AND NEW.decision = approval.action
                AND (
                  (job.entity_type = 'development_project' AND job.entity_id = NEW.entity_id)
                  OR (
                    job.entity_type = 'opportunity'
                    AND EXISTS (
                      SELECT 1 FROM development_projects project
                      WHERE project.id = NEW.entity_id
                        AND project.source_opportunity_id = job.entity_id
                        AND project.marketplace = job.marketplace
                    )
                  )
                )
              )
            )
        );
      END;

      -- Once an entity enters V2, legacy mutations may no longer append an
      -- untraceable Decision for that same entity.
      CREATE TRIGGER IF NOT EXISTS trg_decisions_v2_entity_requires_lineage
      BEFORE INSERT ON decisions
      WHEN NEW.entity_type IN ('development_project', 'opportunity')
        AND NEW.research_job_id IS NULL
        AND EXISTS (
          SELECT 1 FROM research_jobs job
          WHERE job.entity_type = NEW.entity_type AND job.entity_id = NEW.entity_id
          UNION ALL
          SELECT 1 FROM decisions existing
          WHERE existing.entity_type = NEW.entity_type
            AND existing.entity_id = NEW.entity_id
            AND existing.research_job_id IS NOT NULL
        )
      BEGIN
        SELECT RAISE(ABORT, 'V2 entity decision requires workflow lineage');
      END;
    `,
  },
  {
    version: 16,
    sql: `
      -- Unknown development metrics must stay unknown. Rebuild the table because
      -- SQLite cannot remove NOT NULL constraints in place.
      DROP TRIGGER IF EXISTS trg_decisions_complete_workflow_lineage;
      DROP TRIGGER IF EXISTS trg_decisions_v2_entity_requires_lineage;

      CREATE TABLE development_projects_v16 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        product_type TEXT NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        marketplace TEXT NOT NULL,
        supply_chain_relation TEXT NOT NULL DEFAULT '',
        market_node_id TEXT REFERENCES market_nodes(id),
        market_size REAL,
        growth_30d REAL,
        competition_score REAL,
        opportunity_score REAL,
        status TEXT NOT NULL CHECK (status IN ('develop', 'test', 'watch', 'reject')),
        score_breakdown_json TEXT NOT NULL,
        insight_id TEXT REFERENCES ai_insights(id),
        source_opportunity_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO development_projects_v16 (
        id, name, product_type, keywords_json, notes, marketplace,
        supply_chain_relation, market_node_id, market_size, growth_30d,
        competition_score, opportunity_score, status, score_breakdown_json,
        insight_id, source_opportunity_id, created_at, updated_at
      )
      SELECT
        id, name, product_type, keywords_json, notes, marketplace,
        supply_chain_relation, market_node_id,
        CASE WHEN market_size = 0 AND growth_30d = 0
          AND competition_score = 0 AND opportunity_score = 0
          AND NOT EXISTS (
            SELECT 1 FROM ai_insights insight
            WHERE insight.id = development_projects.insight_id
              AND TRIM(COALESCE(insight.evidence_json, '')) NOT IN ('', '[]', 'null')
          ) THEN NULL ELSE market_size END,
        CASE WHEN market_size = 0 AND growth_30d = 0
          AND competition_score = 0 AND opportunity_score = 0
          AND NOT EXISTS (
            SELECT 1 FROM ai_insights insight
            WHERE insight.id = development_projects.insight_id
              AND TRIM(COALESCE(insight.evidence_json, '')) NOT IN ('', '[]', 'null')
          ) THEN NULL ELSE growth_30d END,
        CASE WHEN market_size = 0 AND growth_30d = 0
          AND competition_score = 0 AND opportunity_score = 0
          AND NOT EXISTS (
            SELECT 1 FROM ai_insights insight
            WHERE insight.id = development_projects.insight_id
              AND TRIM(COALESCE(insight.evidence_json, '')) NOT IN ('', '[]', 'null')
          ) THEN NULL ELSE competition_score END,
        CASE WHEN market_size = 0 AND growth_30d = 0
          AND competition_score = 0 AND opportunity_score = 0
          AND NOT EXISTS (
            SELECT 1 FROM ai_insights insight
            WHERE insight.id = development_projects.insight_id
              AND TRIM(COALESCE(insight.evidence_json, '')) NOT IN ('', '[]', 'null')
          ) THEN NULL ELSE opportunity_score END,
        status,
        CASE WHEN market_size = 0 AND growth_30d = 0
          AND competition_score = 0 AND opportunity_score = 0
          AND NOT EXISTS (
            SELECT 1 FROM ai_insights insight
            WHERE insight.id = development_projects.insight_id
              AND TRIM(COALESCE(insight.evidence_json, '')) NOT IN ('', '[]', 'null')
          ) THEN 'null' ELSE score_breakdown_json END,
        insight_id, source_opportunity_id, created_at, updated_at
      FROM development_projects;
      DROP TABLE development_projects;
      ALTER TABLE development_projects_v16 RENAME TO development_projects;

      -- V15 references development_projects from the Decision trigger body.
      -- Recreate both triggers after the table swap so their definitions stay live.
      CREATE TRIGGER trg_decisions_complete_workflow_lineage
      BEFORE INSERT ON decisions
      WHEN NEW.research_job_id IS NOT NULL
        OR NEW.reverse_review_id IS NOT NULL
        OR NEW.approval_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'workflow decision requires complete lineage')
        WHERE NEW.research_job_id IS NULL
          OR NEW.reverse_review_id IS NULL
          OR NEW.approval_id IS NULL;

        SELECT RAISE(ABORT, 'workflow decision lineage is stale or mismatched')
        WHERE NOT EXISTS (
          SELECT 1
          FROM research_jobs job
          JOIN ai_insights insight ON insight.id = NEW.ai_insight_id
          JOIN reverse_reviews review ON review.id = NEW.reverse_review_id
          JOIN approvals approval ON approval.id = NEW.approval_id
          WHERE job.id = NEW.research_job_id
            AND NEW.data_version = job.data_version
            AND insight.research_job_id = job.id
            AND insight.data_version = job.data_version
            AND insight.prompt_version = job.prompt_version
            AND review.research_job_id = job.id
            AND review.data_version = job.data_version
            AND review.rule_profile_id = job.rule_profile_id
            AND review.rule_profile_version = job.rule_profile_version
            AND review.prompt_version = job.prompt_version
            AND approval.research_job_id = job.id
            AND approval.data_version = job.data_version
            AND approval.rule_profile_id = job.rule_profile_id
            AND approval.rule_profile_version = job.rule_profile_version
            AND approval.prompt_version = job.prompt_version
            AND approval.reverse_review_id = review.id
            AND (
              (
                NEW.entity_type = 'research_job'
                AND NEW.entity_id = job.id
                AND (
                  NEW.decision = approval.status
                  OR (NEW.decision = 'reject' AND approval.status = 'rejected')
                )
              )
              OR (
                NEW.entity_type = 'development_project'
                AND approval.status = 'approved'
                AND NEW.decision = approval.action
                AND (
                  (job.entity_type = 'development_project' AND job.entity_id = NEW.entity_id)
                  OR (
                    job.entity_type = 'opportunity'
                    AND EXISTS (
                      SELECT 1 FROM development_projects project
                      WHERE project.id = NEW.entity_id
                        AND project.source_opportunity_id = job.entity_id
                        AND project.marketplace = job.marketplace
                    )
                  )
                )
              )
            )
        );
      END;

      CREATE TRIGGER trg_decisions_v2_entity_requires_lineage
      BEFORE INSERT ON decisions
      WHEN NEW.entity_type IN ('development_project', 'opportunity')
        AND NEW.research_job_id IS NULL
        AND EXISTS (
          SELECT 1 FROM research_jobs job
          WHERE job.entity_type = NEW.entity_type AND job.entity_id = NEW.entity_id
          UNION ALL
          SELECT 1 FROM decisions existing
          WHERE existing.entity_type = NEW.entity_type
            AND existing.entity_id = NEW.entity_id
            AND existing.research_job_id IS NOT NULL
        )
      BEGIN
        SELECT RAISE(ABORT, 'V2 entity decision requires workflow lineage');
      END;
    `,
  },
  {
    version: 17,
    sql: `
      -- V16 may already be present in a local database. Correct legacy sentinel
      -- zeros in a follow-up migration, without changing evidence-backed zeroes.
      UPDATE development_projects
      SET market_size = NULL,
          growth_30d = NULL,
          competition_score = NULL,
          opportunity_score = NULL,
          score_breakdown_json = 'null'
      WHERE (market_size IS NULL OR market_size = 0)
        AND (growth_30d IS NULL OR growth_30d = 0)
        AND (competition_score IS NULL OR competition_score = 0)
        AND (opportunity_score IS NULL OR opportunity_score = 0)
        AND NOT EXISTS (
          SELECT 1 FROM ai_insights insight
          WHERE insight.id = development_projects.insight_id
            AND TRIM(COALESCE(insight.evidence_json, '')) NOT IN ('', '[]', 'null')
        );

      -- Early Opportunity Lab builds persisted two exact no-data placeholders.
      -- Remove only those unreferenced records, and first repair their owning
      -- ResearchResult ID arrays. Research trees and DataTasks remain intact.
      UPDATE research_results
      SET opportunity_ids_json = COALESCE((
        SELECT json_group_array(entry.value)
        FROM json_each(research_results.opportunity_ids_json) entry
        WHERE NOT EXISTS (
          SELECT 1 FROM opportunities candidate
          WHERE candidate.id = entry.value
            AND candidate.research_result_id = research_results.id
            AND candidate.source_type = 'ai_research'
            AND candidate.status = 'pending_review'
            AND candidate.opportunity_score = 0
            AND candidate.market_growth = 0
            AND candidate.competition_score = 0
            AND TRIM(candidate.evidence_json) = '[]'
            AND candidate.price_room = '待采集'
            AND (
              (
                candidate.recommended_action = '暂不进入机会池'
                AND candidate.summary = '没有真实数据，暂不生成机会结论。'
              )
              OR (
                candidate.recommended_action = '先完成数据采集'
                AND candidate.summary = '当前数据不足，仅完成市场拆解，不对机会做强结论。'
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM research_jobs job
              WHERE job.entity_type = 'opportunity' AND job.entity_id = candidate.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM decisions decision
              WHERE decision.entity_type = 'opportunity' AND decision.entity_id = candidate.id
            )
        )
      ), '[]')
      WHERE EXISTS (
        SELECT 1 FROM opportunities candidate
        WHERE candidate.research_result_id = research_results.id
          AND candidate.source_type = 'ai_research'
          AND candidate.status = 'pending_review'
          AND candidate.opportunity_score = 0
          AND candidate.market_growth = 0
          AND candidate.competition_score = 0
          AND TRIM(candidate.evidence_json) = '[]'
          AND candidate.price_room = '待采集'
          AND (
            (
              candidate.recommended_action = '暂不进入机会池'
              AND candidate.summary = '没有真实数据，暂不生成机会结论。'
            )
            OR (
              candidate.recommended_action = '先完成数据采集'
              AND candidate.summary = '当前数据不足，仅完成市场拆解，不对机会做强结论。'
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM research_jobs job
            WHERE job.entity_type = 'opportunity' AND job.entity_id = candidate.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM decisions decision
            WHERE decision.entity_type = 'opportunity' AND decision.entity_id = candidate.id
          )
      );

      DELETE FROM watchlist_items
      WHERE item_type = 'opportunity'
        AND item_id IN (
          SELECT candidate.id FROM opportunities candidate
          WHERE candidate.source_type = 'ai_research'
            AND candidate.research_result_id IS NOT NULL
            AND candidate.status = 'pending_review'
            AND candidate.opportunity_score = 0
            AND candidate.market_growth = 0
            AND candidate.competition_score = 0
            AND TRIM(candidate.evidence_json) = '[]'
            AND candidate.price_room = '待采集'
            AND (
              (
                candidate.recommended_action = '暂不进入机会池'
                AND candidate.summary = '没有真实数据，暂不生成机会结论。'
              )
              OR (
                candidate.recommended_action = '先完成数据采集'
                AND candidate.summary = '当前数据不足，仅完成市场拆解，不对机会做强结论。'
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM research_jobs job
              WHERE job.entity_type = 'opportunity' AND job.entity_id = candidate.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM decisions decision
              WHERE decision.entity_type = 'opportunity' AND decision.entity_id = candidate.id
            )
        );

      DELETE FROM opportunities
      WHERE source_type = 'ai_research'
        AND research_result_id IS NOT NULL
        AND status = 'pending_review'
        AND opportunity_score = 0
        AND market_growth = 0
        AND competition_score = 0
        AND TRIM(evidence_json) = '[]'
        AND price_room = '待采集'
        AND (
          (
            recommended_action = '暂不进入机会池'
            AND summary = '没有真实数据，暂不生成机会结论。'
          )
          OR (
            recommended_action = '先完成数据采集'
            AND summary = '当前数据不足，仅完成市场拆解，不对机会做强结论。'
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM research_jobs job
          WHERE job.entity_type = 'opportunity' AND job.entity_id = opportunities.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM decisions decision
          WHERE decision.entity_type = 'opportunity' AND decision.entity_id = opportunities.id
        )
        ;
    `,
  },
  {
    version: 18,
    sql: `
      -- Keep the legacy columns for a non-destructive migration of this widely
      -- referenced parent table. Canonical scores are nullable from this version.
      ALTER TABLE market_nodes RENAME COLUMN competition_score TO competition_score_legacy;
      ALTER TABLE market_nodes RENAME COLUMN opportunity_score TO opportunity_score_legacy;
      ALTER TABLE market_nodes ADD COLUMN competition_score REAL;
      ALTER TABLE market_nodes ADD COLUMN opportunity_score REAL;

      UPDATE market_nodes
      SET competition_score = competition_score_legacy,
          opportunity_score = opportunity_score_legacy
      WHERE EXISTS (
        SELECT 1
        FROM market_snapshots latest
        JOIN market_snapshots baseline
          ON baseline.market_node_id = latest.market_node_id
          AND baseline.id <> latest.id
        WHERE latest.market_node_id = market_nodes.id
          AND latest.rowid = (
            SELECT candidate.rowid FROM market_snapshots candidate
            WHERE candidate.market_node_id = market_nodes.id
            ORDER BY candidate.date DESC, candidate.collected_at DESC
            LIMIT 1
          )
          AND baseline.monthly_sales > 0
          AND CAST(julianday(latest.date) - julianday(baseline.date) AS INTEGER)
            BETWEEN 21 AND 45
      );
    `,
  },
  {
    version: 19,
    sql: `
      -- V18 was applied during development before its baseline condition was
      -- tightened. Make already-upgraded databases converge on the same state.
      UPDATE development_projects
      SET market_size = NULL,
          growth_30d = NULL,
          competition_score = NULL,
          opportunity_score = NULL,
          score_breakdown_json = 'null'
      WHERE (market_size IS NULL OR market_size = 0)
        AND (growth_30d IS NULL OR growth_30d = 0)
        AND (competition_score IS NULL OR competition_score = 0)
        AND (opportunity_score IS NULL OR opportunity_score = 0)
        AND NOT EXISTS (
          SELECT 1 FROM ai_insights insight
          WHERE insight.id = development_projects.insight_id
            AND TRIM(COALESCE(insight.evidence_json, '')) NOT IN ('', '[]', 'null')
        );

      UPDATE market_nodes
      SET competition_score = NULL,
          opportunity_score = NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM market_snapshots latest
        JOIN market_snapshots baseline
          ON baseline.market_node_id = latest.market_node_id
          AND baseline.id <> latest.id
        WHERE latest.market_node_id = market_nodes.id
          AND latest.rowid = (
            SELECT candidate.rowid FROM market_snapshots candidate
            WHERE candidate.market_node_id = market_nodes.id
            ORDER BY candidate.date DESC, candidate.collected_at DESC
            LIMIT 1
          )
          AND baseline.monthly_sales > 0
          AND CAST(julianday(latest.date) - julianday(baseline.date) AS INTEGER)
            BETWEEN 21 AND 45
      );
    `,
  },
  {
    version: 20,
    apply(database: DatabaseSync): void {
      // Some narrow historical test fixtures intentionally model only the V13
      // workflow tables while marking later migrations applied. A real V19
      // database always has this foundational table pair.
      const hasProductSnapshots = database.prepare(`
        SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'product_snapshots'
      `).get();
      if (!hasProductSnapshots) {
        throw new Error('V20 requires the V19 product_snapshots table. Refusing to mark a partial schema migrated.');
      }

      database.exec(`
        ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'inactive'));
        ALTER TABLE products ADD COLUMN updated_at TEXT;
        ALTER TABLE products ADD COLUMN variation_family_id TEXT;
        ALTER TABLE products ADD COLUMN parent_asin TEXT;
        ALTER TABLE products ADD COLUMN is_parent INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN variation_attributes_json TEXT NOT NULL DEFAULT '{}';

        CREATE TABLE variation_families (
          id TEXT PRIMARY KEY,
          marketplace TEXT NOT NULL,
          parent_asin TEXT NOT NULL,
          variation_theme TEXT,
          attributes_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(marketplace, parent_asin)
        );
        CREATE INDEX idx_variation_families_market_parent
          ON variation_families(marketplace, parent_asin);
        CREATE INDEX idx_products_identity_asin
          ON products(marketplace, asin);
        CREATE INDEX idx_products_identity_sku
          ON products(marketplace, sku);
        -- Preserve every legacy product row. The deterministic oldest row keeps
        -- its canonical SKU; later case-insensitive collisions become archival.
        UPDATE products
        SET sku = sku || '#legacy-' || id
        WHERE sku IS NOT NULL AND rowid NOT IN (
          SELECT MIN(rowid) FROM products
          WHERE sku IS NOT NULL AND TRIM(sku) <> ''
          GROUP BY marketplace, UPPER(TRIM(sku))
        );
        CREATE UNIQUE INDEX idx_products_marketplace_normalized_sku
          ON products(marketplace, UPPER(TRIM(sku)))
          WHERE sku IS NOT NULL AND TRIM(sku) <> '';
        CREATE INDEX idx_products_variation_family
          ON products(variation_family_id);

        ALTER TABLE market_snapshots ADD COLUMN observation_date TEXT;
        ALTER TABLE market_snapshots ADD COLUMN dedup_key TEXT;
        ALTER TABLE product_snapshots ADD COLUMN observation_date TEXT;
        ALTER TABLE product_snapshots ADD COLUMN dedup_key TEXT;

        -- V7's immutable triggers protect business observations. This migration
        -- only fills new identity columns before rebuilding the same rows below.
        DROP TRIGGER IF EXISTS trg_market_snapshots_immutable;
        DROP TRIGGER IF EXISTS trg_product_snapshots_immutable;

        UPDATE market_snapshots
        SET observation_date = date,
            dedup_key = 'market|'
              || COALESCE((SELECT marketplace FROM market_nodes WHERE market_nodes.id = market_snapshots.market_node_id), '')
              || '|' || market_node_id || '|' || date || '|' || lower(trim(source_type))
              || '|' || lower(trim(source)) || '|' || period
              || CASE WHEN rowid = (
                SELECT MIN(candidate.rowid) FROM market_snapshots candidate
                WHERE candidate.market_node_id = market_snapshots.market_node_id
                  AND candidate.date = market_snapshots.date
                  AND lower(trim(candidate.source_type)) = lower(trim(market_snapshots.source_type))
                  AND lower(trim(candidate.source)) = lower(trim(market_snapshots.source))
                  AND candidate.period = market_snapshots.period
              ) THEN '' ELSE '|archival|' || id END
        WHERE observation_date IS NULL OR dedup_key IS NULL;
        CREATE UNIQUE INDEX idx_market_snapshots_dedup_key
          ON market_snapshots(dedup_key) WHERE dedup_key IS NOT NULL;
        CREATE INDEX idx_market_snapshots_observation
          ON market_snapshots(market_node_id, observation_date DESC);

        UPDATE product_snapshots
        SET observation_date = date,
            dedup_key = 'product|'
              || COALESCE((SELECT marketplace FROM products WHERE products.id = product_snapshots.product_id), '')
              || '|' || product_id || '|' || date || '|' || lower(trim(source_type))
              || '|' || lower(trim(source)) || '|' || period
              || CASE WHEN rowid = (
                SELECT MIN(candidate.rowid) FROM product_snapshots candidate
                WHERE candidate.product_id = product_snapshots.product_id
                  AND candidate.date = product_snapshots.date
                  AND lower(trim(candidate.source_type)) = lower(trim(product_snapshots.source_type))
                  AND lower(trim(candidate.source)) = lower(trim(product_snapshots.source))
                  AND candidate.period = product_snapshots.period
              ) THEN '' ELSE '|archival|' || id END
        WHERE observation_date IS NULL OR dedup_key IS NULL;
        CREATE UNIQUE INDEX idx_product_snapshots_dedup_key
          ON product_snapshots(dedup_key) WHERE dedup_key IS NOT NULL;
        CREATE INDEX idx_product_snapshots_observation
          ON product_snapshots(product_id, observation_date DESC);

        DROP INDEX IF EXISTS idx_market_snapshots_node_date;
        DROP INDEX IF EXISTS idx_market_snapshots_dedup_key;
        DROP INDEX IF EXISTS idx_market_snapshots_observation;
        DROP INDEX IF EXISTS idx_product_snapshots_product_date;
        DROP INDEX IF EXISTS idx_product_snapshots_dedup_key;
        DROP INDEX IF EXISTS idx_product_snapshots_observation;
        ALTER TABLE market_snapshots RENAME TO market_snapshots_v19;
        ALTER TABLE product_snapshots RENAME TO product_snapshots_v19;

        CREATE TABLE market_snapshots (
          id TEXT PRIMARY KEY,
          market_node_id TEXT NOT NULL REFERENCES market_nodes(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          product_count INTEGER,
          seller_count INTEGER,
          brand_count INTEGER,
          monthly_sales REAL,
          monthly_revenue REAL,
          avg_price REAL,
          median_price REAL,
          avg_rating REAL,
          median_reviews REAL,
          top10_share REAL,
          top20_share REAL,
          new_product_share REAL,
          price_bands_json TEXT,
          concentration_json TEXT,
          source TEXT NOT NULL,
          source_type TEXT NOT NULL,
          collected_at TEXT NOT NULL,
          period TEXT NOT NULL,
          is_estimated INTEGER NOT NULL,
          confidence REAL NOT NULL,
          observation_date TEXT NOT NULL,
          dedup_key TEXT NOT NULL
        );
        INSERT INTO market_snapshots (
          id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
          monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
          top20_share, new_product_share, price_bands_json, concentration_json, source,
          source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
        ) SELECT
          id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
          monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
          top20_share, new_product_share, price_bands_json, concentration_json, source,
          source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
        FROM market_snapshots_v19;
        DROP TABLE market_snapshots_v19;
        CREATE INDEX idx_market_snapshots_node_date
          ON market_snapshots(market_node_id, date DESC);
        CREATE UNIQUE INDEX idx_market_snapshots_dedup_key
          ON market_snapshots(dedup_key);
        CREATE INDEX idx_market_snapshots_observation
          ON market_snapshots(market_node_id, observation_date DESC);
        CREATE TRIGGER trg_market_snapshots_immutable
        BEFORE UPDATE ON market_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'market_snapshots are immutable; append a new snapshot');
        END;

        CREATE TABLE product_snapshots (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          date TEXT NOT NULL,
          price REAL,
          rating REAL,
          review_count INTEGER,
          bsr INTEGER,
          estimated_sales REAL,
          estimated_revenue REAL,
          seller_count INTEGER,
          growth_7d REAL,
          growth_30d REAL,
          growth_90d REAL,
          source TEXT NOT NULL,
          source_type TEXT NOT NULL,
          collected_at TEXT NOT NULL,
          period TEXT NOT NULL,
          is_estimated INTEGER NOT NULL,
          confidence REAL NOT NULL,
          observation_date TEXT NOT NULL,
          dedup_key TEXT NOT NULL
        );
        INSERT INTO product_snapshots (
          id, product_id, date, price, rating, review_count, bsr, estimated_sales,
          estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d, source,
          source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
        ) SELECT
          id, product_id, date, price, rating, review_count, bsr, estimated_sales,
          estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d, source,
          source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
        FROM product_snapshots_v19;
        DROP TABLE product_snapshots_v19;
        CREATE INDEX idx_product_snapshots_product_date
          ON product_snapshots(product_id, date DESC);
        CREATE UNIQUE INDEX idx_product_snapshots_dedup_key
          ON product_snapshots(dedup_key);
        CREATE INDEX idx_product_snapshots_observation
          ON product_snapshots(product_id, observation_date DESC);
        CREATE TRIGGER trg_product_snapshots_immutable
        BEFORE UPDATE ON product_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'product_snapshots are immutable; append a new snapshot');
        END;

        CREATE TABLE provider_capability_snapshots (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          collected_at TEXT NOT NULL,
          expires_at TEXT
        );
        CREATE INDEX idx_provider_capabilities_provider_collected
          ON provider_capability_snapshots(provider_id, collected_at DESC);

        CREATE TABLE mcp_call_logs (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          capability TEXT NOT NULL,
          actual_tool TEXT,
          request_hash TEXT NOT NULL,
          parameter_hash TEXT,
          research_job_id TEXT,
          entity_type TEXT,
          entity_id TEXT,
          status TEXT NOT NULL,
          cache_hit INTEGER NOT NULL DEFAULT 0,
          result_count INTEGER,
          response_metadata_json TEXT NOT NULL DEFAULT '{}',
          error_code TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          duration_ms INTEGER
        );
        CREATE INDEX idx_mcp_call_logs_provider_started
          ON mcp_call_logs(provider_id, started_at DESC);

        CREATE TABLE mcp_response_cache (
          cache_key TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_mcp_response_cache_expiry ON mcp_response_cache(expires_at);

        CREATE TABLE competitor_candidates (
          id TEXT PRIMARY KEY,
          marketplace TEXT NOT NULL,
          asin TEXT NOT NULL,
          source_product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          source TEXT NOT NULL,
          source_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL CHECK (status IN ('pending_review', 'confirmed', 'rejected')),
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          UNIQUE(marketplace, source_product_id, asin)
        );
        CREATE INDEX idx_competitor_candidates_review
          ON competitor_candidates(marketplace, status, created_at DESC);

        CREATE TABLE data_coverage_runs (
          id TEXT PRIMARY KEY,
          marketplace TEXT NOT NULL,
          run_type TEXT NOT NULL,
          coverage_json TEXT NOT NULL,
          is_complete INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_data_coverage_runs_market_created
          ON data_coverage_runs(marketplace, created_at DESC);

        -- Facts are independently persisted so a provider's missing metric is
        -- represented as NULL rather than inventing a 0 for legacy snapshots.
        CREATE TABLE metric_facts (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'market', 'competitor')),
          entity_id TEXT NOT NULL,
          marketplace TEXT NOT NULL,
          metric_name TEXT NOT NULL,
          numeric_value REAL,
          source TEXT NOT NULL,
          source_id TEXT,
          source_type TEXT NOT NULL,
          is_estimated INTEGER NOT NULL,
          confidence REAL NOT NULL,
          observation_date TEXT NOT NULL,
          collected_at TEXT NOT NULL,
          dedup_key TEXT
        );
        CREATE UNIQUE INDEX idx_metric_facts_dedup_key
          ON metric_facts(dedup_key) WHERE dedup_key IS NOT NULL;
        CREATE INDEX idx_metric_facts_authority
          ON metric_facts(entity_type, entity_id, metric_name, observation_date DESC);

        CREATE TABLE demo_seed_records (
          seed_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (seed_id, table_name, record_id)
        );
        CREATE INDEX idx_demo_seed_records_table ON demo_seed_records(table_name, record_id);
      `);
    },
  },
  {
    version: 21,
    apply(database: DatabaseSync): void {
      // V20 may already have been applied before the Demo registry existed.
      database.exec(`
        CREATE TABLE IF NOT EXISTS demo_seed_records (
          seed_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (seed_id, table_name, record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_demo_seed_records_table
          ON demo_seed_records(table_name, record_id);
      `);

      const seedTime = '2026-09-09T10:20:00+08:00';
      const source = '演示数据 / Mock Adapter';
      const register = (
        table: string, id: string, predicate: string, ...parameters: Array<string | number>
      ): void => {
        database.prepare(`
          INSERT OR IGNORE INTO demo_seed_records (seed_id, table_name, record_id, created_at)
          SELECT 'v2-demo-seed', ?, id, ? FROM ${table}
          WHERE id = ? AND ${predicate}
        `).run(table, seedTime, id, ...parameters);
      };
      const marketIds = [
        'mkt-pillow', 'mkt-memory-foam', 'mkt-cervical', 'mkt-contour',
        'mkt-ergonomic', 'mkt-neck-support', 'mkt-side-sleeper', 'mkt-back-sleeper',
        'mkt-other-memory', 'mkt-lumbar', 'mkt-travel', 'mkt-seat-cushion',
      ];
      for (const id of marketIds) {
        register('market_nodes', id, 'source_type = ? AND created_at = ?', 'mock', seedTime);
      }
      const products = [
        ['owned-sku-01', 'B0DEMO0001'], ['owned-sku-02', 'B0DEMO0002'],
        ['owned-sku-03', 'B0DEMO0003'], ['owned-sku-04', 'B0DEMO0004'],
        ['competitor-01', 'B0DEMO1001'], ['competitor-02', 'B0DEMO1002'],
        ['competitor-03', 'B0DEMO1003'], ['competitor-04', 'B0DEMO1004'],
        ['competitor-05', 'B0DEMO1005'], ['competitor-06', 'B0DEMO1006'],
        ['competitor-07', 'B0DEMO1007'], ['competitor-08', 'B0DEMO1008'],
      ] as const;
      for (const [id, asin] of products) {
        register('products', id, 'asin = ? AND source_type = ? AND created_at = ?', asin, 'mock', seedTime);
      }
      const registerMarketSnapshot = (id: string, marketId: string, date: string): void => {
        register(
          'market_snapshots', id,
          'market_node_id = ? AND date = ? AND source = ? AND source_type = ? AND collected_at = ?',
          marketId, date, source, 'mock', `${date}T10:20:00+08:00`,
        );
      };
      for (const date of [
        '2026-04-12', '2026-05-12', '2026-06-11',
        '2026-07-11', '2026-08-10', '2026-09-09',
      ]) registerMarketSnapshot(`ms-mfm-${date}`, 'mkt-memory-foam', date);
      for (const marketId of marketIds.filter((id) => id !== 'mkt-memory-foam')) {
        registerMarketSnapshot(`ms-${marketId}-prev`, marketId, '2026-08-10');
        registerMarketSnapshot(`ms-${marketId}-current`, marketId, '2026-09-09');
      }
      for (const [id] of products) {
        const dates = id.startsWith('owned-sku-')
          ? ['2026-06-11', '2026-07-11', '2026-08-10', '2026-09-09']
          : ['2026-08-10', '2026-09-09'];
        dates.forEach((date, index) => register(
          'product_snapshots', `ps-${id}-${index + 1}`,
          'product_id = ? AND date = ? AND source = ? AND source_type = ? AND collected_at = ?',
          id, date, source, 'mock', `${date}T10:20:00+08:00`,
        ));
      }
      const relations = [
        ['owned-sku-01', 'competitor-03'], ['owned-sku-01', 'competitor-08'],
        ['owned-sku-01', 'competitor-01'], ['owned-sku-02', 'competitor-07'],
        ['owned-sku-02', 'competitor-01'], ['owned-sku-02', 'competitor-04'],
        ['owned-sku-03', 'competitor-02'], ['owned-sku-03', 'competitor-06'],
        ['owned-sku-03', 'competitor-05'], ['owned-sku-04', 'competitor-05'],
        ['owned-sku-04', 'competitor-03'], ['owned-sku-04', 'competitor-08'],
      ] as const;
      relations.forEach(([owned, competitor], index) => register(
        'competitor_relations', `relation-${index + 1}`,
        'owned_product_id = ? AND competitor_product_id = ? AND created_at = ?',
        owned, competitor, seedTime,
      ));
      for (const id of [
        'insight-market-memory', 'insight-owned-sku-01', 'insight-owned-sku-02',
        'insight-owned-sku-03', 'insight-owned-sku-04', 'insight-dev-lumbar',
        'insight-dev-travel', 'insight-dev-seat',
      ]) register(
        'ai_insights', id, 'input_hash = ? AND data_version = ? AND generated_at = ?',
        `seed-${id}`, 'demo-2026-09-09', seedTime,
      );
      for (const [id, insightId] of [
        ['dev-lumbar', 'insight-dev-lumbar'],
        ['dev-travel', 'insight-dev-travel'],
        ['dev-seat', 'insight-dev-seat'],
      ]) register('development_projects', id, 'insight_id = ? AND updated_at = ?', insightId, seedTime);
      for (const id of ['opp-school-kit', 'opp-travel-desk', 'opp-cooling-lumbar']) {
        register('opportunities', id, 'updated_at = ?', seedTime);
      }
      register('research_results', 'research-demo-school', 'generated_at = ?', seedTime);
      for (const id of ['watch-market', 'watch-sku03', 'watch-comp04', 'watch-lumbar']) {
        register('watchlist_items', id, 'created_at = ?', '2026-08-30T10:00:00+08:00');
      }
      for (const id of ['task-demo-1', 'task-demo-2', 'task-demo-3']) {
        register('data_tasks', id, 'source_id = ? AND source = ?', 'source-mock', source);
      }
    },
  },
  {
    version: 22,
    sql: `
      ALTER TABLE mcp_call_logs ADD COLUMN sync_run_id TEXT REFERENCES data_tasks(id);
      ALTER TABLE market_snapshots ADD COLUMN sync_run_id TEXT REFERENCES data_tasks(id);
      ALTER TABLE product_snapshots ADD COLUMN sync_run_id TEXT REFERENCES data_tasks(id);
      ALTER TABLE metric_facts ADD COLUMN sync_run_id TEXT REFERENCES data_tasks(id);
      ALTER TABLE data_tasks ADD COLUMN sync_run_id TEXT;
      ALTER TABLE evidence_records ADD COLUMN sync_run_id TEXT REFERENCES data_tasks(id);

      CREATE TABLE mcp_sync_observation_links (
        sync_run_id TEXT NOT NULL REFERENCES data_tasks(id),
        snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('market', 'product')),
        snapshot_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('inserted', 'reused')),
        PRIMARY KEY (sync_run_id, snapshot_kind, snapshot_id)
      );
      CREATE INDEX idx_mcp_sync_links_run_entity
        ON mcp_sync_observation_links(sync_run_id, snapshot_kind, entity_id);
      CREATE INDEX idx_mcp_call_logs_sync_run ON mcp_call_logs(sync_run_id, capability, entity_id);
      CREATE INDEX idx_market_snapshots_sync_run ON market_snapshots(sync_run_id);
      CREATE INDEX idx_product_snapshots_sync_run ON product_snapshots(sync_run_id);
      CREATE INDEX idx_metric_facts_sync_run ON metric_facts(sync_run_id);
      CREATE INDEX idx_evidence_records_sync_run ON evidence_records(sync_run_id);
    `,
  },
  {
    version: 23,
    sql: `
      DROP INDEX IF EXISTS idx_mcp_sync_links_run_entity;
      ALTER TABLE mcp_sync_observation_links RENAME TO mcp_sync_observation_links_v22;
      CREATE TABLE mcp_sync_observation_links (
        sync_run_id TEXT NOT NULL REFERENCES data_tasks(id),
        snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('market', 'product', 'fact')),
        snapshot_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('inserted', 'reused')),
        PRIMARY KEY (sync_run_id, snapshot_kind, snapshot_id)
      );
      INSERT INTO mcp_sync_observation_links (
        sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
      ) SELECT sync_run_id, snapshot_kind, snapshot_id, entity_id, disposition
        FROM mcp_sync_observation_links_v22;
      DROP TABLE mcp_sync_observation_links_v22;
      CREATE INDEX idx_mcp_sync_links_run_entity
        ON mcp_sync_observation_links(sync_run_id, snapshot_kind, entity_id);
    `,
  },
  {
    version: 24,
    sql: `
      ALTER TABLE competitor_candidates
        ADD COLUMN sync_run_id TEXT REFERENCES data_tasks(id);
      CREATE INDEX idx_competitor_candidates_sync_run
        ON competitor_candidates(sync_run_id, source_product_id);

      CREATE TABLE competitor_candidate_run_links (
        sync_run_id TEXT NOT NULL REFERENCES data_tasks(id),
        candidate_id TEXT NOT NULL REFERENCES competitor_candidates(id),
        source_product_id TEXT NOT NULL REFERENCES products(id),
        disposition TEXT NOT NULL CHECK (disposition IN ('inserted', 'reused')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (sync_run_id, candidate_id)
      );
      CREATE INDEX idx_candidate_run_links_run_product
        ON competitor_candidate_run_links(sync_run_id, source_product_id, disposition);
      CREATE INDEX idx_candidate_run_links_candidate
        ON competitor_candidate_run_links(candidate_id, created_at DESC);
    `,
  },
  {
    version: 25,
    sql: `
      ALTER TABLE provider_capability_snapshots
        ADD COLUMN sync_run_id TEXT REFERENCES data_tasks(id);
      CREATE INDEX idx_provider_capabilities_sync_run
        ON provider_capability_snapshots(sync_run_id, collected_at DESC);
      CREATE INDEX idx_data_tasks_sync_run
        ON data_tasks(sync_run_id, task_type, status);
    `,
  },
  {
    version: 26,
    apply(database: DatabaseSync) {
      const table = database.prepare(`SELECT 1 AS found FROM sqlite_master
        WHERE type = 'table' AND name = 'mcp_call_logs'`).get() as { found: number } | undefined;
      if (!table) return;
      const columns = database.prepare('PRAGMA table_info(mcp_call_logs)').all()
        .map((column) => String(column.name));
      if (!columns.includes('observation_month')) {
        database.exec(`ALTER TABLE mcp_call_logs
          ADD COLUMN observation_month TEXT CHECK (observation_month IS NULL
            OR (observation_month GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
              AND substr(observation_month, 5, 2) BETWEEN '01' AND '12'))`);
      }
      if (columns.includes('sync_run_id')) {
        database.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_call_logs_run_market_month
          ON mcp_call_logs(sync_run_id, capability, entity_id, observation_month)`);
      }
    },
  },
  {
    version: 27,
    apply(database: DatabaseSync) {
      const table = database.prepare(`SELECT 1 AS found FROM sqlite_master
        WHERE type = 'table' AND name = 'market_nodes'`).get() as { found: number } | undefined;
      if (!table) return;
      const columns = database.prepare('PRAGMA table_info(market_nodes)').all()
        .map((column) => String(column.name));
      if (!columns.includes('sellersprite_confirmed_node_path')) {
        database.exec(`ALTER TABLE market_nodes
          ADD COLUMN sellersprite_confirmed_node_path TEXT CHECK (
            sellersprite_confirmed_node_path IS NULL OR (
              sellersprite_confirmed_node_path <> ''
              AND sellersprite_confirmed_node_path NOT GLOB '*[^0-9:]*'
              AND substr(sellersprite_confirmed_node_path, 1, 1) <> ':'
              AND substr(sellersprite_confirmed_node_path, -1, 1) <> ':'
              AND instr(sellersprite_confirmed_node_path, '::') = 0
            )
          )`);
      }
      if (columns.includes('category_id') && columns.includes('source_type')) {
        database.exec(`UPDATE market_nodes
          SET sellersprite_confirmed_node_path = category_id
          WHERE source_type = 'mcp'
            AND sellersprite_confirmed_node_path IS NULL
            AND category_id IS NOT NULL
            AND category_id <> ''
            AND category_id NOT GLOB '*[^0-9:]*'
            AND substr(category_id, 1, 1) <> ':'
            AND substr(category_id, -1, 1) <> ':'
            AND instr(category_id, '::') = 0`);
      }
    },
  },
  {
    version: 28,
    apply(database: DatabaseSync) {
      const tables = new Set((database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table'
          AND name IN ('products', 'variation_families')
      `).all() as Array<{ name: string }>).map((row) => row.name));
      if (!tables.has('products') || !tables.has('variation_families')) return;

      const familyColumns = database.prepare('PRAGMA table_info(variation_families)').all()
        .map((column) => String(column.name));
      if (!familyColumns.includes('family_key')) {
        const invalidFamily = database.prepare(`
          SELECT id, parent_asin AS parentAsin FROM variation_families
          WHERE LENGTH(TRIM(parent_asin)) <> 10
            OR UPPER(TRIM(parent_asin)) GLOB '*[^A-Z0-9]*'
          LIMIT 1
        `).get() as { id: string; parentAsin: string } | undefined;
        if (invalidFamily) {
          throw new Error(`V28 requires a verified parent ASIN for legacy family ${invalidFamily.id}; review its placeholder/invalid value before migration.`);
        }
        const duplicateParent = database.prepare(`
          SELECT marketplace, UPPER(TRIM(parent_asin)) AS parentAsin,
            COUNT(*) AS count FROM variation_families
          GROUP BY marketplace, UPPER(TRIM(parent_asin)) HAVING COUNT(*) > 1 LIMIT 1
        `).get() as { marketplace: string; parentAsin: string; count: number } | undefined;
        if (duplicateParent) {
          throw new Error(`V28 found duplicate normalized parent ASIN ${duplicateParent.parentAsin} in ${duplicateParent.marketplace}; review legacy families before migration.`);
        }
        assertVariationFamilyIntegrity(database, 28);
        const invalidProductParent = database.prepare(`
          SELECT id FROM products WHERE parent_asin IS NOT NULL
            AND TRIM(parent_asin) <> ''
            AND (LENGTH(TRIM(parent_asin)) <> 10
              OR UPPER(TRIM(parent_asin)) GLOB '*[^A-Z0-9]*')
          LIMIT 1
        `).get() as { id: string } | undefined;
        if (invalidProductParent) {
          throw new Error(`V28 found invalid parent ASIN for product ${invalidProductParent.id}; review legacy identity before migration.`);
        }
        database.exec(`
          DROP INDEX IF EXISTS idx_variation_families_market_parent;
          ALTER TABLE variation_families RENAME TO variation_families_v27;
          CREATE TABLE variation_families (
            id TEXT PRIMARY KEY,
            marketplace TEXT NOT NULL,
            parent_asin TEXT,
            family_key TEXT NOT NULL CHECK (TRIM(family_key) <> ''),
            variation_theme TEXT,
            attributes_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
            identity_status TEXT NOT NULL CHECK (identity_status IN ('pending', 'verified')),
            source_type TEXT NOT NULL CHECK (TRIM(source_type) <> ''),
            verified_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK (
              (identity_status = 'pending' AND parent_asin IS NULL AND verified_at IS NULL)
              OR
              (identity_status = 'verified' AND parent_asin IS NOT NULL
                AND TRIM(parent_asin) <> '' AND verified_at IS NOT NULL)
            )
          );
          INSERT INTO variation_families (
            id, marketplace, parent_asin, family_key, variation_theme,
            attributes_json, status, identity_status, source_type, verified_at,
            created_at, updated_at
          )
          SELECT legacy.id, legacy.marketplace, UPPER(TRIM(legacy.parent_asin)),
            UPPER(TRIM(legacy.parent_asin)),
            legacy.variation_theme, legacy.attributes_json, legacy.status,
            'verified', 'import', legacy.updated_at,
            legacy.created_at, legacy.updated_at
          FROM variation_families_v27 legacy;
          DROP TABLE variation_families_v27;
          CREATE UNIQUE INDEX idx_variation_families_market_family_key
            ON variation_families(marketplace, UPPER(TRIM(family_key)));
          CREATE UNIQUE INDEX idx_variation_families_market_parent
            ON variation_families(marketplace, UPPER(TRIM(parent_asin)))
            WHERE parent_asin IS NOT NULL AND TRIM(parent_asin) <> '';
        `);
      }

      const productColumns = database.prepare('PRAGMA table_info(products)').all()
        .map((column) => String(column.name));
      if (!productColumns.includes('parent_lookup_status')) {
        database.exec(`
          ALTER TABLE products ADD COLUMN parent_lookup_status TEXT NOT NULL DEFAULT 'unknown'
            CHECK (parent_lookup_status IN ('unknown', 'pending', 'verified', 'standalone'));
          UPDATE products SET parent_asin = UPPER(TRIM(parent_asin))
            WHERE parent_asin IS NOT NULL AND TRIM(parent_asin) <> '';
          UPDATE products SET parent_lookup_status = CASE
            WHEN parent_asin IS NOT NULL AND TRIM(parent_asin) <> '' THEN 'verified'
            WHEN variation_family_id IS NOT NULL THEN 'pending'
            ELSE 'unknown'
          END;
        `);
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS product_identity_events (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id),
          old_family_id TEXT REFERENCES variation_families(id),
          new_family_id TEXT REFERENCES variation_families(id),
          old_parent_asin TEXT,
          new_parent_asin TEXT,
          old_lookup_status TEXT CHECK (old_lookup_status IS NULL OR old_lookup_status IN (
            'unknown', 'pending', 'verified', 'standalone'
          )),
          new_lookup_status TEXT NOT NULL CHECK (new_lookup_status IN (
            'unknown', 'pending', 'verified', 'standalone'
          )),
          source_type TEXT NOT NULL CHECK (TRIM(source_type) <> ''),
          sync_run_id TEXT REFERENCES data_tasks(id),
          import_batch_id TEXT REFERENCES import_batches(id),
          created_at TEXT NOT NULL,
          CHECK (
            old_family_id IS NOT new_family_id
            OR old_parent_asin IS NOT new_parent_asin
            OR old_lookup_status IS NOT new_lookup_status
          )
        );
        CREATE INDEX IF NOT EXISTS idx_product_identity_events_product
          ON product_identity_events(product_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_product_identity_events_family
          ON product_identity_events(new_family_id, created_at, id);
        CREATE TRIGGER IF NOT EXISTS trg_product_identity_events_immutable_update
        BEFORE UPDATE ON product_identity_events
        BEGIN
          SELECT RAISE(ABORT, 'product_identity_events are immutable; append a new event');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_product_identity_events_immutable_delete
        BEFORE DELETE ON product_identity_events
        BEGIN
          SELECT RAISE(ABORT, 'product_identity_events are immutable; append a new event');
        END;
      `);
    },
  },
  {
    version: 29,
    apply(database: DatabaseSync) {
      const tables = new Set((database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table'
          AND name IN ('products', 'variation_families')
      `).all() as Array<{ name: string }>).map((row) => row.name));
      if (!tables.has('products') || !tables.has('variation_families')) return;
      assertVariationFamilyIntegrity(database, 29);
      database.exec(`
        CREATE TRIGGER trg_products_variation_family_insert
        BEFORE INSERT ON products
        WHEN NEW.variation_family_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM variation_families family
          WHERE family.id = NEW.variation_family_id AND family.marketplace = NEW.marketplace
        )
        BEGIN
          SELECT RAISE(ABORT, 'variation family must exist in product marketplace');
        END;

        CREATE TRIGGER trg_products_variation_family_update
        BEFORE UPDATE OF variation_family_id, marketplace ON products
        WHEN NEW.variation_family_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM variation_families family
          WHERE family.id = NEW.variation_family_id AND family.marketplace = NEW.marketplace
        )
        BEGIN
          SELECT RAISE(ABORT, 'variation family must exist in product marketplace');
        END;

        CREATE TRIGGER trg_variation_families_marketplace_update
        BEFORE UPDATE OF id, marketplace ON variation_families
        WHEN EXISTS (
          SELECT 1 FROM products product
          WHERE product.variation_family_id = OLD.id
            AND (NEW.id <> OLD.id OR product.marketplace <> NEW.marketplace)
        )
        BEGIN
          SELECT RAISE(ABORT, 'variation family must remain in product marketplace');
        END;

        CREATE TRIGGER trg_variation_families_referenced_delete
        BEFORE DELETE ON variation_families
        WHEN EXISTS (
          SELECT 1 FROM products product WHERE product.variation_family_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'variation family is still referenced by products');
        END;
      `);
    },
  },
  {
    version: 30,
    sql: `
      CREATE TABLE owned_roster_declarations (
        marketplace TEXT PRIMARY KEY,
        declared_count INTEGER NOT NULL CHECK (declared_count > 0),
        declared_digest TEXT NOT NULL CHECK (LENGTH(declared_digest) = 64),
        expected_count INTEGER CHECK (expected_count IS NULL OR expected_count >= 0),
        expected_digest TEXT CHECK (expected_digest IS NULL OR LENGTH(expected_digest) = 64),
        preview_digest TEXT NOT NULL CHECK (LENGTH(preview_digest) = 64),
        status TEXT NOT NULL CHECK (status IN ('pending_validation', 'confirmed')),
        import_batch_id TEXT REFERENCES import_batches(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'pending_validation' AND expected_count IS NULL
          AND expected_digest IS NULL AND import_batch_id IS NULL)
          OR (status = 'confirmed' AND expected_count IS NOT NULL
            AND expected_digest IS NOT NULL AND import_batch_id IS NOT NULL))
      );
    `,
  },
  {
    version: 31,
    sql: `
      CREATE TABLE owned_roster_declaration_events (
        id TEXT PRIMARY KEY,
        marketplace TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (
          event_type IN ('declared', 'refreshed', 'superseded', 'confirmed')
        ),
        declared_count INTEGER NOT NULL CHECK (declared_count > 0),
        declared_digest TEXT NOT NULL CHECK (LENGTH(declared_digest) = 64),
        preview_digest TEXT NOT NULL CHECK (LENGTH(preview_digest) = 64),
        previous_preview_digest TEXT CHECK (
          previous_preview_digest IS NULL OR LENGTH(previous_preview_digest) = 64
        ),
        import_batch_id TEXT REFERENCES import_batches(id),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_owned_roster_events_marketplace
        ON owned_roster_declaration_events(marketplace, created_at, id);
      CREATE TRIGGER trg_owned_roster_events_immutable_update
      BEFORE UPDATE ON owned_roster_declaration_events
      BEGIN
        SELECT RAISE(ABORT, 'owned roster declaration events are immutable');
      END;
      CREATE TRIGGER trg_owned_roster_events_immutable_delete
      BEFORE DELETE ON owned_roster_declaration_events
      BEGIN
        SELECT RAISE(ABORT, 'owned roster declaration events are immutable');
      END;
    `,
  },
];

migrations.push({
  version: 32,
  sql: `
    CREATE TABLE provider_quota_state (
      provider_id TEXT PRIMARY KEY, baseline_remaining INTEGER NOT NULL CHECK(baseline_remaining >= 0),
      baseline_at TEXT NOT NULL, estimated_remote_calls_since_baseline INTEGER NOT NULL DEFAULT 0,
      reserved_calls INTEGER NOT NULL DEFAULT 100, period_end TEXT,
      updated_at TEXT NOT NULL, policy_json TEXT NOT NULL DEFAULT '{}',
      failure_code TEXT, failure_count INTEGER NOT NULL DEFAULT 0, open_until TEXT,
      half_open_until TEXT
    );
    INSERT INTO provider_quota_state(provider_id, baseline_remaining, baseline_at, updated_at)
      VALUES ('sellersprite', 500, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    CREATE TABLE mcp_usage_events (
      id TEXT PRIMARY KEY, request_key TEXT NOT NULL, outcome TEXT NOT NULL,
      sync_mode TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX idx_mcp_usage_time ON mcp_usage_events(created_at);
    CREATE TABLE mcp_local_observations (
      request_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, collected_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, historical_stable INTEGER NOT NULL DEFAULT 0,
      backfill_complete INTEGER NOT NULL DEFAULT 0, schema_hash TEXT NOT NULL,
      capability TEXT, scope_key TEXT
    );
    CREATE TABLE mcp_call_plans (
      id TEXT PRIMARY KEY, input_json TEXT NOT NULL, plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL, consumed_at TEXT
    );
    CREATE TABLE mcp_schema_pauses (capability TEXT PRIMARY KEY, schema_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE mcp_discovery_state (scope_key TEXT PRIMARY KEY, collected_at TEXT NOT NULL);
    CREATE TABLE mcp_request_leases (request_key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `,
});

migrations.push({ version: 33, sql: `
  CREATE TABLE mcp_market_reuse_lineage (
    sync_run_id TEXT NOT NULL REFERENCES data_tasks(id),
    snapshot_id TEXT NOT NULL REFERENCES market_snapshots(id),
    lineage_json TEXT NOT NULL CHECK(json_valid(lineage_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(sync_run_id,snapshot_id)
  );
  CREATE TRIGGER immutable_market_reuse_update BEFORE UPDATE ON mcp_market_reuse_lineage
    BEGIN SELECT RAISE(ABORT, 'Reuse lineage is immutable'); END;
  CREATE TRIGGER immutable_market_reuse_delete BEFORE DELETE ON mcp_market_reuse_lineage
    BEGIN SELECT RAISE(ABORT, 'Reuse lineage is immutable'); END;
` });

migrations.push({version:34,apply(database:DatabaseSync) { database.exec(`
  CREATE TABLE owned_roster_manual_confirmations (
    id TEXT PRIMARY KEY, marketplace TEXT NOT NULL, roster_digest TEXT NOT NULL,
    product_count INTEGER NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    confirmed_at TEXT NOT NULL
  );
  CREATE TRIGGER manual_roster_no_update BEFORE UPDATE ON owned_roster_manual_confirmations
    BEGIN SELECT RAISE(ABORT,'Manual roster evidence is immutable'); END;
  CREATE TRIGGER manual_roster_no_delete BEFORE DELETE ON owned_roster_manual_confirmations
    BEGIN SELECT RAISE(ABORT,'Manual roster evidence is immutable'); END;
  CREATE TABLE product_provider_enrichment (
    product_id TEXT PRIMARY KEY REFERENCES products(id),
    status TEXT NOT NULL CHECK(status IN ('pending','unavailable','available')),
    provider_status TEXT, remote_enabled INTEGER NOT NULL CHECK(remote_enabled IN (0,1)),
    node_id_path TEXT, title TEXT, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE owned_roster_declarations_v34 (
    marketplace TEXT PRIMARY KEY, declared_count INTEGER NOT NULL CHECK(declared_count>0),
    declared_digest TEXT NOT NULL CHECK(length(declared_digest)=64),
    expected_count INTEGER,expected_digest TEXT,preview_digest TEXT NOT NULL CHECK(length(preview_digest)=64),
    status TEXT NOT NULL CHECK(status IN ('pending_validation','confirmed')),
    import_batch_id TEXT REFERENCES import_batches(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    manual_confirmation_id TEXT REFERENCES owned_roster_manual_confirmations(id),
    CHECK((status='pending_validation' AND expected_count IS NULL AND expected_digest IS NULL
      AND import_batch_id IS NULL AND manual_confirmation_id IS NULL)
      OR (status='confirmed' AND expected_count IS NOT NULL AND expected_digest IS NOT NULL
        AND expected_count>=0 AND length(expected_digest)=64
        AND (import_batch_id IS NOT NULL OR manual_confirmation_id IS NOT NULL)))
  );
  `);
  if (Number(database.prepare('SELECT COUNT(*) n FROM owned_roster_declarations').get()!.n)>0) {
    database.exec('INSERT INTO owned_roster_declarations_v34 SELECT *,NULL FROM owned_roster_declarations');
  }
  database.exec(`
  DROP TABLE owned_roster_declarations;
  ALTER TABLE owned_roster_declarations_v34 RENAME TO owned_roster_declarations;
`); }});

migrations.push({ version: 35, apply(database: DatabaseSync) {
  // Narrow legacy fixtures may not include the optional discovery subsystem.
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='competitor_candidates'").get()) return;
  if (!database.prepare('PRAGMA table_info(competitor_candidates)').all().some(row => row.name==='sync_run_id')) return;
  database.exec(`
  ALTER TABLE competitor_candidates ADD COLUMN first_seen_at TEXT;
  ALTER TABLE competitor_candidates ADD COLUMN last_seen_at TEXT;
  UPDATE competitor_candidates SET first_seen_at=created_at,last_seen_at=created_at;
  CREATE TABLE competitor_candidate_observations (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES competitor_candidates(id),
    sync_run_id TEXT REFERENCES data_tasks(id), collected_at TEXT NOT NULL,
    price REAL, estimated_sales REAL, revenue REAL, rating REAL, review_count REAL, bsr REAL,
    title TEXT, brand TEXT, normalized_payload_json TEXT NOT NULL CHECK(json_valid(normalized_payload_json)),
    provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)), schema_hash TEXT,
    identity_review_required INTEGER NOT NULL DEFAULT 0 CHECK(identity_review_required IN (0,1)),
    legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1))
  );
  INSERT INTO competitor_candidate_observations
    (id,candidate_id,sync_run_id,collected_at,price,estimated_sales,revenue,rating,review_count,
     title,brand,normalized_payload_json,provenance_json,legacy)
    SELECT 'legacy:'||id,id,sync_run_id,created_at,json_extract(payload_json,'$.price'),
      json_extract(payload_json,'$.units'),json_extract(payload_json,'$.revenue'),
      json_extract(payload_json,'$.rating'),json_extract(payload_json,'$.ratings'),
      json_extract(payload_json,'$.title'),json_extract(payload_json,'$.brand'),payload_json,
      json_object('source',source,'sourceType',source_type,'legacy',1),1
    FROM competitor_candidates;
  CREATE INDEX candidate_observation_latest ON competitor_candidate_observations(candidate_id,collected_at DESC);
  CREATE TRIGGER candidate_observation_no_update BEFORE UPDATE ON competitor_candidate_observations
    BEGIN SELECT RAISE(ABORT,'Candidate observations are immutable'); END;
  CREATE TRIGGER candidate_observation_no_delete BEFORE DELETE ON competitor_candidate_observations
    BEGIN SELECT RAISE(ABORT,'Candidate observations are immutable'); END;
  ALTER TABLE competitor_candidate_run_links ADD COLUMN observation_id TEXT REFERENCES competitor_candidate_observations(id);
  CREATE TRIGGER failed_mcp_run_terminal BEFORE UPDATE OF status ON data_tasks
    WHEN OLD.status='failed' AND OLD.source='SellerSprite MCP' AND NEW.status<>'failed'
    BEGIN SELECT RAISE(ABORT,'Failed MCP runs are terminal'); END;
  CREATE TRIGGER failed_mcp_coverage_terminal BEFORE UPDATE OF is_complete ON data_coverage_runs
    WHEN NEW.is_complete=1 AND EXISTS(SELECT 1 FROM data_tasks WHERE id=NEW.id AND status='failed')
    BEGIN SELECT RAISE(ABORT,'Failed runs cannot satisfy coverage'); END;
`); } });

export function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      if ('apply' in migration && typeof migration.apply === 'function') migration.apply(database);
      else if (typeof migration.sql === 'string') database.exec(migration.sql);
      else throw new Error(`Migration ${migration.version} has no apply function or SQL.`);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
