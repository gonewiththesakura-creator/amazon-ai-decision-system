import { createHash, randomUUID } from 'node:crypto';
import type {
  AppSettings,
  BriefingItem,
  DashboardData,
  DataTask,
  DecisionRecord,
  DecisionType,
  DevelopmentProject,
  Evidence,
  Insight,
  Opportunity,
  Product,
  RelationType,
  ResearchJobDetail,
  ResearchNode,
  ResearchResult,
  ScoreBreakdown,
  WatchlistItem,
} from '../../shared/types.js';
import { MockAdapter } from '../adapters/mock-adapter.js';
import { disableDemoMode, seedDemoData } from '../database/demo-seed.js';
import type { AppDatabase } from '../database/database.js';
import { transaction } from '../database/database.js';
import { calculateMarketOpportunityMetrics, calculateOpportunityScore } from '../domain/calculations.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { WorkflowRepository } from '../repository/workflow-repository.js';
import { DeterministicAIService } from './ai-service.js';

type SqlRow = Record<string, string | number | bigint | null>;

export interface OwnedProductInput {
  asin: string;
  sku?: string;
  internalName?: string;
  brand: string;
  title: string;
  imageUrl?: string;
  marketplace?: string;
  productType?: string;
  marketNodeId?: string;
  keywords?: string[];
  monitoringEnabled?: boolean;
}

export interface OwnedProductPatch {
  sku?: string;
  internalName?: string;
  brand?: string;
  title?: string;
  imageUrl?: string;
  productType?: string;
  marketNodeId?: string;
  keywords?: string[];
  monitoringEnabled?: boolean;
}

export interface DevelopmentInput {
  name: string;
  productType: string;
  keywords: string[];
  notes?: string;
  marketplace?: string;
  supplyChainRelation?: string;
  marketNodeId?: string;
  sourceOpportunityId?: string;
}

export class IntelligenceService {
  readonly repository: IntelligenceRepository;
  readonly ai: DeterministicAIService;
  private readonly workflowRepository: WorkflowRepository;
  private readonly mockAdapter = new MockAdapter();

  constructor(private readonly database: AppDatabase) {
    this.repository = new IntelligenceRepository(database);
    this.ai = new DeterministicAIService(this.repository);
    this.workflowRepository = new WorkflowRepository(database, this.repository);
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const current = this.repository.getSettings();
    if (patch.aiModel !== undefined && patch.aiModel !== 'rule-engine-v1') {
      throw new Error('当前仅支持 rule-engine-v1；尚未配置真实模型 Provider。');
    }
    if (patch.mode !== undefined && patch.mode !== current.mode) {
      throw new Error('Demo 模式只能通过专用开关切换。');
    }
    const marketplace = patch.marketplace ?? current.marketplace;
    let defaultMarketId = patch.defaultMarketId ?? current.defaultMarketId;
    if (defaultMarketId) {
      const belongsToMarketplace = this.database.prepare(`
        SELECT id FROM market_nodes WHERE id = ? AND marketplace = ?
      `).get(defaultMarketId, marketplace);
      if (!belongsToMarketplace) defaultMarketId = '';
    }
    if (!defaultMarketId) {
      const fallback = this.database.prepare(`
        SELECT id FROM market_nodes WHERE marketplace = ?
        ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, level, created_at LIMIT 1
      `).get(marketplace) as { id: string } | undefined;
      defaultMarketId = fallback?.id ?? '';
    }
    const next: AppSettings = {
      ...current,
      ...patch,
      mode: current.mode,
      marketplace,
      defaultMarketId,
      lastSuccessfulSync: patch.lastSuccessfulSync === undefined
        ? current.lastSuccessfulSync
        : patch.lastSuccessfulSync,
    };
    this.database.prepare(`
      UPDATE app_settings SET mode = ?, role = ?, marketplace = ?, currency = ?, timezone = ?,
        default_market_id = ?, ai_model = ?, refresh_frequency = ?, last_successful_sync = ?
      WHERE id = 1
    `).run(
      next.mode, next.role, next.marketplace, next.currency, next.timezone, next.defaultMarketId,
      next.aiModel, next.refreshFrequency, next.lastSuccessfulSync,
    );
    return this.repository.getSettings();
  }

  setDemoMode(enabled: boolean): AppSettings {
    if (enabled) seedDemoData(this.database);
    else disableDemoMode(this.database);
    return this.repository.getSettings();
  }

