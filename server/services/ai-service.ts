import { createHash, randomUUID } from 'node:crypto';
import type { Evidence, Insight, Provenance } from '../../shared/types.js';
import { opportunityStatus } from '../domain/calculations.js';
import { IntelligenceRepository } from '../repository/intelligence-repository.js';

const DETERMINISTIC_MODEL = 'rule-engine-v1';

export interface AnalyzeRequest {
  entityType: string;
  entityId: string;
  insightType?: string;
}

export interface AIAnalysisResult {
  insight: Insight;
  cached: boolean;
  formal: boolean;
  answer?: string;
  notice: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['insight', 'generatedAt'].includes(key))
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashAnalysisInput(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function performanceLabel(performance: string): string {
  const labels: Record<string, string> = {
    strong_outperform: '明显跑赢',
    outperform: '轻度跑赢',
    in_line: '基本同步',
    underperform: '轻度跑输',
    strong_underperform: '明显跑输',
  };
  return labels[performance] ?? performance;
}

export class DeterministicAIService {
  constructor(private readonly repository: IntelligenceRepository) {}

  preview(request: AnalyzeRequest): AIAnalysisResult {
    const normalizedType = normalizeEntityType(request.entityType);
    const insightType = request.insightType ?? defaultInsightType(normalizedType);
    const payload = this.analysisPayload(normalizedType, request.entityId);
    if (!payload) throw new Error('未找到要分析的实体。');
    const candidate = this.generate(normalizedType, request.entityId, insightType, payload);
    return {
      insight: {
        ...candidate,
        insightType: 'candidate_preview',
        status: '非正式候选',
        title: `候选计算摘要：${candidate.title}`,
        recommendedActions: ['创建并运行对应 Research Job 后，再引用正式结论。'],
      },
      cached: false,
      formal: false,
      notice: '这是未落库的确定性候选摘要，不是正式 Research Job 结论。',
    };
  }

  analyze(request: AnalyzeRequest): { insight: Insight; cached: boolean } {
    const normalizedType = normalizeEntityType(request.entityType);
    const insightType = request.insightType ?? defaultInsightType(normalizedType);
    const payload = this.analysisPayload(normalizedType, request.entityId);
    if (!payload) throw new Error('未找到要分析的实体。');

    const inputHash = hashAnalysisInput(payload);
    const cached = this.repository.getInsightByCacheKey(normalizedType, request.entityId, insightType, inputHash);
    if (cached) return { insight: cached, cached: true };

    const generated = this.generate(normalizedType, request.entityId, insightType, payload);
    this.repository.database.prepare(`
      INSERT INTO ai_insights (
        id, entity_type, entity_id, insight_type, status, title, summary, score,
        facts_json, opportunities_json, risks_json, recommendations_json, evidence_json,
        confidence, model, data_version, input_hash, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generated.id, generated.entityType, generated.entityId, generated.insightType,
      generated.status, generated.title, generated.summary, generated.score ?? null,
      JSON.stringify(generated.facts), JSON.stringify(generated.opportunities),
      JSON.stringify(generated.risks), JSON.stringify(generated.recommendedActions),
      JSON.stringify(generated.evidence), generated.confidence, DETERMINISTIC_MODEL,
      generated.dataVersion, inputHash, generated.generatedAt,
    );
    if (normalizedType === 'development_project') {
      this.repository.database.prepare(`
        UPDATE development_projects SET insight_id = ?, updated_at = ? WHERE id = ?
      `).run(generated.id, generated.generatedAt, request.entityId);
    }
    return { insight: generated, cached: false };
  }

  answerQuestion(
    question: string,
    context?: { entityType?: string; entityId?: string },
  ): AIAnalysisResult {
    const contextualType = context?.entityType ? normalizeEntityType(context.entityType) : '';
    const contextualId = context?.entityId ?? '';
    if (
      contextualId
      && contextualId !== 'overview'
      && ['market', 'owned_product', 'development_project', 'opportunity'].includes(contextualType)
    ) {
      return this.answerFromWorkflow(contextualType, contextualId);
    }
    const lower = question.toLowerCase();
    const owned = this.repository.getOwnedProducts();
    const explicitlyNamedProducts = owned.filter((product) => [
      product.id, product.asin, product.sku, product.internalName, product.title,
    ].some((alias) => alias && lower.includes(alias.toLowerCase())));
    if (explicitlyNamedProducts.length > 1) {
      throw new Error('问题同时匹配多个 SKU，请只指定一个 SKU、ASIN 或内部名称。');
    }
    if (explicitlyNamedProducts.length === 1) {
      return this.answerFromWorkflow('owned_product', explicitlyNamedProducts[0].id);
    }
    if (/\bsku\s*[-:#]?\s*[a-z0-9][a-z0-9-]*\b/i.test(question) || /\bB0[A-Z0-9]{6,}\b/i.test(question)) {
      throw new Error('未找到问题中指定的 SKU 或 ASIN，请检查编号。');
    }
    if (lower.includes('sku') || question.includes('跑输') || question.includes('最差')) {
      const underperforming = owned
        .filter((product) => product.relativeDelta !== null)
        .sort((left, right) => left.relativeDelta! - right.relativeDelta!)[0];
      if (underperforming) return this.answerFromWorkflow('owned_product', underperforming.id);
    }
    if (question.includes('腰') || lower.includes('lumbar')) {
      const project = this.repository.getDevelopmentProjects().find((item) => item.productType.includes('lumbar'));
      if (project) return this.answerFromWorkflow('development_project', project.id);
    }
    const defaultMarket = this.repository.getSettings().defaultMarketId;
    if (defaultMarket) return this.answerFromWorkflow('market', defaultMarket);
    throw new Error('当前没有可分析数据，请先进入 Demo 模式或导入快照。');
  }

  private answerFromWorkflow(entityType: string, entityId: string): AIAnalysisResult {
    const normalizedType = normalizeEntityType(entityType);
    let label = entityId;
    if (normalizedType === 'market') {
      const market = this.repository.getMarket(entityId);
      if (!market) throw new Error('市场不存在。');
      label = market.node.name;
    } else if (normalizedType === 'owned_product') {
      const product = this.repository.getOwnedProduct(entityId);
      if (!product) throw new Error('自有产品不存在。');
      label = product.internalName ?? product.sku ?? product.asin;
    } else if (normalizedType === 'development_project') {
      const project = this.repository.getDevelopmentProject(entityId);
      if (!project) throw new Error('待开发项目不存在。');
      label = project.name;
    } else if (normalizedType === 'opportunity') {
      const opportunity = this.repository.getOpportunity(entityId);
      if (!opportunity) throw new Error('机会不存在。');
      label = opportunity.name;
    } else {
      throw new Error('该实体类型不支持研究结论问答。');
    }

    const formalInsight = this.repository.getCurrentWorkflowInsightForEntity(normalizedType, entityId);
    const insight = formalInsight
      ?? this.repository.workflowRequiredInsight(normalizedType, entityId, label);
    return {
      insight,
      answer: insight.summary,
      cached: Boolean(formalInsight),
      formal: Boolean(formalInsight),
      notice: formalInsight
        ? '回答引用当前版本 Research Job、Rule 与 Evidence。'
        : '当前实体没有可引用的正式工作流结论，请先创建或运行 Research Job。',
    };
  }

  private analysisPayload(entityType: string, entityId: string): unknown | null {
    if (entityType === 'market') {
      const market = this.repository.getMarket(entityId);
      return market ? {
        node: market.node,
        kpis: market.kpis,
        trends: market.trends,
        provenance: market.provenance,
      } : null;
    }
    if (entityType === 'owned_product') {
      const product = this.repository.getOwnedProduct(entityId);
      return product ? {
        product: {
          id: product.id, latest: product.latest, marketGrowth30d: product.marketGrowth30d,
          relativeDelta: product.relativeDelta, performance: product.performance,
        },
        competitors: product.competitors.map((competitor) => ({
          id: competitor.id, relationType: competitor.relationType, latest: competitor.latest,
        })),
      } : null;
    }
    if (entityType === 'development_project') {
      const project = this.repository.getDevelopmentProject(entityId);
      return project ? {
        id: project.id, name: project.name, marketSize: project.marketSize,
        growth30d: project.growth30d, competitionScore: project.competitionScore,
        opportunityScore: project.opportunityScore, scoreBreakdown: project.scoreBreakdown,
      } : null;
    }
    if (entityType === 'opportunity') {
      const opportunity = this.repository.getOpportunity(entityId);
      return opportunity ? {
        id: opportunity.id, score: opportunity.opportunityScore, growth: opportunity.marketGrowth,
        competition: opportunity.competitionScore, status: opportunity.status,
        evidence: opportunity.evidence,
      } : null;
    }
    return null;
  }

  private generate(entityType: string, entityId: string, insightType: string, payload: unknown): Insight {
    const now = new Date().toISOString();
    const settings = this.repository.getSettings();
    const id = randomUUID();
    const dataVersion = `${settings.mode}-${hashAnalysisInput(payload).slice(0, 12)}`;
    if (entityType === 'market') return this.generateMarket(id, entityId, insightType, dataVersion, now);
    if (entityType === 'owned_product') return this.generateOwnedProduct(id, entityId, insightType, dataVersion, now);
    if (entityType === 'development_project') return this.generateDevelopment(id, entityId, insightType, dataVersion, now);
    return this.generateOpportunity(id, entityId, insightType, dataVersion, now);
  }

  private generateMarket(id: string, entityId: string, insightType: string, dataVersion: string, now: string): Insight {
    const market = this.repository.getMarket(entityId);
    if (!market) throw new Error('市场不存在。');
    if (market.trends.length === 0) {
      return {
        id, entityType: 'market', entityId, insightType, status: '数据不足',
        title: `${market.node.name}：当前数据不足`,
        summary: '当前数据不足，结论置信度低，建议至少导入两个时点的市场快照。',
        facts: [], opportunities: [], risks: ['缺少市场快照'],
        recommendedActions: ['导入市场销量、销售额、价格和竞争数据'],
        evidence: [], confidence: 0.1, model: DETERMINISTIC_MODEL,
        dataVersion, generatedAt: now,
      };
    }
    if (!market.node.growth30dAvailable) {
      const currentMonthlySales = market.kpis.monthlySales;
      return {
        id, entityType: 'market', entityId, insightType, status: '数据不足',
        title: `${market.node.name}：缺少 30D 对照快照`,
        summary: `已导入当前时点数据（月销量 ${currentMonthlySales?.toLocaleString() ?? '缺失'}），但没有至少早 30 天的对照快照，无法计算 30D 增长。`,
        facts: currentMonthlySales === null ? [] : [`当前月销量 ${currentMonthlySales.toLocaleString()}`], opportunities: [],
        risks: ['30D 增长尚不可用'], recommendedActions: ['导入至少早 30 天的同市场快照'],
        evidence: [], confidence: 0.2, model: DETERMINISTIC_MODEL, dataVersion, generatedAt: now,
      };
    }
    const growth = market.node.growth30d;
    if (growth === null || market.node.opportunityScore === null
      || market.node.competitionScore === null || market.kpis.monthlySales === null
      || market.kpis.top20Share === null) {
      return {
        id, entityType: 'market', entityId, insightType, status: '数据不足',
        title: `${market.node.name}：关键市场指标缺失`,
        summary: '当前快照缺少生成市场判断所需的数值，系统未用零值补齐。',
        facts: [], opportunities: [], risks: ['关键市场指标缺失'],
        recommendedActions: ['补充完整市场快照'], evidence: [], confidence: 0.1,
        model: DETERMINISTIC_MODEL, dataVersion, generatedAt: now,
      };
    }
    const status = opportunityStatus(market.node.opportunityScore);
    const enoughHistory = market.trends.length >= 2;
    const evidence = this.evidence(
      `evidence-${id}`,
      `${market.node.name} 30D 增长 ${growth}%`,
      [
        { name: 'market_30d_growth', label: '市场 30D 增长', value: growth, unit: '%' },
        { name: 'monthly_sales', label: '月销量', value: market.kpis.monthlySales },
        { name: 'opportunity_score', label: '机会评分', value: market.node.opportunityScore },
      ],
      market.provenance,
    );
    return {
      id, entityType: 'market', entityId, insightType, status,
      title: `${market.node.name}：${growth >= 5 ? '需求仍在扩张' : growth < 0 ? '需求正在收缩' : '需求基本稳定'}`,
      summary: enoughHistory
        ? `最新月销量 ${market.kpis.monthlySales.toLocaleString()}，30D 增长 ${growth}%，机会分 ${market.node.opportunityScore}/100。`
        : '当前数据不足，结论置信度低，建议至少补充两个时点的市场快照。',
      score: market.node.opportunityScore,
      facts: [`月销量 ${market.kpis.monthlySales.toLocaleString()}`, `30D 增长 ${growth}%`, `TOP20 占比 ${market.kpis.top20Share}%`],
      opportunities: growth > 5 ? ['需求增长可支撑细分研究'] : [],
      risks: market.node.competitionScore > 70 ? ['竞争强度较高'] : [],
      recommendedActions: enoughHistory ? ['对照自有 SKU 与增长最快细分'] : ['导入更多历史快照'],
      evidence: [evidence], confidence: enoughHistory ? market.provenance.confidence : 0.25,
      model: DETERMINISTIC_MODEL, dataVersion, generatedAt: now,
    };
  }

  private generateOwnedProduct(id: string, entityId: string, insightType: string, dataVersion: string, now: string): Insight {
    const product = this.repository.getOwnedProduct(entityId);
    if (!product) throw new Error('自有产品不存在。');
    const market = this.repository.getMarket(product.marketNodeId);
    const hasMarketSnapshot = (market?.trends.length ?? 0) > 0;
    const hasMarketGrowth = market?.node.growth30dAvailable ?? false;
    const hasProductSnapshot = Boolean(product.latest.id);
    if (!hasProductSnapshot || !product.latest.growth30dAvailable
      || !product.relativePerformanceAvailable || !hasMarketSnapshot || !hasMarketGrowth) {
      const missing = [
        !hasProductSnapshot ? '产品快照' : '',
        hasProductSnapshot && !product.latest.growth30dAvailable ? '产品 30D 对照快照' : '',
        !hasMarketSnapshot ? '所属市场快照' : '',
        hasMarketSnapshot && !hasMarketGrowth ? '所属市场 30D 对照快照' : '',
      ].filter(Boolean).join('和');
      return {
        id, entityType: 'owned_product', entityId, insightType, status: '数据不足',
        title: `${product.internalName ?? product.sku ?? product.asin}：当前数据不足`,
        summary: `当前缺少${missing}，无法判断 SKU 是否跑赢市场。`,
        facts: [], opportunities: [], risks: ['相对表现不可计算'],
        recommendedActions: ['补充同期 SKU 与所属市场快照'], evidence: [], confidence: 0.1,
        model: DETERMINISTIC_MODEL, dataVersion, generatedAt: now,
      };
    }
    const status = performanceLabel(product.performance);
    const direct = product.competitors.filter((item) => item.relationType === 'direct');
    const skuGrowth = product.latest.growth30d;
    const marketGrowth = product.marketGrowth30d;
    const relativeDelta = product.relativeDelta;
    if (skuGrowth === null || marketGrowth === null || relativeDelta === null) {
      throw new Error('相对表现被标记为可用，但其确定性计算值缺失。');
    }
    return {
      id, entityType: 'owned_product', entityId, insightType, status,
      title: `${product.internalName ?? product.sku ?? product.asin}：${status}`,
      summary: `SKU 30D 增长 ${skuGrowth}%，所属市场 ${marketGrowth}%，相对差 ${relativeDelta}%。`,
      facts: [
        `SKU 30D ${skuGrowth}%`, `市场 30D ${marketGrowth}%`,
        `相对差 ${relativeDelta}%`, `直接竞品 ${direct.length} 个`,
      ],
      opportunities: relativeDelta >= 3 ? ['相对市场表现有优势，可进一步放大有效流量来源'] : [],
      risks: relativeDelta <= -3 ? ['增长低于所属市场，优先判断是流量还是转化问题'] : [],
      recommendedActions: relativeDelta <= -3
        ? ['对比直接竞品的价格、Review 和 BSR 变化', '检查近 30 天流量与转化率']
        : ['保持监控并记录增长来源'],
      evidence: [this.evidence(
        `evidence-${id}`,
        `${product.internalName ?? product.asin} 相对市场 ${relativeDelta}%`,
        [
          { name: 'sku_30d_growth', label: 'SKU 30D 增长', value: skuGrowth, unit: '%' },
          { name: 'market_30d_growth', label: '市场 30D 增长', value: marketGrowth, unit: '%' },
          { name: 'relative_delta', label: '相对差', value: relativeDelta, unit: '%' },
        ], product.latest.provenance,
      )],
      confidence: product.latest.provenance.confidence,
      model: DETERMINISTIC_MODEL, dataVersion, generatedAt: now,
    };
  }

  private generateDevelopment(id: string, entityId: string, insightType: string, dataVersion: string, now: string): Insight {
    const project = this.repository.getDevelopmentProject(entityId);
    if (!project) throw new Error('待开发项目不存在。');
    const { marketSize, growth30d, competitionScore, opportunityScore, scoreBreakdown } = project;
    const insufficientInsight = (): Insight => ({
      id,
      entityType: 'development_project',
      entityId,
      insightType,
      status: '数据不足',
      title: `${project.name}：当前数据不足`,
      summary: '当前数据不足，结论置信度低，建议补充市场规模、增长、TOP100、价格和 Review 门槛数据。',
      facts: [],
      opportunities: [],
      risks: ['尚无可验证的市场快照'],
      recommendedActions: ['导入 SellerSprite CSV/XLSX 或连接真实数据源'],
      evidence: [],
      confidence: 0.1,
      model: DETERMINISTIC_MODEL,
      dataVersion,
      generatedAt: now,
    });
    if (
      marketSize === null
      || growth30d === null
      || competitionScore === null
      || opportunityScore === null
      || scoreBreakdown === null
    ) {
      return insufficientInsight();
    }
    const hasEvidenceData = marketSize > 0
      || Object.values(scoreBreakdown).some((value) => value > 0);
    if (!hasEvidenceData) {
      return insufficientInsight();
    }
    const link = this.repository.database.prepare(`
      SELECT market_node_id FROM development_projects WHERE id = ?
    `).get(entityId) as { market_node_id: string } | undefined;
    const linkedMarket = link ? this.repository.getMarket(link.market_node_id) : null;
    const provenance = linkedMarket?.provenance ?? this.defaultProvenance();
    return {
      id, entityType: 'development_project', entityId, insightType,
      status: '待 V2 工作流审批', title: `${project.name}：规则候选，待 V2 审批`,
      summary: `机会分 ${opportunityScore}/100，30D 增长 ${growth30d}%，竞争强度 ${competitionScore}/100。`,
      score: opportunityScore,
      facts: [`市场规模 ${marketSize.toLocaleString()}`, `30D 增长 ${growth30d}%`, `竞争分 ${competitionScore}`],
      opportunities: growth30d > 8 ? ['市场增长达到深入研究阈值'] : [],
      risks: competitionScore > 70 ? ['竞争偏强，需先验证差异化'] : [],
      recommendedActions: ['创建新产品 Research Job，完成 Hard Gate、Reverse Review 和人工 Approval。'],
      evidence: [this.evidence(`evidence-${id}`, `${project.name} 机会分 ${opportunityScore}`, [
        { name: 'opportunity_score', label: '机会评分', value: opportunityScore },
        { name: 'growth_30d', label: '30D 增长', value: growth30d, unit: '%' },
        { name: 'competition_score', label: '竞争强度', value: competitionScore },
      ], provenance)],
      confidence: provenance.confidence, model: DETERMINISTIC_MODEL,
      dataVersion, generatedAt: now,
    };
  }

  private generateOpportunity(id: string, entityId: string, insightType: string, dataVersion: string, now: string): Insight {
    const opportunity = this.repository.getOpportunity(entityId);
    if (!opportunity) throw new Error('机会不存在。');
    if (opportunity.evidence.length === 0) {
      return {
        id, entityType: 'opportunity', entityId, insightType, status: '数据不足',
        title: `${opportunity.name}：当前数据不足`,
        summary: '当前数据不足，结论置信度低，建议补充需求、竞争、价格与 Review 数据。',
        facts: [], opportunities: [], risks: ['没有可验证证据'],
        recommendedActions: ['先完成数据采集'], evidence: [], confidence: 0.1,
        model: DETERMINISTIC_MODEL, dataVersion, generatedAt: now,
      };
    }
    const status = opportunityStatus(opportunity.opportunityScore);
    return {
      id, entityType: 'opportunity', entityId, insightType, status,
      title: `${opportunity.name}：${status}`,
      summary: opportunity.summary,
      score: opportunity.opportunityScore,
      facts: [`机会分 ${opportunity.opportunityScore}`, `市场增长 ${opportunity.marketGrowth}%`, `竞争分 ${opportunity.competitionScore}`],
      opportunities: opportunity.opportunityScore >= 65 ? ['达到进入机会池的研究阈值'] : [],
      risks: opportunity.competitionScore > 70 ? ['竞争强度较高'] : [],
      recommendedActions: [opportunity.recommendedAction], evidence: opportunity.evidence,
      confidence: opportunity.evidence[0]?.provenance[0]?.confidence ?? 0.65,
      model: DETERMINISTIC_MODEL, dataVersion, generatedAt: now,
    };
  }

  private evidence(
    id: string,
    claim: string,
    metrics: Evidence['metrics'],
    provenance: Provenance,
  ): Evidence {
    return { id, claim, metrics, provenance: [provenance] };
  }

  private defaultProvenance(): Provenance {
    const settings = this.repository.getSettings();
    return {
      source: settings.mode === 'demo' ? '演示数据 / Mock Adapter' : '用户录入 / Import',
      sourceType: settings.mode === 'demo' ? 'mock' : 'import',
      collectedAt: new Date().toISOString(), period: '30D', isEstimated: true,
      confidence: settings.mode === 'demo' ? 0.72 : 0.45,
    };
  }
}

function normalizeEntityType(value: string): string {
  const aliases: Record<string, string> = {
    market_node: 'market',
    ownedProduct: 'owned_product',
    product: 'owned_product',
    developmentProject: 'development_project',
    development: 'development_project',
  };
  return aliases[value] ?? value;
}

function defaultInsightType(entityType: string): string {
  const types: Record<string, string> = {
    market: 'market_analysis',
    owned_product: 'sku_diagnosis',
    development_project: 'development_analysis',
    opportunity: 'opportunity_analysis',
  };
  return types[entityType] ?? 'analysis';
}
