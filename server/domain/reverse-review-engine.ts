import type {
  ReviewInsight,
  ReverseReviewFailureMode,
  WorkflowEvidence,
} from '../../shared/types.js';

export interface ReverseReviewAssessment {
  verdict: 'proceed' | 'proceed_with_caution' | 'needs_data' | 'reject';
  topFailureModes: ReverseReviewFailureMode[];
  unknowns: string[];
  recommendation: string;
  checklist: Array<{
    check: string;
    status: 'supported' | 'risk' | 'unknown';
    severity: ReverseReviewFailureMode['severity'];
    resolved: boolean;
    evidenceIds: string[];
  }>;
}

interface RiskCandidate extends ReverseReviewFailureMode {
  check: string;
  priority: number;
  unknown?: string;
}

interface ReverseReviewInput {
  jobInput: Record<string, unknown>;
  taskBook: Record<string, unknown>;
  suggestedDecision: string;
  evidence: WorkflowEvidence[];
  reviewInsights: ReviewInsight[];
}

const REQUIRED_CHECKS = [
  'demand_durability',
  'sales_concentration',
  'low_price_dependency',
  'ad_assumptions',
  'reviews_and_returns',
  'copyability',
  'compliance_cost',
  'ip_and_patent',
  'cash_exposure',
  'inventory_turnover',
  'seasonality',
  'price_war',
] as const;

