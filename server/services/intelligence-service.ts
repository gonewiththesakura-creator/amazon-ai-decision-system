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
  ProductSnapshot,
  Provenance,
  RelationType,
  ResearchJobDetail,
  ResearchNode,
  ResearchResult,
  ScoreBreakdown,
  WatchlistItem,
} from '../../shared/types.js';
import { AdapterRegistry, DataSourceRouter, SellerSpriteMCPAdapter } from '../adapters/index.js';
import type {
  MarketDataAdapter,
  MarketOverviewRecord,
  ProductDetailRecord,
} from '../adapters/types.js';
import { disableDemoMode, seedDemoData } from '../database/demo-seed.js';
import type { AppDatabase } from '../database/database.js';
import { transaction } from '../database/database.js';
import { calculateMarketOpportunityMetrics, calculateOpportunityScore } from '../domain/calculations.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';
import { WorkflowRepository } from '../repository/workflow-repository.js';
import { DeterministicAIService } from './ai-service.js';

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

const RUN_MANAGED_TASK_TYPES = new Set(['critical_sync', 'competitor_discovery']);

function isRunManagedTask(task: Pick<DataTask, 'syncRunId' | 'taskType'>): boolean {
  return task.syncRunId !== null || RUN_MANAGED_TASK_TYPES.has(task.taskType);
}

function runManagedTaskError(): Error {
  return new Error('请在设置 -> 数据源中重新运行 SellerSprite 关键同步；运行级任务不能通过通用数据任务接口执行或重试。');
}

export class IntelligenceService {
  readonly repository: IntelligenceRepository;
  readonly ai: DeterministicAIService;
  private readonly workflowRepository: WorkflowRepository;