  createOwnedProduct(input: OwnedProductInput): Product {
    const settings = this.repository.getSettings();
    const marketplace = settings.marketplace;
    const id = randomUUID();
    const now = new Date().toISOString();
    return transaction(this.database, () => {
      const marketNodeId = this.ensureDefaultMarket(
        input.marketNodeId,
        marketplace,
        input.productType ?? 'Memory Foam Pillow',
        input.keywords ?? [],
      );
      this.database.prepare(`
        INSERT INTO products (
          id, asin, sku, internal_name, brand, title, image_url, marketplace, product_type,
          is_owned, market_node_id, keywords_json, monitoring_enabled, source_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        id, input.asin.trim(), input.sku?.trim() ?? null, input.internalName?.trim() ?? null,
        input.brand.trim(), input.title.trim(), input.imageUrl?.trim() ?? '', marketplace,
        input.productType?.trim() ?? 'memory_foam_pillow', marketNodeId,
        JSON.stringify(input.keywords ?? []), input.monitoringEnabled ? 1 : 0,
        settings.mode === 'demo' ? 'mock' : 'import', now,
      );
      if (settings.mode === 'empty') {
        this.database.prepare(`UPDATE app_settings SET mode = 'live' WHERE id = 1`).run();
      }
      if (input.monitoringEnabled) {
        this.addWatchlist({
          itemType: 'owned_product', itemId: id,
          name: input.internalName ?? input.sku ?? input.asin,
          frequency: settings.refreshFrequency,
        });
      }
      const created = this.repository.getOwnedProduct(id);
      if (!created) throw new Error('自有产品创建失败。');
      return created;
    });
  }

  updateOwnedProduct(id: string, input: OwnedProductPatch): Product {
    const current = this.repository.getOwnedProduct(id);
    if (!current) throw new Error('自有产品不存在。');
    const marketplace = this.repository.getSettings().marketplace;
    const marketNodeId = input.marketNodeId ?? current.marketNodeId;
    const market = this.database.prepare(`
      SELECT id FROM market_nodes WHERE id = ? AND marketplace = ?
    `).get(marketNodeId, marketplace);
    if (!market) throw new Error('目标市场节点不存在于当前站点。');
    return transaction(this.database, () => {
      this.database.prepare(`
        UPDATE products SET sku = ?, internal_name = ?, brand = ?, title = ?, image_url = ?,
          product_type = ?, market_node_id = ?, keywords_json = ?, monitoring_enabled = ?
        WHERE id = ? AND is_owned = 1 AND marketplace = ?
      `).run(
        input.sku ?? current.sku ?? null,
        input.internalName ?? current.internalName ?? null,
        input.brand ?? current.brand,
        input.title ?? current.title,
        input.imageUrl ?? current.imageUrl,
        input.productType ?? current.productType,
        marketNodeId,
        JSON.stringify(input.keywords ?? current.keywords ?? []),
        (input.monitoringEnabled ?? current.monitoringEnabled) ? 1 : 0,
        id,
        marketplace,
      );
      const monitoringEnabled = input.monitoringEnabled ?? current.monitoringEnabled ?? false;
      if (monitoringEnabled) {
        this.addWatchlist({
          itemType: 'owned_product', itemId: id,
          name: input.internalName ?? input.sku ?? current.internalName ?? current.sku ?? current.asin,
          frequency: this.repository.getSettings().refreshFrequency,
        });
      } else {
        this.database.prepare(`
          DELETE FROM watchlist_items WHERE marketplace = ? AND item_type = 'owned_product' AND item_id = ?
        `).run(marketplace, id);
      }
      const updated = this.repository.getOwnedProduct(id);
      if (!updated) throw new Error('自有产品更新失败。');
      return updated;
    });
  }

  deleteOwnedProduct(id: string): boolean {
    if (!this.repository.getOwnedProduct(id)) throw new Error('自有产品不存在。');
    const marketplace = this.repository.getSettings().marketplace;
    const snapshotCount = this.database.prepare(`
      SELECT COUNT(*) AS count FROM product_snapshots WHERE product_id = ?
    `).get(id) as { count: number };
    if (Number(snapshotCount.count) > 0) {
      throw new Error('该 SKU 存在历史 Snapshot，不能删除；可关闭监控并保留审计记录。');
    }
    return transaction(this.database, () => {
      this.database.prepare(`
        DELETE FROM watchlist_items WHERE marketplace = ? AND item_type = 'owned_product' AND item_id = ?
      `).run(marketplace, id);
      this.database.prepare(`
        DELETE FROM ai_insights WHERE entity_type = 'owned_product' AND entity_id = ?
      `).run(id);
      this.database.prepare(`
        DELETE FROM decisions WHERE entity_type = 'owned_product' AND entity_id = ?
      `).run(id);
      const deleted = this.database.prepare(`
        DELETE FROM products WHERE id = ? AND is_owned = 1 AND marketplace = ?
      `).run(id, marketplace);
      return Number(deleted.changes) > 0;
    });
  }

  addCompetitor(ownedProductId: string, input: {
    competitorProductId?: string;
    asin?: string;
    brand?: string;
    title?: string;
    imageUrl?: string;
    relationType: RelationType;
    similarityScore?: number;
    reason?: string;
    aiTags?: string[];
  }): ReturnType<IntelligenceRepository['getCompetitors']>[number] {
    const owned = this.repository.getOwnedProduct(ownedProductId);
    if (!owned) throw new Error('自有产品不存在。');
    let competitorId = input.competitorProductId;
    if (!competitorId) {
      if (!input.asin) throw new Error('缺少竞品 ASIN。');
      const existing = this.database.prepare(`
        SELECT id FROM products WHERE asin = ? AND marketplace = ?
      `).get(input.asin, owned.marketplace) as { id: string } | undefined;
      competitorId = existing?.id ?? randomUUID();
      if (!existing) {
        this.database.prepare(`
          INSERT INTO products (
            id, asin, brand, title, image_url, marketplace, product_type, is_owned,
            market_node_id, keywords_json, monitoring_enabled, source_type, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'competitor', 0, ?, '[]', 0, 'import', ?)
        `).run(
          competitorId, input.asin, input.brand ?? '未知品牌', input.title ?? input.asin,
          input.imageUrl ?? '', owned.marketplace, owned.marketNodeId, new Date().toISOString(),
        );
      }
    }
    const competitor = this.database.prepare(`
      SELECT id, marketplace, is_owned FROM products WHERE id = ?
    `).get(competitorId) as { id: string; marketplace: string; is_owned: number } | undefined;
    if (!competitor) throw new Error('竞品不存在。');
    if (competitor.marketplace !== owned.marketplace) {
      throw new Error(`竞品属于 ${competitor.marketplace} 站点，不能关联到 ${owned.marketplace} 自有产品。`);
    }
    if (competitor.id === owned.id || competitor.is_owned === 1) {
      throw new Error('自有产品不能作为竞品关联。');
    }
    this.database.prepare(`
      INSERT INTO competitor_relations (
        id, owned_product_id, competitor_product_id, relation_type, similarity_score,
        reason, ai_tags_json, created_at, last_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owned_product_id, competitor_product_id, relation_type)
      DO UPDATE SET similarity_score = excluded.similarity_score, reason = excluded.reason,
        ai_tags_json = excluded.ai_tags_json, last_verified_at = excluded.last_verified_at
    `).run(
      randomUUID(), ownedProductId, competitorId, input.relationType,
      input.similarityScore ?? 0, input.reason ?? '', JSON.stringify(input.aiTags ?? []),
      new Date().toISOString(), new Date().toISOString(),
    );
    const relation = this.repository.getCompetitors(ownedProductId)
      .find((item) => item.id === competitorId && item.relationType === input.relationType);
    if (!relation) throw new Error('竞品关系创建失败。');
    return relation;
  }

  updateCompetitorRelation(
    ownedProductId: string,
    competitorProductId: string,
    input: {
      currentRelationType: RelationType;
      relationType?: RelationType;
      similarityScore?: number;
      reason?: string;
      aiTags?: string[];
    },
  ): ReturnType<IntelligenceRepository['getCompetitors']>[number] {
    if (!this.repository.getOwnedProduct(ownedProductId)) throw new Error('自有产品不存在。');
    const current = this.repository.getCompetitors(ownedProductId).find((item) => (
      item.id === competitorProductId && item.relationType === input.currentRelationType
    ));
    if (!current) throw new Error('竞品关系不存在。');
    const relationType = input.relationType ?? current.relationType;
    this.database.prepare(`
      UPDATE competitor_relations SET relation_type = ?, similarity_score = ?, reason = ?,
        ai_tags_json = ?, last_verified_at = ?
      WHERE owned_product_id = ? AND competitor_product_id = ? AND relation_type = ?
    `).run(
      relationType, input.similarityScore ?? current.similarityScore,
      input.reason ?? current.relationReason, JSON.stringify(input.aiTags ?? current.aiTags),
      new Date().toISOString(),
      ownedProductId, competitorProductId, input.currentRelationType,
    );
    const updated = this.repository.getCompetitors(ownedProductId).find((item) => (
      item.id === competitorProductId && item.relationType === relationType
    ));
    if (!updated) throw new Error('竞品关系更新失败。');
    return updated;
  }

  deleteCompetitorRelation(
    ownedProductId: string,
    competitorProductId: string,
    relationType: RelationType,
  ): boolean {
    if (!this.repository.getOwnedProduct(ownedProductId)) throw new Error('自有产品不存在。');
    const result = this.database.prepare(`
      DELETE FROM competitor_relations
      WHERE owned_product_id = ? AND competitor_product_id = ? AND relation_type = ?
    `).run(ownedProductId, competitorProductId, relationType);
    return Number(result.changes) > 0;
  }

  async createDevelopmentProject(
    input: DevelopmentInput,
    approvedJob?: ResearchJobDetail,
  ): Promise<DevelopmentProject> {
    const settings = this.repository.getSettings();
    const marketplace = settings.marketplace;
    const expandedKeywords = expandDevelopmentKeywords(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const metrics = settings.mode === 'demo'
      ? await this.mockAdapter.fetchMarketOverview({ marketplace, keywords: expandedKeywords })
      : null;
    const breakdown = metrics
      ? deterministicBreakdown(`${input.name}:${input.keywords.join('|')}`)
      : null;
    const score = breakdown ? calculateOpportunityScore(breakdown) : null;
    const status: DecisionType = 'watch';
    transaction(this.database, () => {
      const linkedMarket = input.marketNodeId ? this.repository.getMarket(input.marketNodeId) : null;
      const research = linkedMarket?.node.marketplace === marketplace
        ? { leafId: linkedMarket.node.id, nodeIds: [linkedMarket.node.id] }
        : this.createDevelopmentMarketHierarchy(input, marketplace, expandedKeywords);
      const marketNodeId = research.leafId;
      this.database.prepare(`
        INSERT INTO development_projects (
          id, name, product_type, keywords_json, notes, marketplace, supply_chain_relation,
          market_node_id, market_size, growth_30d, competition_score, opportunity_score,
          status, score_breakdown_json, source_opportunity_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.name, input.productType, JSON.stringify(expandedKeywords), input.notes ?? '',
        marketplace, input.supplyChainRelation ?? '', marketNodeId,
        metrics?.monthlyRevenue ?? null, metrics ? scoreSeed(`${input.name}:growth`, -4, 24) : null,
        metrics ? scoreSeed(`${input.name}:competition`, 35, 85) : null,
        score, status,
        JSON.stringify(breakdown), input.sourceOpportunityId ?? null, now, now,
      );
      const recomputed = this.recomputeDevelopmentProjectMetrics(id);
      this.createDataTaskRecord({
        name: `${input.name} 市场研究`, taskType: 'development_research', target: id,
        source: settings.mode === 'demo' ? this.mockAdapter.name : '待配置数据源',
        status: settings.mode === 'demo' || recomputed ? 'success' : 'pending',
        total: settings.mode === 'demo' || recomputed ? 1 : 0,
        success: settings.mode === 'demo' || recomputed ? 1 : 0,
      });
      if (!linkedMarket) {
        research.nodeIds.forEach((nodeId) => this.createDataTaskRecord({
          name: `${input.name} 节点数据采集`, taskType: 'development_market_research', target: nodeId,
          source: settings.mode === 'demo' ? this.mockAdapter.name : '待配置数据源',
          status: settings.mode === 'demo' ? 'success' : 'pending',
          total: settings.mode === 'demo' ? 1 : 0, success: settings.mode === 'demo' ? 1 : 0,
        }));
      }
      this.addWatchlist({
        itemType: 'development_project', itemId: id, name: input.name,
        frequency: settings.refreshFrequency,
      });
      if (approvedJob?.latestInsight) {
        this.database.prepare(`
          UPDATE development_projects SET insight_id = ?, updated_at = ? WHERE id = ?
        `).run(approvedJob.latestInsight.id, now, id);
      } else {
        this.ai.analyze({ entityType: 'development_project', entityId: id });
      }
    });
    const created = this.repository.getDevelopmentProject(id);
    if (!created) throw new Error('待开发项目创建失败。');
    return created;
  }

  analyzeDevelopmentProject(id: string): { project: DevelopmentProject; cached: boolean } {
    if (!this.repository.getDevelopmentProject(id)) throw new Error('待开发项目不存在。');
    if (this.workflowRepository.hasWorkflowLineageForEntity('development_project', id)) {
      throw new Error('该项目已纳入 V2 工作流，不能用 legacy 分析覆盖正式 Insight。');
    }
    this.recomputeDevelopmentProjectMetrics(id);
    const analyzed = this.ai.analyze({ entityType: 'development_project', entityId: id });
    const project = this.repository.getDevelopmentProject(id);
    if (!project) throw new Error('待开发项目不存在。');
    return { project, cached: analyzed.cached };
  }

  decideDevelopmentProject(id: string, input: {
    decision: DecisionType;
    reason: string;
    decidedBy: string;
  }, approvedJob?: ResearchJobDetail): { project: DevelopmentProject; decision: DecisionRecord } {
    const project = this.repository.getDevelopmentProject(id);
    if (!project) throw new Error('待开发项目不存在。');
    const isAdvancement = input.decision === 'develop' || input.decision === 'test';
    if (isAdvancement && !approvedJob) {
      throw new Error('推进待开发项目必须提供当前 V2 Research Job 的完整批准血缘。');
    }
    this.recomputeDevelopmentProjectMetrics(id);
    const analyzed = approvedJob
      ? null
      : this.ai.analyze({ entityType: 'development_project', entityId: id });
    const now = new Date().toISOString();
    const decision = transaction(this.database, () => {
      let saved: DecisionRecord;
      if (approvedJob) {
        saved = this.workflowRepository.saveAdvancementDecision(
          approvedJob, 'development_project', id, input.decision,
          input.reason, input.decidedBy,
        );
      } else {
        if (!analyzed) throw new Error('决策分析结果不存在。');
        const decisionId = randomUUID();
        this.database.prepare(`
          INSERT INTO decisions (
            id, entity_type, entity_id, decision, reason, ai_insight_id,
            data_version, decided_by, decided_at
          ) VALUES (?, 'development_project', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          decisionId, id, input.decision, input.reason, analyzed.insight.id,
          analyzed.insight.dataVersion, input.decidedBy, now,
        );
        saved = {
          id: decisionId,
          entityType: 'development_project',
          entityId: id,
          decision: input.decision,
          reason: input.reason,
          aiInsightId: analyzed.insight.id,
          dataVersion: analyzed.insight.dataVersion,
          decidedBy: input.decidedBy,
          decidedAt: now,
        };
      }
      this.database.prepare(`
        UPDATE development_projects SET status = ?, updated_at = ? WHERE id = ?
      `).run(input.decision, now, id);
      return saved;
    });
    const updated = this.repository.getDevelopmentProject(id);
    if (!updated) throw new Error('决策保存失败。');
    return { project: updated, decision };
  }

  researchOpportunity(query: string): ResearchResult {
    const settings = this.repository.getSettings();
    const id = randomUUID();
    const now = new Date().toISOString();
    const hasDemoData = settings.mode === 'demo';
    const labels = researchLabels(query);
    const nodes: ResearchNode[] = labels.map((name, index) => {
      const key = `${query}:${index}`;
      return {
        id: randomUUID(),
        name,
        parentId: index === 0 ? null : '',
        level: index + 1,
        marketplace: settings.marketplace,
        keywords: [name],
        status: hasDemoData ? '已完成演示研究' : '待采集数据',
        snapshotAvailable: hasDemoData,
        monthlySales: hasDemoData ? Math.round(scoreSeed(`${key}:sales`, 4_000, 90_000)) : null,
        monthlyRevenue: hasDemoData ? Math.round(scoreSeed(`${key}:revenue`, 180_000, 3_200_000)) : null,
        growth30d: hasDemoData ? scoreSeed(`${key}:growth`, -2, 24) : null,
        growth30dAvailable: hasDemoData,
        productCount: hasDemoData ? Math.round(scoreSeed(`${key}:products`, 80, 1_400)) : null,
        avgPrice: hasDemoData ? scoreSeed(`${key}:price`, 18, 58) : null,
        competitionScore: hasDemoData ? Math.round(scoreSeed(`${key}:competition`, 35, 84)) : null,
        opportunityScore: hasDemoData ? Math.round(scoreSeed(`${key}:opportunity`, 58, 88)) : null,
        taskStatus: hasDemoData ? 'success' : 'pending',
      };
    });
    nodes.forEach((node, index) => {
      if (index > 0) node.parentId = nodes[index - 1].id;
    });

    const combinations: ResearchResult['combinations'] = [
      {
        name: `${query}核心组合`,
        items: labels.slice(-2),
        rationale: hasDemoData ? '高需求核心品与低客单配件组合，降低用户选购成本。' : '待采集需求、竞争和价格数据后验证。',
        fit: hasDemoData ? 'recommended' : 'watch',
      },
      {
        name: `${query}扩展组合`,
        items: [`${query}收纳`, `${query}补充件`],
        rationale: '用低价配件增加感知价值，需确认重量和包装成本。',
        fit: 'watch',
      },
    ];

    const opportunityIds: string[] = [];
    const opportunities: Opportunity[] = [];
    const opportunityNames = [`${query}实用组合`, `${query}轻量组合`];
    const summary = hasDemoData
      ? `已将「${query}」拆成 ${nodes.length} 层市场，形成 ${opportunityNames.length} 个待审核机会。所有数字均为 Demo/Mock。`
      : `已完成「${query}」的研究树与采集任务。当前无数据，未生成虚构市场结论。`;
    transaction(this.database, () => {
      const nodeStatement = this.database.prepare(`
        INSERT INTO market_nodes (
          id, name, parent_id, level, marketplace, keywords_json, status,
          competition_score, opportunity_score, source_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      if (hasDemoData) {
        nodes.forEach((node) => nodeStatement.run(
          node.id, node.name, node.parentId, node.level, node.marketplace,
          JSON.stringify(node.keywords), node.status, node.competitionScore,
          node.opportunityScore, 'mock', now,
        ));
      }
      const targetMarketNodeId = nodes.at(-1)?.id ?? null;
      if (hasDemoData) {
        for (let index = 0; index < opportunityNames.length; index += 1) {
          const opportunityId = randomUUID();
          opportunityIds.push(opportunityId);
          const score = Math.round(scoreSeed(`${query}:opp:${index}`, 62, 87));
          const growth = scoreSeed(`${query}:opp-growth:${index}`, 4, 22);
          const competition = Math.round(scoreSeed(`${query}:opp-comp:${index}`, 42, 79));
          const evidence = [researchEvidence(
            opportunityId, opportunityNames[index], score, growth, competition, now,
          )];
          this.database.prepare(`
            INSERT INTO opportunities (
              id, name, source_type, market_node_id, market_name, opportunity_score,
              market_growth, competition_score, price_room, recommended_action, status,
              summary, evidence_json, research_result_id, created_at, updated_at, marketplace
            ) VALUES (?, ?, 'ai_research', ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?)
          `).run(
            opportunityId, opportunityNames[index], targetMarketNodeId, nodes.at(-1)?.name ?? query,
            score, growth, competition, '$24–49', '进入机会池审核',
            `机会分 ${score}，结果来自明确标记的 Demo 研究数据。`,
            JSON.stringify(evidence), id, now, now, settings.marketplace,
          );
        }
      }
      nodes.forEach((node) => {
        this.createDataTaskRecord({
          name: `${node.name} 数据任务`, taskType: 'opportunity_research', target: node.id,
          source: hasDemoData ? this.mockAdapter.name : '待配置数据源',
          status: hasDemoData ? 'success' : 'pending', total: hasDemoData ? 1 : 0,
          success: hasDemoData ? 1 : 0,
        });
      });
      this.database.prepare(`
        INSERT INTO research_results (
          id, query, summary, nodes_json, combinations_json, opportunity_ids_json,
          tasks_created, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, query, summary, JSON.stringify(nodes), JSON.stringify(combinations),
        JSON.stringify(opportunityIds), nodes.length, now,
      );
      if (settings.mode === 'empty') {
        this.database.prepare(`UPDATE app_settings SET mode = 'live' WHERE id = 1`).run();
      }
    });
    for (const opportunityId of opportunityIds) {
      const created = this.repository.getOpportunity(opportunityId);
      if (created) opportunities.push(created);
    }
    return { id, query, summary, nodes, combinations, opportunities, tasksCreated: nodes.length, generatedAt: now };
  }

  async promoteOpportunity(
    id: string,
    approvedJob: ResearchJobDetail,
  ): Promise<{ opportunity: Opportunity; project: DevelopmentProject }> {
    const opportunity = this.repository.getOpportunity(id);
    if (!opportunity) throw new Error('机会不存在。');
    if (opportunity.evidence.length === 0) {
      throw new Error('机会数据不足，不能转入待开发；请先完成数据采集并形成证据。');
    }
    const currentApprovedJob = this.workflowRepository.requireApprovedResearchJobForAdvancement(
      'opportunity', id, ['develop', 'test'],
    );
    if (currentApprovedJob.id !== approvedJob.id) {
      throw new Error('批准来源已不是该机会的最新 Research Job。');
    }
    const approvedAction = currentApprovedJob.approval?.action;
    if (approvedAction !== 'develop' && approvedAction !== 'test') {
      throw new Error('当前 Approval 没有批准可执行的推进动作。');
    }
    const existing = this.database.prepare(`
      SELECT id FROM development_projects WHERE source_opportunity_id = ?
    `).get(id) as { id: string } | undefined;
    let project: DevelopmentProject;
    if (existing) {
      const found = this.repository.getDevelopmentProject(existing.id);
      if (!found) throw new Error('关联待开发项目不存在。');
      project = found;
    } else {
      const linked = this.database.prepare(`
        SELECT market_node_id AS id FROM opportunities WHERE id = ?
      `).get(id) as { id: string | null } | undefined;
      project = await this.createDevelopmentProject({
        name: opportunity.name,
        productType: 'opportunity_product',
        keywords: [opportunity.market],
        notes: `由机会 ${opportunity.id} 转入`,
        marketplace: this.repository.getSettings().marketplace,
        supplyChainRelation: '待评估',
        marketNodeId: linked?.id ?? undefined,
        sourceOpportunityId: id,
      }, currentApprovedJob);
    }
    const now = new Date().toISOString();
    transaction(this.database, () => {
      this.database.prepare(`
        UPDATE development_projects
        SET source_opportunity_id = ?, insight_id = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        id, currentApprovedJob.latestInsight!.id, approvedAction, now, project.id,
      );
      this.workflowRepository.saveAdvancementDecision(
        currentApprovedJob, 'development_project', project.id, approvedAction,
        currentApprovedJob.decision!.reason,
        currentApprovedJob.approval!.decidedBy ?? currentApprovedJob.decision!.decidedBy,
      );
      this.database.prepare(`
        UPDATE opportunities SET status = 'promoted', recommended_action = '已转待开发', updated_at = ?
        WHERE id = ?
      `).run(now, id);
    });
    const updated = this.repository.getOpportunity(id);
    if (!updated) throw new Error('机会状态更新失败。');
    return { opportunity: updated, project: this.repository.getDevelopmentProject(project.id) ?? project };
  }

  rejectOpportunity(id: string, reason = '', decidedBy = 'Admin'): Opportunity {
    const opportunity = this.repository.getOpportunity(id);
    if (!opportunity) throw new Error('机会不存在。');
    if (opportunity.evidence.length === 0) {
      throw new Error('机会数据不足，不能作出淘汰决策；请先完成数据采集并形成证据。');
    }
    const analyzed = this.ai.analyze({ entityType: 'opportunity', entityId: id });
    const auditReason = reason.trim() || '当前阶段暂不考虑，保留至淘汰池等待重新评估。';
    const now = new Date().toISOString();
    transaction(this.database, () => {
      this.database.prepare(`
        UPDATE opportunities SET status = 'rejected', rejection_reason = ?,
          recommended_action = '暂不考虑', updated_at = ? WHERE id = ?
      `).run(auditReason, now, id);
      this.database.prepare(`
        INSERT INTO decisions (
          id, entity_type, entity_id, decision, reason, ai_insight_id,
          data_version, decided_by, decided_at
        ) VALUES (?, 'opportunity', ?, 'reject', ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), id, auditReason, analyzed.insight.id, analyzed.insight.dataVersion,
        decidedBy.trim() || 'Admin', now,
      );
    });
    const updated = this.repository.getOpportunity(id);
    if (!updated) throw new Error('机会状态更新失败。');
    return updated;
  }

  watchOpportunity(id: string): { opportunity: Opportunity; watchlistItem: WatchlistItem } {
    const opportunity = this.repository.getOpportunity(id);
    if (!opportunity) throw new Error('机会不存在。');
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE opportunities SET status = 'researching', rejection_reason = NULL,
        recommended_action = '继续监控', updated_at = ? WHERE id = ?
    `).run(now, id);
    const watchlistItem = this.addWatchlist({
      itemType: 'opportunity', itemId: id, name: opportunity.name, frequency: 'weekly',
    });
    const updated = this.repository.getOpportunity(id);
    if (!updated) throw new Error('机会状态更新失败。');
    return { opportunity: updated, watchlistItem };
  }

  addWatchlist(input: {
    itemType: string;
    itemId: string;
    name?: string;
    frequency?: WatchlistItem['frequency'];
    status?: WatchlistItem['status'];
  }): WatchlistItem {
    const marketplace = this.repository.getSettings().marketplace;
    const existing = this.database.prepare(`
      SELECT id FROM watchlist_items WHERE marketplace = ? AND item_type = ? AND item_id = ?
    `).get(marketplace, input.itemType, input.itemId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const frequency = input.frequency ?? 'manual';
    const nextRun = nextRunAt(now, frequency);
    const name = input.name ?? this.resolveEntityName(input.itemType, input.itemId);
    this.database.prepare(`
      INSERT INTO watchlist_items (
        id, item_type, item_id, name, marketplace, frequency, status, last_run_at, next_run_at,
        latest_finding, anomaly, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, '待首次刷新', 0, ?)
      ON CONFLICT(marketplace, item_type, item_id) DO UPDATE SET
        name = excluded.name, frequency = excluded.frequency, status = excluded.status,
        next_run_at = excluded.next_run_at
    `).run(
      id, input.itemType, input.itemId, name, marketplace, frequency,
      input.status ?? 'active', nextRun, now,
    );
    const item = this.repository.getWatchlist().find((candidate) => candidate.id === id);
    if (!item) throw new Error('监控项创建失败。');
    return item;
  }

  removeWatchlist(id: string): boolean {
    const result = this.database.prepare(`
      DELETE FROM watchlist_items WHERE id = ? AND marketplace = ?
    `).run(id, this.repository.getSettings().marketplace);
    return Number(result.changes) > 0;
  }

  updateWatchlist(
    id: string,
    input: { frequency?: WatchlistItem['frequency']; status?: WatchlistItem['status'] },
  ): WatchlistItem {
    const current = this.repository.getWatchlist().find((item) => item.id === id);
    if (!current) throw new Error('监控项不存在。');
    const frequency = input.frequency ?? current.frequency;
    const status = input.status ?? current.status;
    const now = new Date().toISOString();
    const nextRun = status === 'active' ? nextRunAt(now, frequency) : null;
    this.database.prepare(`
      UPDATE watchlist_items SET frequency = ?, status = ?, next_run_at = ?
      WHERE id = ? AND marketplace = ?
    `).run(frequency, status, nextRun, id, this.repository.getSettings().marketplace);
    const updated = this.repository.getWatchlist().find((item) => item.id === id);
    if (!updated) throw new Error('监控项更新失败。');
    return updated;
  }

  async runDataTask(input: {
    taskType?: string;
    target?: string;
    source?: string;
    watchlistId?: string;
    retryTaskId?: string;
  }): Promise<DataTask> {
    let taskType = input.taskType ?? 'manual_refresh';
    let target = input.target ?? '';
    let source = input.source ?? this.mockAdapter.name;
    if (input.retryTaskId) {
      const previous = this.repository.getDataTask(input.retryTaskId);
      if (!previous) throw new Error('要重试的任务不存在。');
      const activeMarketplace = this.repository.getSettings().marketplace;
      if (previous.marketplace !== activeMarketplace) {
        throw new Error(`原任务属于 ${previous.marketplace} 站点，请切换到该站点后重试。`);
      }
      if (previous.taskType === 'file_import') {
        throw new Error('文件导入任务不能无文件重试，请重新上传原 CSV/XLSX 文件。');
      }
      taskType = previous.taskType;
      target = previous.target;
      source = previous.source;
    }
    if (input.watchlistId) {
      const item = this.repository.getWatchlist().find((candidate) => candidate.id === input.watchlistId);
      if (!item) throw new Error('监控项不存在。');
      target = item.itemId;
    }
    const mode = this.repository.getSettings().mode;
    if (mode === 'demo' && /^configured[_\s-]?adapter$/i.test(source)) {
      source = this.mockAdapter.name;
    }
    const taskId = this.createDataTaskRecord({
      name: `${taskType}: ${target || '全部'}`, taskType, target: target || 'all', source,
      status: 'running', total: 0, success: 0,
    });
    const startedAt = new Date().toISOString();
    try {
      if (mode !== 'demo') {
        throw new Error('当前未连接可执行刷新的真实数据 Adapter；本次未写入任何 Mock 快照。');
      }
      if (/seller\s*sprite|mcp/i.test(source) && !/mock/i.test(source)) {
        throw new Error('SellerSprite MCP 尚未配置可用账号连接。');
      }
      const refreshed = await this.refreshTarget(target, input.watchlistId);
      const completedAt = new Date().toISOString();
      this.database.prepare(`
        UPDATE data_tasks SET status = 'success', started_at = ?, completed_at = ?,
          total = ?, success = ?, failed = 0 WHERE id = ?
      `).run(startedAt, completedAt, refreshed, refreshed, taskId);
      this.database.prepare(`
        UPDATE app_settings SET last_successful_sync = ? WHERE id = 1
      `).run(completedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知刷新错误';
      this.database.prepare(`
        UPDATE data_tasks SET status = 'failed', started_at = ?, completed_at = ?,
          total = 1, success = 0, failed = 1, error_log = ? WHERE id = ?
      `).run(startedAt, new Date().toISOString(), message, taskId);
    }
    const task = this.repository.getDataTask(taskId);
    if (!task) throw new Error('数据任务创建失败。');
    return task;
  }

  getDashboard(): DashboardData {
    const settings = this.repository.getSettings();
    const empty: DashboardData = {
      generatedAt: new Date().toISOString(),
      briefing: [],
      summaries: {
        market: {
          monthlyRevenue: null, growth30d: null, growth90d: null, status: '尚未接入真实数据',
          snapshotAvailable: false, growth30dAvailable: false,
        },
        skus: {
          outperform: 0, inLine: 0, underperform: 0, anomalies: 0,
          analyzable: 0, pendingData: 0,
        },
        development: {
          watching: 0, recommended: 0, riskRising: 0,
          analyzable: 0, pendingData: 0,
        },
        opportunities: { foundThisWeek: 0, pending: 0, pooled: 0 },
      },
      suggestedQuestions: ['今天有什么值得关注？', '哪个 SKU 最近最差？', '腰靠值得开发吗？'],
    };
    if (settings.mode === 'empty') return empty;
    const market = settings.defaultMarketId ? this.repository.getMarket(settings.defaultMarketId) : null;
    const owned = this.repository.getOwnedProducts();
    const comparableOwned = owned.filter((item) => item.relativePerformanceAvailable);
    const formallyAnalyzedOwned = comparableOwned.filter((item) => isFormalWorkflowInsight(item.insight));
    const projects = this.repository.getDevelopmentProjects();
    const opportunities = this.repository.getOpportunities();
    const briefing: BriefingItem[] = [];
    const worst = formallyAnalyzedOwned
      .filter((item) => item.relativeDelta !== null)
      .sort((left, right) => left.relativeDelta! - right.relativeDelta!)[0];
    if (worst && worst.relativeDelta !== null && worst.latest.growth30d !== null
      && worst.marketGrowth30d !== null) {
      briefing.push({
        id: `briefing-${worst.id}`, severity: worst.relativeDelta <= -10 ? 'critical' : 'warning',
        category: '现有业务风险', entityType: 'owned_product', entityId: worst.id,
        title: `${worst.internalName ?? worst.sku ?? worst.asin} ${performanceText(worst.performance)}`,
        summary: `SKU 30D ${signed(worst.latest.growth30d)}%，所属市场 ${signed(worst.marketGrowth30d)}%，相对差 ${signed(worst.relativeDelta)}%。`,
        metric: `${signed(worst.relativeDelta)}% vs 市场`, action: '查看 SKU 诊断', insight: worst.insight,
      });
    }
    if (market?.trends.length && market.node.growth30dAvailable && market.node.growth30d !== null
      && isFormalWorkflowInsight(market.insight)) {
      briefing.push({
        id: `briefing-${market.node.id}`, severity: market.node.growth30d >= 5 ? 'opportunity' : 'info',
        category: '市场机会', entityType: 'market', entityId: market.node.id,
        title: `${market.node.name} 30D ${signed(market.node.growth30d)}%`,
        summary: market.insight.summary, metric: `${signed(market.node.growth30d)}%`,
        action: '查看市场证据', insight: market.insight,
      });
    }
    const bestProject = projects
      .filter((item) => item.opportunityScore !== null)
      .sort((left, right) => (right.opportunityScore ?? 0) - (left.opportunityScore ?? 0))[0];
    if (bestProject && isFormalWorkflowInsight(bestProject.insight)
      && bestProject.opportunityScore !== null && bestProject.opportunityScore > 0) {
      briefing.push({
        id: `briefing-${bestProject.id}`, severity: 'opportunity', category: '待开发变化',
        entityType: 'development_project', entityId: bestProject.id,
        title: `${bestProject.name} 机会分 ${bestProject.opportunityScore}`,
        summary: bestProject.insight.summary, metric: `${bestProject.opportunityScore}/100`,
        action: '查看验证建议', insight: bestProject.insight,
      });
    }
    const currentSales = market?.trends.at(-1)?.sales;
    const oldSales = market?.trends.at(-4)?.sales ?? market?.trends[0]?.sales;
    const growth90d = currentSales !== undefined && currentSales !== null
      && oldSales !== undefined && oldSales !== null && oldSales > 0
      ? Math.round(((currentSales / oldSales) - 1) * 1_000) / 10
      : null;
    return {
      ...empty,
      generatedAt: new Date().toISOString(),
      briefing: briefing.slice(0, 7),
      summaries: {
        market: {
          monthlyRevenue: market?.kpis.monthlyRevenue ?? null,
          growth30d: market?.node.growth30d ?? null,
          growth90d,
          status: market?.insight.status ?? '待分析',
          snapshotAvailable: Boolean(market?.trends.length),
          growth30dAvailable: market?.node.growth30dAvailable ?? false,
        },
        skus: {
          outperform: comparableOwned.filter((item) => ['strong_outperform', 'outperform'].includes(item.performance)).length,
          inLine: comparableOwned.filter((item) => item.performance === 'in_line').length,
          underperform: comparableOwned.filter((item) => ['strong_underperform', 'underperform'].includes(item.performance)).length,
          anomalies: owned.reduce((sum, item) => sum + item.anomalyCount, 0),
          analyzable: comparableOwned.length,
          pendingData: owned.length - comparableOwned.length,
        },
        development: {
          watching: projects.filter((item) => item.status === 'watch').length,
          recommended: projects.filter((item) => item.status === 'develop').length,
          riskRising: projects.filter((item) => (
            item.competitionScore !== null && item.competitionScore >= 75
          )).length,
          analyzable: projects.filter((item) => item.insight.evidence.length > 0).length,
          pendingData: projects.filter((item) => item.insight.evidence.length === 0).length,
        },
        opportunities: {
          foundThisWeek: opportunities.filter((item) => (
            new Date(item.createdAt).getTime() >= Date.now() - 7 * 24 * 60 * 60 * 1_000
          )).length,
          pending: opportunities.filter((item) => item.status === 'pending_review').length,
          pooled: opportunities.filter((item) => item.status !== 'rejected').length,
        },
      },
    };
  }

  private recomputeDevelopmentProjectMetrics(id: string): boolean {
    const row = this.database.prepare(`
      SELECT market_node_id FROM development_projects WHERE id = ? AND marketplace = ?
    `).get(id, this.repository.getSettings().marketplace) as { market_node_id: string } | undefined;
    if (!row) return false;
    const market = this.repository.getMarket(row.market_node_id);
    if (!market || market.trends.length === 0 || !market.node.growth30dAvailable) return false;
    if (market.kpis.monthlyRevenue === null || market.node.growth30d === null
      || market.kpis.productCount === null || market.kpis.medianReviews === null
      || market.kpis.medianPrice === null || market.kpis.top10Share === null
      || market.kpis.top20Share === null) return false;
    const calculated = calculateMarketOpportunityMetrics({
      monthlyRevenue: market.kpis.monthlyRevenue,
      growth30d: market.node.growth30d,
      productCount: market.kpis.productCount,
      medianReviews: market.kpis.medianReviews,
      medianPrice: market.kpis.medianPrice,
      top10Share: market.kpis.top10Share,
      top20Share: market.kpis.top20Share,
      confidence: market.provenance.confidence,
    });
    const hasDecision = this.database.prepare(`
      SELECT 1 FROM decisions WHERE entity_type = 'development_project' AND entity_id = ? LIMIT 1
    `).get(id);
    this.database.prepare(`
      UPDATE development_projects SET market_size = ?, growth_30d = ?, competition_score = ?,
        opportunity_score = ?, score_breakdown_json = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      market.kpis.monthlyRevenue, market.node.growth30d, calculated.competitionScore,
      calculated.opportunityScore, JSON.stringify(calculated.breakdown),
      hasDecision ? this.repository.getDevelopmentProject(id)?.status ?? 'watch' : 'watch',
      new Date().toISOString(), id,
    );
    this.database.prepare(`
      UPDATE market_nodes SET competition_score = ?, opportunity_score = ?, status = ? WHERE id = ?
    `).run(
      calculated.competitionScore, calculated.opportunityScore,
      calculated.opportunityScore >= 65 ? '值得研究' : '继续观察', row.market_node_id,
    );
    this.database.prepare(`
      UPDATE data_tasks SET status = 'success', started_at = COALESCE(started_at, ?),
        completed_at = ?, total = 1, success = 1, failed = 0, error_log = NULL
      WHERE task_type = 'development_research' AND target = ? AND status = 'pending'
    `).run(new Date().toISOString(), new Date().toISOString(), id);
    return true;
  }

  private createDevelopmentMarketHierarchy(
    input: DevelopmentInput,
    marketplace: string,
    keywords: string[],
  ): { leafId: string; nodeIds: string[] } {
    const typeName = input.productType.replaceAll('_', ' ').trim() || input.name;
    const primaryKeyword = keywords[0] ?? input.name;
    const labels = [
      `${typeName} 类目`,
      input.name,
      primaryKeyword.toLowerCase() === input.name.toLowerCase()
        ? `${primaryKeyword} 核心词`
        : primaryKeyword,
    ];
    const nodeIds: string[] = [];
    let parentId: string | null = null;
    labels.forEach((name, index) => {
      const existing = this.database.prepare(`
        SELECT id FROM market_nodes WHERE name = ? AND marketplace = ? AND
          ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?) LIMIT 1
      `).get(name, marketplace, parentId, parentId) as { id: string } | undefined;
      const nodeId = existing?.id ?? randomUUID();
      if (!existing) {
        this.database.prepare(`
          INSERT INTO market_nodes (
            id, name, parent_id, level, marketplace, keywords_json, status,
            competition_score, opportunity_score, source_type, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, '研究假设，待导入数据', NULL, NULL, 'import', ?)
        `).run(
          nodeId, name, parentId, index + 1, marketplace,
          JSON.stringify(index === labels.length - 1 ? keywords : [name]), new Date().toISOString(),
        );
      }
      nodeIds.push(nodeId);
      parentId = nodeId;
    });
    const settings = this.repository.getSettings();
    if (!settings.defaultMarketId) {
      this.database.prepare(`UPDATE app_settings SET default_market_id = ? WHERE id = 1`).run(nodeIds[0]);
    }
    return { leafId: nodeIds.at(-1) ?? nodeIds[0], nodeIds };
  }

  private ensureDefaultMarket(
    requestedId: string | undefined,
    marketplace: string,
    requestedName: string,
    keywords: string[],
  ): string {
    if (requestedId) {
      const exists = this.database.prepare(`
        SELECT id FROM market_nodes WHERE id = ? AND marketplace = ?
      `).get(requestedId, marketplace);
      if (exists) return requestedId;
      const now = new Date().toISOString();
      const sourceType = this.repository.getSettings().mode === 'demo' ? 'mock' : 'import';
      this.database.prepare(`
        INSERT INTO market_nodes (
          id, name, parent_id, level, marketplace, keywords_json, status,
          competition_score, opportunity_score, source_type, created_at
        ) VALUES (?, ?, NULL, 1, ?, ?, '待导入数据', NULL, NULL, ?, ?)
      `).run(requestedId, requestedName, marketplace, JSON.stringify(keywords), sourceType, now);
      this.database.prepare(`UPDATE app_settings SET default_market_id = ? WHERE id = 1`).run(requestedId);
      return requestedId;
    }
    const settings = this.repository.getSettings();
    if (settings.defaultMarketId) return settings.defaultMarketId;
    return this.ensureNamedMarket(requestedName, marketplace, keywords);
  }

  private ensureNamedMarket(name: string, marketplace: string, keywords: string[]): string {
    const row = this.database.prepare(`
      SELECT id FROM market_nodes WHERE name = ? AND marketplace = ? LIMIT 1
    `).get(name, marketplace) as { id: string } | undefined;
    if (row) return row.id;
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO market_nodes (
        id, name, parent_id, level, marketplace, keywords_json, status,
        competition_score, opportunity_score, source_type, created_at
      ) VALUES (?, ?, NULL, 1, ?, ?, '待导入数据', NULL, NULL, 'import', ?)
    `).run(id, name, marketplace, JSON.stringify(keywords), new Date().toISOString());
    const settings = this.repository.getSettings();
    if (!settings.defaultMarketId) {
      this.database.prepare('UPDATE app_settings SET default_market_id = ? WHERE id = 1').run(id);
    }
    return id;
  }

  private resolveEntityName(itemType: string, itemId: string): string {
    if (itemType === 'opportunity') return this.repository.getOpportunity(itemId)?.name ?? itemId;
    if (itemType === 'development_project') return this.repository.getDevelopmentProject(itemId)?.name ?? itemId;
    if (itemType === 'owned_product') {
      const product = this.repository.getOwnedProduct(itemId);
      return product?.internalName ?? product?.sku ?? product?.asin ?? itemId;
    }
    if (itemType === 'market') return this.repository.getMarket(itemId)?.node.name ?? itemId;
    return itemId;
  }

  private createDataTaskRecord(input: {
    name: string;
    taskType: string;
    target: string;
    source: string;
    status: DataTask['status'];
    total: number;
    success: number;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const sourceId = /mock/i.test(input.source) ? 'source-mock' : null;
    const done = ['success', 'partial', 'failed'].includes(input.status);
    this.database.prepare(`
      INSERT INTO data_tasks (
        id, name, source_id, task_type, target, source, marketplace, status, started_at,
        completed_at, total, success, failed, error_log, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    `).run(
      id, input.name, sourceId, input.taskType, input.target, input.source,
      this.repository.getSettings().marketplace, input.status,
      input.status === 'pending' ? null : now, done ? now : null,
      input.total, input.success, now,
    );
    return id;
  }

  private async refreshTarget(target: string, watchlistId?: string): Promise<number> {
    const watchItem = watchlistId
      ? this.repository.getWatchlist().find((item) => item.id === watchlistId)
      : this.repository.getWatchlist().find((item) => item.itemId === target);
    let refreshed = 0;
    let latestFinding = '';
    if (watchItem) {
      if (watchItem.itemType === 'market') {
        if (!this.repository.getMarket(watchItem.itemId)) throw new Error('监控市场不存在于当前站点。');
        refreshed = await this.appendMarketSnapshot(watchItem.itemId);
      } else if (['owned_product', 'competitor'].includes(watchItem.itemType)) {
        const product = this.database.prepare(`
          SELECT id FROM products WHERE id = ? AND marketplace = ?
        `).get(watchItem.itemId, this.repository.getSettings().marketplace);
        if (!product) throw new Error('监控产品不存在于当前站点。');
        refreshed = this.appendProductSnapshot(watchItem.itemId);
      } else if (['development_project', 'opportunity'].includes(watchItem.itemType)) {
        const result = this.ai.analyze({ entityType: watchItem.itemType, entityId: watchItem.itemId });
        refreshed = 1;
        latestFinding = result.insight.summary;
      } else {
        throw new Error(`暂不支持刷新监控类型：${watchItem.itemType}`);
      }
    } else if (this.repository.getMarket(target)) {
      refreshed = await this.appendMarketSnapshot(target);
    } else {
      const product = this.database.prepare(`
        SELECT id FROM products WHERE id = ? AND marketplace = ?
      `).get(target, this.repository.getSettings().marketplace);
      if (product) refreshed += this.appendProductSnapshot(target);
      else if (target === 'owned-products' || target === 'all') {
        if (target === 'all') {
          const defaultMarketId = this.repository.getSettings().defaultMarketId;
          if (defaultMarketId) refreshed += await this.appendMarketSnapshot(defaultMarketId);
        }
        for (const owned of this.repository.getOwnedProducts()) refreshed += this.appendProductSnapshot(owned.id);
      } else {
        throw new Error('刷新目标不存在或不属于当前站点。');
      }
    }
    if (refreshed === 0) throw new Error('刷新目标暂无可更新快照，未写入任何数据。');
    if (watchItem) {
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE watchlist_items SET last_run_at = ?, next_run_at = ?,
          latest_finding = ?, anomaly = ? WHERE id = ?
      `).run(
        now, nextRunAt(now, watchItem.frequency),
        latestFinding || `已于 ${now.slice(0, 16).replace('T', ' ')} 完成手动刷新`,
        watchItem.anomaly ? 1 : 0, watchItem.id,
      );
    }
    return refreshed;
  }

  private async appendMarketSnapshot(marketId: string): Promise<number> {
    const market = this.repository.getMarket(marketId);
    if (!market) return 0;
    const overview = await this.mockAdapter.fetchMarketOverview({
      marketId,
      marketplace: market.node.marketplace,
      keywords: market.node.keywords,
    });
    const latest = market.trends.at(-1);
    const now = new Date().toISOString();
    const sales = latest?.sales !== null && latest?.sales !== undefined
      ? Math.round(latest.sales * 1.003)
      : overview.monthlySales;
    const avgPrice = latest?.avgPrice ?? overview.avgPrice;
    this.database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
        monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
        top20_share, new_product_share, price_bands_json, concentration_json, source,
        source_type, collected_at, period, is_estimated, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock', ?, '30D', 1, ?)
    `).run(
      randomUUID(), marketId, now.slice(0, 10), overview.productCount, overview.sellerCount,
      overview.brandCount, sales, Math.round(sales * avgPrice * 100) / 100, avgPrice,
      overview.medianPrice, overview.avgRating, overview.medianReviews,
      market.kpis.top10Share, market.kpis.top20Share, market.kpis.newProductShare,
      JSON.stringify(market.priceBands), JSON.stringify(market.concentration),
      `${this.mockAdapter.name} @ ${now}`, now, overview.provenance.confidence,
    );
    this.ai.analyze({ entityType: 'market', entityId: marketId });
    const ownedRows = this.database.prepare(`
      SELECT id FROM products WHERE is_owned = 1 AND market_node_id = ? AND marketplace = ?
    `).all(marketId, this.repository.getSettings().marketplace) as Array<{ id: string }>;
    ownedRows.forEach((row) => this.ai.analyze({ entityType: 'owned_product', entityId: row.id }));
    const projectRows = this.database.prepare(`
      SELECT id FROM development_projects WHERE market_node_id = ? AND marketplace = ?
    `).all(marketId, this.repository.getSettings().marketplace) as Array<{ id: string }>;
    projectRows.forEach((row) => {
      this.recomputeDevelopmentProjectMetrics(row.id);
      this.ai.analyze({ entityType: 'development_project', entityId: row.id });
    });
    return 1;
  }

  private appendProductSnapshot(productId: string): number {
    const row = this.database.prepare(`
      SELECT * FROM product_snapshots WHERE product_id = ? ORDER BY date DESC, collected_at DESC LIMIT 1
    `).get(productId) as SqlRow | undefined;
    if (!row) return 0;
    const now = new Date().toISOString();
    const sales = Number(row.estimated_sales) * 1.002;
    this.database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d,
        source, source_type, collected_at, period, is_estimated, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mock', ?, ?, 1, ?)
    `).run(
      randomUUID(), productId, now.slice(0, 10), Number(row.price), Number(row.rating),
      Number(row.review_count), Number(row.bsr), Math.round(sales),
      Math.round(sales * Number(row.price) * 100) / 100, Number(row.seller_count),
      Number(row.growth_7d), Number(row.growth_30d), Number(row.growth_90d),
      `${this.mockAdapter.name} @ ${now}`, now, String(row.period), Number(row.confidence),
    );
    const product = this.database.prepare(`SELECT is_owned FROM products WHERE id = ?`).get(productId) as {
      is_owned: number;
    } | undefined;
    if (product?.is_owned === 1) {
      this.ai.analyze({ entityType: 'owned_product', entityId: productId });
    } else {
      const owners = this.database.prepare(`
        SELECT owned_product_id AS id FROM competitor_relations WHERE competitor_product_id = ?
      `).all(productId) as Array<{ id: string }>;
      owners.forEach((owner) => this.ai.analyze({ entityType: 'owned_product', entityId: owner.id }));
    }
    return 1;
  }
}

function expandDevelopmentKeywords(input: DevelopmentInput): string[] {
  const values = [input.name, ...input.keywords, input.productType.replaceAll('_', ' ')];
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function deterministicBreakdown(key: string): ScoreBreakdown {
  return {
    demand: scoreSeed(`${key}:demand`, 11, 20),
    growth: scoreSeed(`${key}:growth`, 9, 20),
    competition: scoreSeed(`${key}:competition`, 8, 20),
    newProductFriendly: scoreSeed(`${key}:friendly`, 7, 15),
    priceRoom: scoreSeed(`${key}:price`, 5, 10),
    concentration: scoreSeed(`${key}:concentration`, 5, 10),
    confidence: scoreSeed(`${key}:confidence`, 3, 5),
  };
}

function scoreSeed(key: string, minimum: number, maximum: number): number {
  const hash = createHash('sha256').update(key).digest();
  const fraction = hash.readUInt32BE(0) / 0xffff_ffff;
  return Math.round((minimum + fraction * (maximum - minimum)) * 10) / 10;
}

function researchLabels(query: string): string[] {
  if (/一年级|开学|小学/.test(query)) {
    return ['学生用品', '小学开学用品', '一年级必需品', '标准化开学组合包'];
  }
  return [`${query}大市场`, `${query}使用场景`, `${query}核心单品`, `${query}组合方案`];
}

function researchEvidence(
  id: string,
  name: string,
  score: number,
  growth: number,
  competition: number,
  collectedAt: string,
): Evidence {
  return {
    id: `evidence-${id}`,
    claim: `${name} 机会分 ${score}`,
    metrics: [
      { name: 'opportunity_score', label: '机会评分', value: score },
      { name: 'market_growth', label: '市场增长', value: growth, unit: '%' },
      { name: 'competition_score', label: '竞争强度', value: competition },
    ],
    provenance: [{
      source: '演示数据 / Mock Adapter', sourceType: 'mock', collectedAt,
      period: '30D', isEstimated: true, confidence: 0.7,
    }],
  };
}

function nextRunAt(from: string, frequency: WatchlistItem['frequency']): string | null {
  if (frequency === 'manual') return null;
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() + (frequency === 'daily' ? 1 : 7));
  return date.toISOString();
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}

function performanceText(value: string): string {
  const labels: Record<string, string> = {
    strong_outperform: '明显跑赢', outperform: '轻度跑赢', in_line: '基本同步',
    underperform: '轻度跑输', strong_underperform: '明显跑输',
  };
  return labels[value] ?? value;
}

function isFormalWorkflowInsight(insight: Insight): boolean {
  return Boolean(
    insight.entityType === 'research_job'
    && insight.researchJobId
    && insight.evidenceIds?.length
    && insight.evidence.length,
  );
}