export function assessReverseReview(input: ReverseReviewInput): ReverseReviewAssessment {
  const byMetric = new Map(input.evidence.map((item) => [item.metricName, item.id]));
  const evidenceFor = (...metrics: string[]): string[] => metrics
    .map((metric) => byMetric.get(metric))
    .filter((id): id is string => Boolean(id));
  const number = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );
  const present = (...fields: string[]): boolean => fields.every((field) => {
    const value = input.jobInput[field];
    return value !== null && value !== undefined && value !== '';
  });

  const growth = number(input.jobInput.growth_30d);
  const concentration = number(input.jobInput.top10_sales_share);
  const moq = number(input.jobInput.moq_cost);
  const budget = number(input.taskBook.per_product_budget);
  const profit = number(input.jobInput.estimated_contribution_profit_rate);
  const reviewEvidenceIds = [...new Set(input.reviewInsights.flatMap((item) => item.evidenceIds))];
  const demandHistoryMonths = number(input.jobInput.demand_history_months);
  const demandDurabilityResolved = present('growth_90d', 'demand_history_months')
    && demandHistoryMonths !== null && demandHistoryMonths >= 12;
  const knownFatal = input.jobInput.ip_risk === 'critical'
    || (input.jobInput.certification_required === true && input.jobInput.certification_available === false);
  const candidates: RiskCandidate[] = [
    risk(
      'demand_durability', 76, 'medium',
      `当前仅有 30D 增长 ${growth === null ? '数据缺失' : `${growth}%`}，不足以排除短期热点或需求衰减。`,
      evidenceFor('growth_30d'), demandDurabilityResolved,
      '补充至少 12 个月搜索、销量与事件时间线，并拆分自然增长和短期热点。',
      demandDurabilityResolved ? undefined : '需求持续性尚未由跨季节历史数据证明。',
    ),
    risk(
      'sales_concentration', concentration !== null && concentration >= 50 ? 92 : 58,
      concentration !== null && concentration >= 50 ? 'high' : 'medium',
      `TOP10 销量占比 ${concentration === null ? '未知' : `${concentration}%`}，头部集中可能压缩新品可进入空间。`,
      evidenceFor('top10_sales_share'), concentration !== null && concentration < 35,
      '核验 TOP20/TOP100 分布、新品份额和头部品牌流量来源。',
      concentration === null ? '销量集中度尚未验证。' : undefined,
    ),
    risk(
      'low_price_dependency', 68, 'medium',
      '新品增长是否依赖低价尚未被价格带和新品队列历史证明。',
      evidenceFor('estimated_contribution_profit_rate'), present('new_product_price_dependency'),
      '对比新品首发价、券后价、销量和排名变化，验证非低价条件下的需求。',
      present('new_product_price_dependency') ? undefined : '新品增长的低价依赖尚未验证。',
    ),
    risk(
      'ad_assumptions', 96, 'high',
      'PPC 竞价、获客成本和广告转化假设尚无可追溯输入，盈利测算可能过于乐观。',
      evidenceFor('estimated_contribution_profit_rate'),
      present('ppc_bid', 'target_conversion_rate', 'target_acquisition_cost'),
      '补充核心词 PPC、目标转化率和盈亏平衡获客成本，并做压力测试。',
      present('ppc_bid', 'target_conversion_rate', 'target_acquisition_cost')
        ? undefined : '广告竞价、转化率和获客成本尚未验证。',
    ),
    risk(
      'reviews_and_returns', input.reviewInsights.length > 0 ? 94 : 90, 'high',
      input.reviewInsights.length > 0
        ? `评论样本暴露 ${input.reviewInsights.map((item) => item.issue).join('、')} 等失败模式，真实退货影响仍未知。`
        : '缺少可分析评论和真实退货数据，无法排除产品体验风险。',
      reviewEvidenceIds, present('return_rate') && input.reviewInsights.length > 0,
      '扩大竞品评论样本并完成样品盲测，补充真实退货率和退货原因。',
      present('return_rate') ? undefined : '真实退货率与退货原因尚未验证。',
    ),
    risk(
      'copyability', 64, 'medium',
      '供应链可生产不等于差异难复制，当前没有防复制或持续差异化证据。',
      evidenceFor('supply_chain_validation', 'supply_chain_fit_score'), present('defensibility_validation'),
      '拆解结构、材料、工艺和品牌资产，验证竞争者复制周期与成本。',
      present('defensibility_validation') ? undefined : '供应链差异的可复制性尚未验证。',
    ),
    risk(
      'compliance_cost', 73, 'medium',
      '任务中的认证判断不能排除标签、材料、声明和目标市场的隐性合规成本。',
      evidenceFor('certification_required', 'certification_available'), present('compliance_cost_reviewed'),
      '由合规负责人确认材料、标签、宣传声明、测试和认证的完整成本。',
      present('compliance_cost_reviewed') ? undefined : '隐性合规要求与成本尚未由负责人确认。',
    ),
    risk(
      'ip_and_patent', 100, input.jobInput.ip_risk === 'critical' ? 'critical' : 'high',
      '当前 IP 风险等级只是任务输入，不能替代专业专利、商标和外观检索。',
      evidenceFor('ip_risk'), input.jobInput.ip_review_completed === true,
      '开发投入前由专业人员完成 IP 检索、相似方案比对并留档。',
      input.jobInput.ip_review_completed === true ? undefined : '专业 IP 检索尚未完成，系统不作安全结论。',
    ),
    risk(
      'cash_exposure', moq !== null && budget !== null && moq / budget >= 0.7 ? 91 : 82,
      moq !== null && budget !== null && moq / budget >= 0.7 ? 'high' : 'medium',
      `MOQ 占单品预算 ${moq !== null && budget ? `${Math.round((moq / budget) * 100)}%` : '比例未知'}，验证失败会形成现金占用。`,
      evidenceFor('moq_cost'), present('payment_terms_validated', 'exit_plan_validated'),
      '验证小批量、付款条件、补货周期和滞销退出方案。',
      present('payment_terms_validated', 'exit_plan_validated') ? undefined : '付款条件与滞销退出方案尚未验证。',
    ),
    risk(
      'inventory_turnover', 88, 'high',
      '缺少库存周转、补货周期和需求下行情景，现有得分不能证明库存风险可控。',
      [], present('inventory_turn_days', 'lead_time_days', 'downside_sales'),
      '建立基准、下行和极端情景的周转天数、补货点与现金峰值。',
      present('inventory_turn_days', 'lead_time_days', 'downside_sales')
        ? undefined : '库存周转、交期和需求下行情景尚未验证。',
    ),
    risk(
      'seasonality', 79, 'medium',
      `任务季节性容忍度为 ${String(input.taskBook.seasonality_tolerance ?? '未知')}，但没有跨季节数据证明风险在容忍范围内。`,
      evidenceFor('growth_30d'), present('seasonality_index'),
      '补充至少一年的月度需求、关键词和价格数据，量化旺淡季现金峰值。',
      present('seasonality_index') ? undefined : '季节性幅度尚未由历史数据验证。',
    ),
    risk(
      'price_war', profit !== null && profit < 25 ? 89 : 74,
      profit !== null && profit < 25 ? 'high' : 'medium',
      `预计贡献利润率 ${profit === null ? '未知' : `${profit}%`}，仍可能被竞品降价、优惠券和广告竞价侵蚀。`,
      evidenceFor('estimated_contribution_profit_rate', 'top10_sales_share'), present('price_war_stress_test'),
      '按售价、折扣、PPC 和退货率联合下行情景重算贡献利润与现金需求。',
      present('price_war_stress_test') ? undefined : '价格战压力测试尚未完成。',
    ),
  ];

  const top = [...candidates]
    .filter((candidate) => !candidate.resolved)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 5)
    .map(stripInternalFields);
  const unknowns = [...new Set(candidates.flatMap((candidate) => candidate.unknown ? [candidate.unknown] : []))];
  const verdict = knownFatal
    ? 'reject'
    : candidates.some((candidate) => candidate.severity === 'critical' && !candidate.resolved)
      ? 'needs_data'
    : top.length > 0 ? 'proceed_with_caution' : 'proceed';

  return {
    verdict,
    topFailureModes: top,
    unknowns,
    recommendation: verdict === 'proceed'
      ? `仅建议进入 ${input.suggestedDecision} 的下一阶段验证；不授权采购、付款、上线或 IP/合规安全判断。`
      : `仅建议在完成高优先级验证后考虑 ${input.suggestedDecision}；不授权采购、付款、上线或 IP/合规安全判断。`,
    checklist: candidates.map((candidate) => ({
      check: candidate.check,
      status: candidate.resolved ? 'supported' : candidate.unknown ? 'unknown' : 'risk',
      severity: candidate.severity,
      resolved: candidate.resolved,
      evidenceIds: candidate.evidenceIds,
    })),
  };
}

export function reverseReviewRequiredChecks(): readonly string[] {
  return REQUIRED_CHECKS;
}

function risk(
  check: string,
  priority: number,
  severity: ReverseReviewFailureMode['severity'],
  description: string,
  evidenceIds: string[],
  resolved: boolean,
  requiredAction: string,
  unknown?: string,
): RiskCandidate {
  return {
    check,
    priority,
    risk: description,
    severity,
    evidenceIds,
    resolved,
    requiredAction,
    unknown,
  };
}

function stripInternalFields(candidate: RiskCandidate): ReverseReviewFailureMode {
  return {
    risk: candidate.risk,
    severity: candidate.severity,
    evidenceIds: candidate.evidenceIds,
    resolved: candidate.resolved,
    requiredAction: candidate.requiredAction,
  };
}