  constructor(
    private readonly database: AppDatabase,
    private readonly dataSourceRouter = new DataSourceRouter(new AdapterRegistry()),
  ) {
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

  deactivateOwnedProduct(id: string): boolean {
    if (!this.repository.getOwnedProduct(id)) throw new Error('自有产品不存在。');
    const marketplace = this.repository.getSettings().marketplace;
    return transaction(this.database, () => {
      this.database.prepare(`
        DELETE FROM watchlist_items WHERE marketplace = ? AND item_type = 'owned_product' AND item_id = ?
      `).run(marketplace, id);
      const deactivated = this.database.prepare(`
        UPDATE products
        SET status = 'inactive', monitoring_enabled = 0, updated_at = ?
        WHERE id = ? AND is_owned = 1 AND marketplace = ? AND status = 'active'
      `).run(new Date().toISOString(), id, marketplace);
      return Number(deactivated.changes) > 0;
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
    const demoAdapter = settings.mode === 'demo'
      ? this.dataSourceRouter.resolve({
        taskType: 'development_research',
        entityType: 'development_project',
        marketplace,
        mode: settings.mode,
      })
      : null;
    const metrics = demoAdapter
      ? await demoAdapter.fetchMarketOverview({ marketplace, keywords: expandedKeywords })
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
        source: demoAdapter?.name ?? '待配置数据源',
        sourceId: demoAdapter?.id,
        status: settings.mode === 'demo' || recomputed ? 'success' : 'pending',
        total: settings.mode === 'demo' || recomputed ? 1 : 0,
        success: settings.mode === 'demo' || recomputed ? 1 : 0,
      });
      if (!linkedMarket) {
        research.nodeIds.forEach((nodeId) => this.createDataTaskRecord({
          name: `${input.name} 节点数据采集`, taskType: 'development_market_research', target: nodeId,
          source: demoAdapter?.name ?? '待配置数据源',
          sourceId: demoAdapter?.id,
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
    const demoAdapter = hasDemoData
      ? this.dataSourceRouter.resolve({
        taskType: 'opportunity_research',
        entityType: 'opportunity',
        marketplace: settings.marketplace,
        mode: settings.mode,
      })
      : null;
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
          source: demoAdapter?.name ?? '待配置数据源',
          sourceId: demoAdapter?.id,
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
    sourcePreference?: string;
    watchlistId?: string;
    retryTaskId?: string;
  }): Promise<DataTask> {
    let taskType = input.taskType ?? 'manual_refresh';
    let target = input.target ?? '';
    let sourcePreference = input.sourcePreference ?? input.source;
    if (input.retryTaskId) {
      const previous = this.repository.getDataTask(input.retryTaskId);
      if (!previous) throw new Error('要重试的任务不存在。');
      const activeMarketplace = this.repository.getSettings().marketplace;
      if (previous.marketplace !== activeMarketplace) {
        throw new Error(`原任务属于 ${previous.marketplace} 站点，请切换到该站点后重试。`);
      }
      if (previous.researchJobId) {
        throw new Error(`该数据任务由 Research Job ${previous.researchJobId} 工作流管理；请在 Research Job 页面补数或重试，不能通过通用数据任务接口重试。`);
      }
      if (previous.taskType === 'file_import') {
        throw new Error('文件导入任务不能无文件重试，请重新上传原 CSV/XLSX 文件。');
      }
      if (previous.taskType === 'post_import_analysis') {
        throw new Error('导入后分析需要按原批次单独复核，不能通过通用数据任务接口重试。');
      }
      if (isRunManagedTask(previous)) throw runManagedTaskError();
      taskType = previous.taskType;
      target = previous.target;
      sourcePreference = previous.sourceId ?? previous.source;
    }
    if (RUN_MANAGED_TASK_TYPES.has(taskType)) throw runManagedTaskError();
    if (taskType === 'post_import_analysis') {
      throw new Error('导入后分析需要按原批次单独复核，不能通过通用数据任务接口运行。');
    }
    let watchItem: WatchlistItem | undefined;
    if (input.watchlistId) {
      watchItem = this.repository.getWatchlist().find((candidate) => candidate.id === input.watchlistId);
      if (!watchItem) throw new Error('监控项不存在。');
      target = watchItem.itemId;
    } else if (target) {
      watchItem = this.repository.getWatchlist().find((candidate) => candidate.itemId === target);
    }
    const settings = this.repository.getSettings();
    let adapter: MarketDataAdapter | null = null;
    let routeError: unknown;
    try {
      adapter = this.dataSourceRouter.resolve({
        taskType,
        entityType: watchItem?.itemType ?? this.refreshEntityType(taskType, target),
        sourcePreference,
        marketplace: settings.marketplace,
        mode: settings.mode,
      });
    } catch (error) {
      routeError = error;
    }
    const taskId = this.createDataTaskRecord({
      name: `${taskType}: ${target || '全部'}`,
      taskType,
      target: target || 'all',
      source: adapter?.name ?? 'DataSourceRouter',
      sourceId: adapter?.id ?? null,
      status: 'running', total: 0, success: 0,
    });
    const startedAt = new Date().toISOString();
    try {
      if (routeError) throw routeError;
      if (!adapter) throw new Error('当前任务没有可用真实数据源，请先配置数据源。');
      if (adapter.id === 'source-sellersprite-mcp') {
        throw new Error('SellerSprite MCP 不支持旧版刷新；请通过设置 -> 数据源中的 V2.2 关键同步调用计划或专用同步运行。请检查 SELLERSPRITE_MCP_URL 配置。');
      }
      const refreshed = await this.refreshTarget(taskType, target, input.watchlistId, adapter);
      const completedAt = new Date().toISOString();
      this.database.prepare(`
        UPDATE data_tasks SET status = 'success', started_at = ?, completed_at = ?,
          total = ?, success = ?, failed = 0 WHERE id = ?
      `).run(startedAt, completedAt, refreshed, refreshed, taskId);
      this.database.prepare(`
        UPDATE app_settings SET last_successful_sync = ? WHERE id = 1
      `).run(completedAt);
      this.database.prepare(`
        UPDATE data_sources SET last_sync_at = ? WHERE id = ?
      `).run(completedAt, adapter.id);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '未知刷新错误';
      const message = settings.mode === 'demo' || /未写入任何 Mock/.test(rawMessage)
        ? rawMessage
        : `${rawMessage} 本次未写入任何 Mock 快照。`;
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
    if (settings.mode === 'empty') {
      const staged = this.database.prepare(`
        SELECT EXISTS(
          SELECT 1 FROM products
          WHERE marketplace = ? AND is_owned = 1 AND source_type <> 'mock'
          UNION ALL
          SELECT 1 FROM market_snapshots snapshot
          JOIN market_nodes market ON market.id = snapshot.market_node_id
          WHERE market.marketplace = ? AND snapshot.source_type <> 'mock'
        ) AS available
      `).get(settings.marketplace, settings.marketplace) as { available: number };
      if (!staged.available) return empty;
    }
    const market = settings.defaultMarketId ? this.repository.getMarket(settings.defaultMarketId) : null;
    const owned = this.repository.getSellableOwnedProducts();
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
    sourceId?: string | null;
    status: DataTask['status'];
    total: number;
    success: number;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const sourceId = input.sourceId === undefined
      ? (/mock/i.test(input.source) ? 'source-mock' : null)
      : input.sourceId;
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

  private refreshEntityType(taskType: string, target: string): string | undefined {
    const normalizedTaskType = taskType.trim().toLowerCase();
    if (normalizedTaskType === 'dashboard_core_refresh') return 'dashboard_core';
    if (normalizedTaskType === 'market_refresh') return 'market';
    if (['owned_sku_refresh', 'product_refresh'].includes(normalizedTaskType)) return 'owned_product';
    if (normalizedTaskType === 'competitor_refresh') return 'competitor';
    if (normalizedTaskType === 'keyword_refresh') return 'keyword';
    if (normalizedTaskType === 'review_refresh') return 'review';
    if (normalizedTaskType === 'amazon_internal') return 'amazon_internal';
    if (normalizedTaskType === 'file_import') return 'file_import';
    if (this.repository.getMarket(target)) return 'market';
    const product = this.database.prepare(`
      SELECT is_owned FROM products
      WHERE id = ? AND marketplace = ? AND (is_owned = 0 OR status = 'active')
    `).get(target, this.repository.getSettings().marketplace) as { is_owned: number } | undefined;
    if (product) return product.is_owned === 1 ? 'owned_product' : 'competitor';
    return undefined;
  }

  private async refreshTarget(
    taskType: string,
    target: string,
    watchlistId: string | undefined,
    adapter: MarketDataAdapter,
  ): Promise<number> {
    const watchItem = watchlistId
      ? this.repository.getWatchlist().find((item) => item.id === watchlistId)
      : this.repository.getWatchlist().find((item) => item.itemId === target);
    let refreshed = 0;
    let latestFinding = '';
    const normalizedTaskType = taskType.trim().toLowerCase();
    if (normalizedTaskType === 'keyword_refresh') {
      throw new Error('关键词刷新持久化尚未实现，任务已安全终止且未写入任何数据。');
    }
    if (normalizedTaskType === 'review_refresh') {
      throw new Error('评论刷新持久化尚未实现，任务已安全终止且未写入任何数据。');
    }
    if (normalizedTaskType === 'dashboard_core_refresh') {
      if (adapter instanceof SellerSpriteMCPAdapter) {
        throw new Error('V2.2 SellerSprite MCP 不支持旧版刷新任务；请使用真实数据工作台的关键数据同步。');
      }
      refreshed = await this.refreshDashboardCore(adapter);
    } else if (watchItem) {
      if (watchItem.itemType === 'market') {
        if (!this.repository.getMarket(watchItem.itemId)) throw new Error('监控市场不存在于当前站点。');
        refreshed = await this.appendMarketSnapshot(watchItem.itemId, adapter);
      } else if (['owned_product', 'competitor'].includes(watchItem.itemType)) {
        const product = this.database.prepare(`
          SELECT id FROM products
          WHERE id = ? AND marketplace = ? AND (is_owned = 0 OR status = 'active')
        `).get(watchItem.itemId, this.repository.getSettings().marketplace);
        if (!product) throw new Error('监控产品不存在于当前站点。');
        refreshed = await this.appendProductSnapshot(watchItem.itemId, adapter);
      } else if (['development_project', 'opportunity'].includes(watchItem.itemType)) {
        const table = watchItem.itemType === 'development_project' ? 'development_projects' : 'opportunities';
        const linked = this.database.prepare(`
          SELECT market_node_id AS marketNodeId FROM ${table}
          WHERE id = ? AND marketplace = ?
        `).get(watchItem.itemId, this.repository.getSettings().marketplace) as {
          marketNodeId: string | null;
        } | undefined;
        if (!linked?.marketNodeId) {
          if (adapter.sourceType !== 'mock') {
            throw new Error('监控对象尚未关联可刷新的市场，未生成新的分析结论。');
          }
          const result = this.ai.analyze({ entityType: watchItem.itemType, entityId: watchItem.itemId });
          refreshed = 1;
          latestFinding = result.insight.summary;
        } else {
          refreshed = await this.appendMarketSnapshot(linked.marketNodeId, adapter);
          if (watchItem.itemType === 'development_project') {
            this.recomputeDevelopmentProjectMetrics(watchItem.itemId);
          }
          const result = this.ai.analyze({ entityType: watchItem.itemType, entityId: watchItem.itemId });
          latestFinding = result.insight.summary;
        }
      } else {
        throw new Error(`暂不支持刷新监控类型：${watchItem.itemType}`);
      }
    } else if (normalizedTaskType === 'market_refresh' && (target === '' || target === 'all')) {
      const defaultMarketId = this.repository.getSettings().defaultMarketId;
      if (defaultMarketId) refreshed = await this.appendMarketSnapshot(defaultMarketId, adapter);
    } else if (
      ['owned_sku_refresh', 'product_refresh'].includes(normalizedTaskType)
      && (target === '' || target === 'all' || target === 'owned-products')
    ) {
      for (const owned of this.repository.getSellableOwnedProducts()) {
        refreshed += await this.appendProductSnapshot(owned.id, adapter);
      }
    } else if (
      normalizedTaskType === 'competitor_refresh'
      && (target === '' || target === 'all' || target === 'watched-competitors')
    ) {
      const competitors = this.database.prepare(`
        SELECT DISTINCT relation.competitor_product_id AS id
        FROM competitor_relations relation
        JOIN products owned ON owned.id = relation.owned_product_id
        JOIN products competitor ON competitor.id = relation.competitor_product_id
        WHERE relation.relation_type = 'direct'
          AND owned.marketplace = ? AND owned.is_owned = 1 AND owned.is_parent = 0
          AND owned.status = 'active' AND competitor.marketplace = ?
          AND competitor.is_owned = 0 AND competitor.is_parent = 0
          AND competitor.status = 'active'
      `).all(
        this.repository.getSettings().marketplace,
        this.repository.getSettings().marketplace,
      ) as Array<{ id: string }>;
      for (const competitor of competitors) {
        refreshed += await this.appendProductSnapshot(competitor.id, adapter);
      }
    } else if (this.repository.getMarket(target)) {
      refreshed = await this.appendMarketSnapshot(target, adapter);
    } else {
      const product = this.database.prepare(`
        SELECT id FROM products
        WHERE id = ? AND marketplace = ? AND (is_owned = 0 OR status = 'active')
      `).get(target, this.repository.getSettings().marketplace);
      if (product) refreshed += await this.appendProductSnapshot(target, adapter);
      else if (target === 'owned-products' || target === 'all') {
        if (target === 'all') {
          const defaultMarketId = this.repository.getSettings().defaultMarketId;
          if (defaultMarketId) refreshed += await this.appendMarketSnapshot(defaultMarketId, adapter);
        }
        for (const owned of this.repository.getSellableOwnedProducts()) {
          refreshed += await this.appendProductSnapshot(owned.id, adapter);
        }
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

  private async appendMarketSnapshot(marketId: string, adapter: MarketDataAdapter): Promise<number> {
    const prepared = await this.prepareMarketSnapshot(marketId, adapter);
    if (!prepared) return 0;
    return transaction(this.database, () => {
      this.persistMarketSnapshot(prepared);
      this.analyzeMarketSnapshot(prepared.marketId);
      return 1;
    });
  }

  private async appendProductSnapshot(productId: string, adapter: MarketDataAdapter): Promise<number> {
    const prepared = await this.prepareProductSnapshot(productId, adapter);
    if (!prepared) return 0;
    return transaction(this.database, () => {
      this.persistProductSnapshot(prepared);
      this.analyzeProductSnapshot(prepared);
      return 1;
    });
  }

  private async refreshDashboardCore(adapter: MarketDataAdapter): Promise<number> {
    const settings = this.repository.getSettings();
    const market = settings.defaultMarketId
      ? await this.prepareMarketSnapshot(settings.defaultMarketId, adapter)
      : null;
    const productIds = this.database.prepare(`
      SELECT id FROM products
      WHERE is_owned = 1 AND is_parent = 0 AND status = 'active' AND marketplace = ?
      UNION
      SELECT relation.competitor_product_id AS id
      FROM competitor_relations relation
      JOIN products owned ON owned.id = relation.owned_product_id
      JOIN products competitor ON competitor.id = relation.competitor_product_id
      WHERE relation.relation_type = 'direct'
        AND owned.marketplace = ? AND owned.is_owned = 1 AND owned.is_parent = 0
        AND owned.status = 'active' AND competitor.marketplace = ?
        AND competitor.is_owned = 0 AND competitor.is_parent = 0
        AND competitor.status = 'active'
      ORDER BY id
    `).all(settings.marketplace, settings.marketplace, settings.marketplace) as Array<{ id: string }>;
    const products: PreparedProductSnapshot[] = [];
    for (const { id } of productIds) {
      const prepared = await this.prepareProductSnapshot(id, adapter);
      if (prepared) products.push(prepared);
    }
    if (!market && products.length === 0) return 0;

    return transaction(this.database, () => {
      if (market) this.persistMarketSnapshot(market);
      products.forEach((product) => this.persistProductSnapshot(product));

      // Keep derived insights in the same commit as the complete core snapshot set.
      if (market) this.analyzeMarketSnapshot(market.marketId);
      products.forEach((product) => this.analyzeProductSnapshot(product));
      return (market ? 1 : 0) + products.length;
    });
  }

  private async prepareMarketSnapshot(
    marketId: string,
    adapter: MarketDataAdapter,
  ): Promise<PreparedMarketSnapshot | null> {
    const market = this.repository.getMarket(marketId);
    if (!market) return null;
    const overview = await adapter.fetchMarketOverview({
      marketId,
      marketplace: market.node.marketplace,
      keywords: market.node.keywords,
      previousSnapshot: {
        productCount: market.kpis.productCount,
        sellerCount: market.kpis.sellerCount,
        brandCount: market.kpis.brandCount,
        monthlySales: market.kpis.monthlySales,
        monthlyRevenue: market.kpis.monthlyRevenue,
        avgPrice: market.kpis.avgPrice,
        medianPrice: market.kpis.medianPrice,
        avgRating: market.kpis.avgRating,
        medianReviews: market.kpis.medianReviews,
        top10Share: market.kpis.top10Share,
        top20Share: market.kpis.top20Share,
        newProductShare: market.kpis.newProductShare,
        priceBands: market.priceBands,
        concentration: market.concentration,
      },
    });
    validateAdapterProvenance(adapter, overview.provenance);
    validateMarketOverview(overview);
    return { marketId, overview };
  }

  private async prepareProductSnapshot(
    productId: string,
    adapter: MarketDataAdapter,
  ): Promise<PreparedProductSnapshot | null> {
    const product = this.database.prepare(`
      SELECT asin, marketplace, is_owned AS isOwned
      FROM products
      WHERE id = ? AND marketplace = ? AND (is_owned = 0 OR status = 'active')
    `).get(productId, this.repository.getSettings().marketplace) as LocalProductIdentity | undefined;
    if (!product) return null;
    const detail = await adapter.fetchProductDetail({
      asin: product.asin,
      marketplace: product.marketplace,
      previousSnapshot: this.repository.getProductSnapshots(productId).at(-1),
    });
    validateProductIdentity(adapter, product, detail);
    validateAdapterProvenance(adapter, detail.provenance);
    validateAdapterProvenance(adapter, detail.latest.provenance);
    if (!sameProvenance(detail.provenance, detail.latest.provenance)) {
      throw new Error(`Adapter ${adapter.id} 返回的产品级与快照级 provenance 不一致。`);
    }
    validateProductSnapshot(detail.latest);
    return { productId, product, snapshot: detail.latest };
  }

  private persistMarketSnapshot({ marketId, overview }: PreparedMarketSnapshot): void {
    const collectedAt = overview.provenance.collectedAt;
    this.database.prepare(`
      INSERT INTO market_snapshots (
        id, market_node_id, date, product_count, seller_count, brand_count, monthly_sales,
        monthly_revenue, avg_price, median_price, avg_rating, median_reviews, top10_share,
        top20_share, new_product_share, price_bands_json, concentration_json, source,
        source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), marketId, collectedAt.slice(0, 10), overview.productCount, overview.sellerCount,
      overview.brandCount, overview.monthlySales, overview.monthlyRevenue, overview.avgPrice,
      overview.medianPrice, overview.avgRating, overview.medianReviews,
      overview.top10Share, overview.top20Share, overview.newProductShare,
      JSON.stringify(overview.priceBands), JSON.stringify(overview.concentration),
      overview.provenance.source, overview.provenance.sourceType, collectedAt,
      overview.provenance.period, overview.provenance.isEstimated ? 1 : 0,
      overview.provenance.confidence,
      collectedAt.slice(0, 10), `market|${this.repository.getSettings().marketplace}|${marketId}|${collectedAt.slice(0, 10)}|${overview.provenance.sourceType.trim().toLowerCase()}|${overview.provenance.source.trim().toLowerCase()}|${overview.provenance.period}`,
    );
  }

  private analyzeMarketSnapshot(marketId: string): void {
    this.ai.analyze({ entityType: 'market', entityId: marketId });
    const ownedRows = this.database.prepare(`
      SELECT id FROM products
      WHERE is_owned = 1 AND is_parent = 0 AND status = 'active'
        AND market_node_id = ? AND marketplace = ?
    `).all(marketId, this.repository.getSettings().marketplace) as Array<{ id: string }>;
    ownedRows.forEach((row) => this.ai.analyze({ entityType: 'owned_product', entityId: row.id }));
    const projectRows = this.database.prepare(`
      SELECT id FROM development_projects WHERE market_node_id = ? AND marketplace = ?
    `).all(marketId, this.repository.getSettings().marketplace) as Array<{ id: string }>;
    projectRows.forEach((row) => {
      this.recomputeDevelopmentProjectMetrics(row.id);
      this.ai.analyze({ entityType: 'development_project', entityId: row.id });
    });
  }

  private persistProductSnapshot({ productId, snapshot }: PreparedProductSnapshot): void {
    const provenance = snapshot.provenance;
    this.database.prepare(`
      INSERT INTO product_snapshots (
        id, product_id, date, price, rating, review_count, bsr, estimated_sales,
        estimated_revenue, seller_count, growth_7d, growth_30d, growth_90d,
        source, source_type, collected_at, period, is_estimated, confidence, observation_date, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), productId, snapshot.date, snapshot.price, snapshot.rating,
      snapshot.reviewCount, snapshot.bsr, snapshot.estimatedSales,
      snapshot.estimatedRevenue, snapshot.sellerCount, snapshot.growth7d,
      snapshot.growth30d, snapshot.growth90d, provenance.source, provenance.sourceType,
      provenance.collectedAt, provenance.period, provenance.isEstimated ? 1 : 0,
      provenance.confidence,
      snapshot.date, `product|${this.repository.getSettings().marketplace}|${productId}|${snapshot.date}|${provenance.sourceType.trim().toLowerCase()}|${provenance.source.trim().toLowerCase()}|${provenance.period}`,
    );
  }

  private analyzeProductSnapshot({ productId, product }: PreparedProductSnapshot): void {
    if (product.isOwned) {
      this.ai.analyze({ entityType: 'owned_product', entityId: productId });
    } else {
      const owners = this.database.prepare(`
        SELECT relation.owned_product_id AS id
        FROM competitor_relations relation
        JOIN products owned ON owned.id = relation.owned_product_id
        WHERE relation.competitor_product_id = ? AND owned.marketplace = ?
          AND owned.is_owned = 1 AND owned.is_parent = 0 AND owned.status = 'active'
      `).all(productId, this.repository.getSettings().marketplace) as Array<{ id: string }>;
      owners.forEach((owner) => this.ai.analyze({ entityType: 'owned_product', entityId: owner.id }));
    }
  }
}

type PersistableProductSnapshot = ProductSnapshot & {
  price: number;
  rating: number;
  reviewCount: number;
  bsr: number;
  estimatedSales: number;
  estimatedRevenue: number;
  sellerCount: number;
  growth7d: number;
  growth30d: number;
  growth90d: number;
};

interface LocalProductIdentity {
  asin: string;
  marketplace: string;
  isOwned: number;
}

interface PreparedMarketSnapshot {
  marketId: string;
  overview: MarketOverviewRecord;
}

interface PreparedProductSnapshot {
  productId: string;
  product: LocalProductIdentity;
  snapshot: PersistableProductSnapshot;
}

function validateAdapterProvenance(adapter: MarketDataAdapter, provenance: Provenance): void {
  if (provenance.sourceType !== adapter.sourceType) {
    throw new Error(`Adapter ${adapter.id} 返回的 sourceType 与注册信息不一致。`);
  }
  if (typeof provenance.source !== 'string' || !provenance.source.trim()
    || typeof provenance.period !== 'string' || !provenance.period.trim()
    || typeof provenance.isEstimated !== 'boolean') {
    throw new Error(`Adapter ${adapter.id} 返回的来源追溯信息不完整。`);
  }
  if (!isStrictIsoTimestamp(provenance.collectedAt)) {
    throw new Error(`Adapter ${adapter.id} 返回的 collectedAt 必须是有效 ISO-8601 时间。`);
  }
  if (!Number.isFinite(provenance.confidence) || provenance.confidence < 0 || provenance.confidence > 1) {
    throw new Error(`Adapter ${adapter.id} 返回的 confidence 必须在 0 到 1 之间。`);
  }
}

function validateMarketOverview(overview: MarketOverviewRecord): void {
  const nonNegativeFields: Array<[string, number]> = [
    ['productCount', overview.productCount],
    ['sellerCount', overview.sellerCount],
    ['brandCount', overview.brandCount],
    ['monthlySales', overview.monthlySales],
    ['monthlyRevenue', overview.monthlyRevenue],
    ['avgPrice', overview.avgPrice],
    ['medianPrice', overview.medianPrice],
    ['medianReviews', overview.medianReviews],
  ];
  for (const [field, value] of nonNegativeFields) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Adapter 返回的市场字段 ${field} 无效。`);
    }
  }
  for (const [field, value] of [
    ['productCount', overview.productCount],
    ['sellerCount', overview.sellerCount],
    ['brandCount', overview.brandCount],
  ] as Array<[string, number]>) {
    if (!Number.isInteger(value)) throw new Error(`Adapter 返回的市场字段 ${field} 必须为整数。`);
  }
  if (!Number.isFinite(overview.avgRating) || overview.avgRating < 0 || overview.avgRating > 5) {
    throw new Error('Adapter 返回的市场字段 avgRating 无效。');
  }
  for (const [field, value] of [
    ['top10Share', overview.top10Share],
    ['top20Share', overview.top20Share],
    ['newProductShare', overview.newProductShare],
  ] as Array<[string, number]>) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`Adapter 返回的市场字段 ${field} 无效。`);
    }
  }
  if (overview.top20Share < overview.top10Share) {
    throw new Error('Adapter 返回的市场集中度无效：Top 20 份额不能低于 Top 10。');
  }
  if (!Array.isArray(overview.priceBands) || !Array.isArray(overview.concentration)) {
    throw new Error('Adapter 返回的市场分布字段缺失。');
  }
  const invalidPriceBand = overview.priceBands.some((band) => (
    typeof band.label !== 'string'
    || !band.label.trim()
    || !Number.isInteger(band.productCount)
    || !Number.isInteger(band.newProducts)
    || [band.productCount, band.monthlySales, band.revenue, band.avgReviews, band.newProducts]
      .some((value) => !Number.isFinite(value) || value < 0)
    || !Number.isFinite(band.growth)
  ));
  const invalidConcentration = overview.concentration.some((tier) => (
    typeof tier.tier !== 'string'
    || !tier.tier.trim()
    || !Number.isFinite(tier.share) || tier.share < 0 || tier.share > 100
    || [tier.avgPrice, tier.avgSales].some((value) => !Number.isFinite(value) || value < 0)
  ));
  if (invalidPriceBand || invalidConcentration) {
    throw new Error('Adapter 返回的市场分布字段无效。');
  }
}

function validateProductIdentity(
  adapter: MarketDataAdapter,
  expected: LocalProductIdentity,
  detail: ProductDetailRecord,
): void {
  if (normalizeIdentity(detail.asin) !== normalizeIdentity(expected.asin)) {
    throw new Error(`Adapter ${adapter.id} 返回的 ASIN 与刷新目标不一致。`);
  }
  if (normalizeIdentity(detail.marketplace) !== normalizeIdentity(expected.marketplace)) {
    throw new Error(`Adapter ${adapter.id} 返回的 marketplace 与刷新目标不一致。`);
  }
  if (typeof detail.id !== 'string' || !detail.id.trim()
    || typeof detail.latest?.productId !== 'string'
    || detail.latest.productId !== detail.id) {
    throw new Error(`Adapter ${adapter.id} 返回的产品与快照身份不一致。`);
  }
}

function sameProvenance(left: Provenance, right: Provenance): boolean {
  return left.source === right.source
    && left.sourceType === right.sourceType
    && left.collectedAt === right.collectedAt
    && left.period === right.period
    && left.isEstimated === right.isEstimated
    && left.confidence === right.confidence;
}

function validateProductSnapshot(
  snapshot: ProductSnapshot,
): asserts snapshot is PersistableProductSnapshot {
  if (!snapshot.snapshotAvailable || !isStrictIsoDate(snapshot.date)) {
    throw new Error('Adapter 返回的产品快照缺少有效日期。');
  }
  const requiredFields: Array<[string, number | null]> = [
    ['price', snapshot.price],
    ['rating', snapshot.rating],
    ['reviewCount', snapshot.reviewCount],
    ['bsr', snapshot.bsr],
    ['estimatedSales', snapshot.estimatedSales],
    ['estimatedRevenue', snapshot.estimatedRevenue],
    ['sellerCount', snapshot.sellerCount],
    ['growth7d', snapshot.growth7d],
    ['growth30d', snapshot.growth30d],
    ['growth90d', snapshot.growth90d],
  ];
  for (const [field, value] of requiredFields) {
    if (value === null || !Number.isFinite(value)) {
      throw new Error(`Adapter 返回的产品字段 ${field} 缺失或无效。`);
    }
  }
  const nonNegativeFields: Array<[string, number | null]> = [
    ['price', snapshot.price],
    ['reviewCount', snapshot.reviewCount],
    ['bsr', snapshot.bsr],
    ['estimatedSales', snapshot.estimatedSales],
    ['estimatedRevenue', snapshot.estimatedRevenue],
    ['sellerCount', snapshot.sellerCount],
  ];
  for (const [field, value] of nonNegativeFields) {
    if (value === null || value < 0) throw new Error(`Adapter 返回的产品字段 ${field} 不能为负数。`);
  }
  if (snapshot.rating === null || snapshot.rating < 0 || snapshot.rating > 5) {
    throw new Error('Adapter 返回的产品字段 rating 必须在 0 到 5 之间。');
  }
  for (const [field, value] of [
    ['reviewCount', snapshot.reviewCount],
    ['bsr', snapshot.bsr],
    ['sellerCount', snapshot.sellerCount],
  ] as Array<[string, number | null]>) {
    if (value === null || !Number.isInteger(value)) {
      throw new Error(`Adapter 返回的产品字段 ${field} 必须为整数。`);
    }
  }
}

function normalizeIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  return Boolean(match && isStrictIsoDate(match[1]) && Number.isFinite(Date.parse(value)));
}

function isStrictIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
