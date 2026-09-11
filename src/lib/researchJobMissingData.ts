export type MissingValueKind = 'number' | 'boolean' | 'risk' | 'json' | 'list' | 'text';

const numericFields = new Set([
  'estimated_contribution_profit_rate',
  'moq_cost',
  'weight',
  'monthly_sales',
  'growth_30d',
  'top10_sales_share',
  'median_reviews',
  'supply_chain_fit_score',
  'risk_control_score',
  'total_budget',
  'per_product_budget',
  'min_profit_rate',
  'max_weight',
]);

const booleanFields = new Set([
  'certification_required',
  'certification_available',
  'supply_chain_validation',
]);

const listFields = new Set([
  'allowed_materials',
  'supply_chain_capability',
  'prohibited_product_types',
]);

const numericPathPattern = /^(dimensions|max_dimension)\.(length|width|height)$/;

const fieldLabels: Record<string, string> = {
  ip_risk: 'IP / 专利风险',
  certification_required: '是否需要认证',
  certification_available: '认证能力是否可用',
  estimated_contribution_profit_rate: '预计贡献利润率',
  moq_cost: 'MOQ 成本',
  weight: '产品重量',
  dimensions: '产品尺寸',
  'dimensions.length': '产品长度',
  'dimensions.width': '产品宽度',
  'dimensions.height': '产品高度',
  supply_chain_validation: '供应链能力验证',
  monthly_sales: '月销量',
  growth_30d: '30D 增长',
  top10_sales_share: 'TOP10 销售占比',
  median_reviews: 'Review 中位数',
  supply_chain_fit_score: '供应链适配分',
  risk_control_score: '风险可控分',
  marketplace: 'Marketplace',
  category_scope: '类目范围',
  product_idea: '产品设想',
  price_range: '目标价格带',
  'price_range.min': '目标价格下限',
  'price_range.max': '目标价格上限',
  'price_range.currency': '目标价格币种',
  total_budget: '总预算',
  per_product_budget: '单品预算',
  min_profit_rate: '最低利润率',
  max_weight: '最大重量',
  max_dimension: '最大允许尺寸',
  'max_dimension.length': '最大允许长度',
  'max_dimension.width': '最大允许宽度',
  'max_dimension.height': '最大允许高度',
  allowed_materials: '允许材料',
  supply_chain_capability: '供应链能力',
  prohibited_product_types: '禁做产品类型',
  compliance_tolerance: '合规风险容忍度',
  seasonality_tolerance: '季节性容忍度',
  target_customer: '目标客户',
  buyer_need: '买家需求',
  notes: '任务书备注',
  moq_budget_ratio: 'MOQ / 单品预算比（系统计算）',
  reviews: '评论样本',
};

export function missingFieldLabel(fieldName: string, fallback?: string): string {
  return fieldLabels[fieldName] ?? fallback ?? fieldName;
}

export function missingValueKind(fieldName: string): MissingValueKind {
  if (numericFields.has(fieldName) || numericPathPattern.test(fieldName)) return 'number';
  if (booleanFields.has(fieldName)) return 'boolean';
  if (listFields.has(fieldName)) return 'list';
  if (fieldName === 'ip_risk') return 'risk';
  if (fieldName === 'dimensions' || fieldName === 'max_dimension' || fieldName === 'price_range' || fieldName === 'reviews') return 'json';
  return 'text';
}

export function parseMissingFieldValue(fieldName: string, value: string): unknown {
  const kind = missingValueKind(fieldName);
  if (kind === 'number') {
    const parsed = Number(value);
    if (!value.trim() || !Number.isFinite(parsed)) throw new Error(`${fieldName} 必须是有效数字`);
    return parsed;
  }
  if (kind === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error(`${fieldName} 必须选择“是”或“否”`);
    return value === 'true';
  }
  if (kind === 'risk') {
    if (!['low', 'medium', 'high', 'critical'].includes(value)) throw new Error('ip_risk 必须选择有效风险等级');
    return value;
  }
  if (kind === 'list') {
    const items = value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (!items.length) throw new Error(`${fieldName} 必须包含至少一个非空文本项`);
    return items;
  }
  if (kind === 'json') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`${fieldName} 必须是有效 JSON`);
    }
  }
  return value;
}
