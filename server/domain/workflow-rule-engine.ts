import type { RuleProfile, ScoreResult } from '../../shared/types.js';

interface ScoreComponentConfig {
  field: string;
  weight: number;
  direction: 'higher' | 'lower';
  min: number;
  max: number;
}

interface ScoreCategoryConfig {
  max: number;
  components: ScoreComponentConfig[];
}

export interface RuleMissingField {
  fieldName: string;
  reason: string;
  manualValidationRequired: boolean;
}

export interface ProductRuleResult {
  hardGateStatus: 'pass' | 'reject' | 'needs_data';
  score: number | null;
  breakdown: ScoreResult['breakdown'] | null;
  calculation: Record<string, unknown>;
  missing: RuleMissingField[];
  rejectionReasons: string[];
  suggestedDecision: 'develop' | 'test' | 'watch' | 'reject' | 'needs_data';
}

const SCORE_KEYS = [
  'demandQuality',
  'competitiveEntry',
  'profitAndCashEfficiency',
  'supplyChainFit',
  'riskControl',
] as const;

const SAFETY_REQUIRED_INPUT_FIELDS = [
  'ip_risk',
  'certification_required',
  'estimated_contribution_profit_rate',
  'moq_cost',
  'weight',
  'dimensions',
  'supply_chain_validation',
] as const;

const BOOLEAN_INPUT_FIELDS = [
  'certification_required',
  'certification_available',
  'supply_chain_validation',
] as const;

const NUMERIC_GATE_INPUT_FIELDS = [
  'estimated_contribution_profit_rate',
  'moq_cost',
  'weight',
] as const;

const IP_RISK_VALUES = new Set(['low', 'medium', 'high', 'critical', 'unknown']);

export function executeProductRules(
  profile: RuleProfile,
  input: Record<string, unknown>,
  taskBook: Record<string, unknown>,
): ProductRuleResult {
  const hardGates = profile.hardGates;
  const prepared: Record<string, unknown> = {
    ...input,
    moq_budget_ratio: numeric(input.moq_cost) !== null && numeric(taskBook.per_product_budget) !== null
      && numeric(taskBook.per_product_budget)! > 0
      ? numeric(input.moq_cost)! / numeric(taskBook.per_product_budget)!
      : null,
  };
  const configuredMissing = arrayOfStrings(hardGates.needsData);
  const requiredSafetyFields = [...SAFETY_REQUIRED_INPUT_FIELDS, ...configuredMissing];
  const missingFields = new Set(requiredSafetyFields.filter((field) => isMissing(prepared[field])));
  const invalidDomainReasons = validateProductRuleDomains(input, taskBook);
  invalidDomainReasons.forEach((_reason, field) => missingFields.add(field));

  // Fatal gates are evaluated before completeness. A known critical risk cannot be
  // diluted into a generic needs-data result by unrelated missing score inputs.
  const fatalRejectionReasons = evaluateKnownFatalGates(hardGates, input, taskBook);
  if (fatalRejectionReasons.length > 0) {
    return {
      hardGateStatus: 'reject', score: null, breakdown: null,
      calculation: { order: ['hard_gate', 'score'], scoreSkipped: true },
      missing: [], rejectionReasons: fatalRejectionReasons, suggestedDecision: 'reject',
    };
  }

  if (input.certification_required === true && isMissing(input.certification_available)) {
    missingFields.add('certification_available');
  }
  addTaskBookMissingFields(missingFields, taskBook);
  addMissingObjectFields(missingFields, 'dimensions', input.dimensions, ['length', 'width', 'height']);

  for (const category of configuredScoreCategories(profile)) {
    for (const component of category.components) {
      if (numeric(prepared[component.field]) === null) missingFields.add(component.field);
    }
  }

  const missing = [...missingFields].map((fieldName) => ({
    fieldName,
    reason: invalidDomainReasons.get(fieldName)
      ?? `规则 ${profile.id}@${profile.version} 需要该字段，当前没有可验证值。`,
    manualValidationRequired: isManualValidationField(fieldName),
  }));
  if (missing.length > 0) {
    return {
      hardGateStatus: 'needs_data', score: null, breakdown: null,
      calculation: { order: ['missing_data', 'hard_gate', 'score'], evaluated: 'missing_data' },
      missing, rejectionReasons: [], suggestedDecision: 'needs_data',
    };
  }

  const rejectionReasons = evaluateRejectionGates(hardGates, input, taskBook);
  if (input.supply_chain_validation !== true) {
    return {
      hardGateStatus: 'needs_data', score: null, breakdown: null,
      calculation: { supply_chain_validation: input.supply_chain_validation },
      missing: [{
        fieldName: 'supply_chain_validation',
        reason: '供应链能力尚未人工验证。',
        manualValidationRequired: true,
      }],
      rejectionReasons: [], suggestedDecision: 'needs_data',
    };
  }
  if (rejectionReasons.length > 0) {
    return {
      hardGateStatus: 'reject', score: null, breakdown: null,
      calculation: { order: ['hard_gate', 'score'], scoreSkipped: true },
      missing: [], rejectionReasons, suggestedDecision: 'reject',
    };
  }

  const breakdown = calculateConfiguredScore(profile, prepared);
  const score = round1(Object.values(breakdown).reduce((sum, value) => sum + value, 0));
  const thresholds = profile.thresholds;
  const suggestedDecision = score >= requiredNumber(thresholds.developMin, 'developMin')
    ? 'develop'
    : score >= requiredNumber(thresholds.testMin, 'testMin')
      ? 'test'
      : score >= requiredNumber(thresholds.watchMin, 'watchMin')
        ? 'watch'
        : 'reject';
  return {
    hardGateStatus: 'pass', score, breakdown,
    calculation: {
      formula: 'sum(category(component normalized between configured min/max * weight))',
      configuredScoring: profile.scoring,
      preparedInputs: prepared,
    },
    missing: [], rejectionReasons: [], suggestedDecision,
  };
}

function evaluateRejectionGates(
  hardGates: Record<string, unknown>,
  input: Record<string, unknown>,
  taskBook: Record<string, unknown>,
): string[] {
  const reject = isRecord(hardGates.reject) ? hardGates.reject : {};
  const reasons: string[] = [];
  const rejectedIpRisks = uniqueStrings(['critical', ...arrayOfStrings(reject.ipRisk)]);
  if (typeof input.ip_risk === 'string' && rejectedIpRisks.includes(input.ip_risk)) {
    reasons.push(`IP 风险为 ${input.ip_risk}，触发硬性拒绝。`);
  }
  const rejectedCertification = Array.isArray(reject.certificationAvailable)
    ? [...reject.certificationAvailable, false]
    : [false];
  if (input.certification_required === true && rejectedCertification.includes(input.certification_available)) {
    reasons.push('所需认证当前不可获得，触发硬性拒绝。');
  }
  {
    const profit = requiredNumber(input.estimated_contribution_profit_rate, 'estimated_contribution_profit_rate');
    const minimum = requiredNumber(taskBook.min_profit_rate, 'min_profit_rate');
    if (profit < minimum) reasons.push(`预计贡献利润率 ${profit}% 低于最低要求 ${minimum}%。`);
  }
  {
    const moqCost = requiredNumber(input.moq_cost, 'moq_cost');
    const budget = requiredNumber(taskBook.per_product_budget, 'per_product_budget');
    if (moqCost > budget) reasons.push(`MOQ 成本 ${moqCost} 超过单品预算 ${budget}。`);
  }
  {
    const weight = requiredNumber(input.weight, 'weight');
    const maxWeight = requiredNumber(taskBook.max_weight, 'max_weight');
    if (weight > maxWeight) reasons.push(`重量 ${weight} 超过物流能力上限 ${maxWeight}。`);
    if (dimensionsExceed(input.dimensions, taskBook.max_dimension)) {
      reasons.push('产品尺寸超过任务书中的物流能力上限。');
    }
  }
  return reasons;
}

function calculateConfiguredScore(
  profile: RuleProfile,
  values: Record<string, unknown>,
): ScoreResult['breakdown'] {
  const result = {} as ScoreResult['breakdown'];
  for (const key of SCORE_KEYS) {
    const category = scoreCategory(profile.scoring[key], key);
    const raw = category.components.reduce((sum, component) => {
      const value = requiredNumber(values[component.field], component.field);
      const span = component.max - component.min;
      if (span <= 0) throw new Error(`规则 ${key}.${component.field} 的 max 必须大于 min。`);
      const ratio = component.direction === 'higher'
        ? clamp((value - component.min) / span)
        : clamp((component.max - value) / span);
      return sum + ratio * component.weight;
    }, 0);
    result[key] = round1(Math.min(category.max, raw));
  }
  return result;
}

function configuredScoreCategories(profile: RuleProfile): ScoreCategoryConfig[] {
  return SCORE_KEYS.map((key) => scoreCategory(profile.scoring[key], key));
}

function scoreCategory(value: unknown, name: string): ScoreCategoryConfig {
  if (!isRecord(value) || numeric(value.max) === null || !Array.isArray(value.components)) {
    throw new Error(`规则评分配置缺少 ${name} 的 max/components。`);
  }
  const components: ScoreComponentConfig[] = value.components.map((component, index) => {
    if (!isRecord(component)) throw new Error(`规则 ${name}.components[${index}] 无效。`);
    const direction = component.direction;
    if (direction !== 'higher' && direction !== 'lower') {
      throw new Error(`规则 ${name}.components[${index}] direction 无效。`);
    }
    return {
      field: requiredString(component.field, `${name}.field`),
      weight: requiredNumber(component.weight, `${name}.weight`),
      direction: direction as ScoreComponentConfig['direction'],
      min: requiredNumber(component.min, `${name}.min`),
      max: requiredNumber(component.max, `${name}.max`),
    };
  });
  return { max: requiredNumber(value.max, `${name}.max`), components };
}

function evaluateKnownFatalGates(
  hardGates: Record<string, unknown>,
  input: Record<string, unknown>,
  taskBook: Record<string, unknown>,
): string[] {
  const reject = isRecord(hardGates.reject) ? hardGates.reject : {};
  const reasons: string[] = [];
  const rejectedIpRisks = uniqueStrings(['critical', ...arrayOfStrings(reject.ipRisk)]);
  if (typeof input.ip_risk === 'string' && rejectedIpRisks.includes(input.ip_risk)) {
    reasons.push(`IP 风险为 ${input.ip_risk}，触发硬性拒绝。`);
  }
  const rejectedCertification = Array.isArray(reject.certificationAvailable)
    ? [...reject.certificationAvailable, false]
    : [false];
  if (input.certification_required === true && rejectedCertification.includes(input.certification_available)) {
    reasons.push('所需认证当前不可获得，触发硬性拒绝。');
  }
  const profit = numeric(input.estimated_contribution_profit_rate);
  const minimumProfit = numeric(taskBook.min_profit_rate);
  if (isPercent(profit) && isPercent(minimumProfit) && profit < minimumProfit) {
    reasons.push(`预计贡献利润率 ${profit}% 低于最低要求 ${minimumProfit}%。`);
  }
  const moqCost = numeric(input.moq_cost);
  const budget = numeric(taskBook.per_product_budget);
  if (isPositive(moqCost) && isPositive(budget) && moqCost > budget) {
    reasons.push(`MOQ 成本 ${moqCost} 超过单品预算 ${budget}。`);
  }
  const weight = numeric(input.weight);
  const maxWeight = numeric(taskBook.max_weight);
  if (isPositive(weight) && isPositive(maxWeight) && weight > maxWeight) {
    reasons.push(`重量 ${weight} 超过物流能力上限 ${maxWeight}。`);
  }
  if (
    hasPositiveDimensions(input.dimensions)
    && hasPositiveDimensions(taskBook.max_dimension)
    && dimensionsExceed(input.dimensions, taskBook.max_dimension)
  ) {
    reasons.push('产品尺寸超过任务书中的物流能力上限。');
  }
  const prohibitedType = matchedProhibitedProductType(input, taskBook);
  if (prohibitedType) {
    reasons.push(`产品 idea/type 明确命中禁做类型“${prohibitedType}”，触发硬性拒绝。`);
  }
  return reasons;
}

function validateProductRuleDomains(
  input: Record<string, unknown>,
  taskBook: Record<string, unknown>,
): Map<string, string> {
  const invalid = new Map<string, string>();
  const ipRisk = input.ip_risk;
  if (!isMissing(ipRisk)) {
    if (typeof ipRisk !== 'string' || !IP_RISK_VALUES.has(ipRisk)) {
      invalid.set('ip_risk', 'ip_risk 必须是 low、medium、high、critical 或 unknown。');
    } else if (ipRisk === 'unknown') {
      invalid.set('ip_risk', 'ip_risk 为 unknown，必须完成人工风险核验后才能通过 Hard Gate。');
    }
  }
  for (const field of BOOLEAN_INPUT_FIELDS) {
    const value = input[field];
    if (!isMissing(value) && typeof value !== 'boolean') {
      invalid.set(field, `${field} 必须是 boolean true 或 false。`);
    }
  }
  for (const field of NUMERIC_GATE_INPUT_FIELDS) {
    const value = input[field];
    if (!isMissing(value) && numeric(value) === null) {
      invalid.set(field, `${field} 必须是有限数字，不能使用数字字符串或其他类型。`);
    }
  }
  addNumberRangeIssue(invalid, 'estimated_contribution_profit_rate', input.estimated_contribution_profit_rate, isPercent,
    'estimated_contribution_profit_rate 必须在 0 到 100 之间。');
  addNumberRangeIssue(invalid, 'moq_cost', input.moq_cost, isPositive,
    'moq_cost 必须是大于 0 的有限数字。');
  addNumberRangeIssue(invalid, 'weight', input.weight, isPositive,
    'weight 必须是大于 0 的有限数字。');
  addPositiveObjectFields(invalid, 'dimensions', input.dimensions, ['length', 'width', 'height']);

  for (const field of ['total_budget', 'per_product_budget', 'max_weight'] as const) {
    addNumberRangeIssue(invalid, field, taskBook[field], isPositive,
      `${field} 必须是大于 0 的有限数字。`);
  }
  addNumberRangeIssue(invalid, 'min_profit_rate', taskBook.min_profit_rate, isPercent,
    'min_profit_rate 必须在 0 到 100 之间。');
  addPositiveObjectFields(invalid, 'max_dimension', taskBook.max_dimension, ['length', 'width', 'height']);
  if (isRecord(taskBook.price_range)) {
    const minimum = taskBook.price_range.min;
    const maximum = taskBook.price_range.max;
    addNumberRangeIssue(invalid, 'price_range.min', minimum, isNonNegative,
      'price_range.min 必须是大于或等于 0 的有限数字。');
    addNumberRangeIssue(invalid, 'price_range.max', maximum, isNonNegative,
      'price_range.max 必须是大于或等于 0 的有限数字。');
    if (isNonNegative(minimum) && isNonNegative(maximum) && minimum > maximum) {
      invalid.set('price_range.max', 'price_range.max 必须大于或等于 price_range.min。');
    }
  }
  return invalid;
}

function addNumberRangeIssue(
  invalid: Map<string, string>,
  field: string,
  value: unknown,
  predicate: (value: unknown) => value is number,
  reason: string,
): void {
  if (!isMissing(value) && !predicate(value)) invalid.set(field, reason);
}

function addPositiveObjectFields(
  invalid: Map<string, string>,
  root: string,
  value: unknown,
  fields: string[],
): void {
  if (!isRecord(value)) return;
  for (const field of fields) {
    const candidate = value[field];
    if (!isMissing(candidate) && !isPositive(candidate)) {
      invalid.set(`${root}.${field}`, `${root}.${field} 必须是大于 0 的有限数字。`);
    }
  }
}

function addMissingObjectFields(
  missing: Set<string>,
  root: string,
  value: unknown,
  fields: string[],
): void {
  if (!isRecord(value)) {
    missing.add(root);
    return;
  }
  fields.forEach((field) => {
    if (numeric(value[field]) === null) missing.add(`${root}.${field}`);
  });
}

function addTaskBookMissingFields(missing: Set<string>, taskBook: Record<string, unknown>): void {
  const requiredTextFields = [
    'marketplace', 'category_scope', 'product_idea', 'compliance_tolerance',
    'seasonality_tolerance', 'target_customer', 'buyer_need', 'notes',
  ];
  const requiredNumericFields = [
    'total_budget', 'per_product_budget', 'min_profit_rate', 'max_weight',
  ];
  const requiredListFields = [
    'allowed_materials', 'supply_chain_capability', 'prohibited_product_types',
  ];
  requiredTextFields.forEach((field) => {
    if (typeof taskBook[field] !== 'string' || taskBook[field].trim().length === 0) missing.add(field);
  });
  requiredNumericFields.forEach((field) => {
    if (numeric(taskBook[field]) === null) missing.add(field);
  });
  requiredListFields.forEach((field) => {
    const value = taskBook[field];
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
      missing.add(field);
    }
  });
  if (!isRecord(taskBook.price_range)) {
    missing.add('price_range');
  } else {
    if (numeric(taskBook.price_range.min) === null) missing.add('price_range.min');
    if (numeric(taskBook.price_range.max) === null) missing.add('price_range.max');
    if (typeof taskBook.price_range.currency !== 'string' || taskBook.price_range.currency.trim().length === 0) {
      missing.add('price_range.currency');
    }
  }
  addMissingObjectFields(missing, 'max_dimension', taskBook.max_dimension, ['length', 'width', 'height']);
}

function hasPositiveDimensions(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ['length', 'width', 'height'].every((field) => isPositive(value[field]));
}

function dimensionsExceed(value: unknown, maximum: unknown): boolean {
  if (!isRecord(value) || !isRecord(maximum)) return false;
  return ['length', 'width', 'height'].some((field) => (
    requiredNumber(value[field], `dimensions.${field}`)
      > requiredNumber(maximum[field], `max_dimension.${field}`)
  ));
}

function matchedProhibitedProductType(
  input: Record<string, unknown>,
  taskBook: Record<string, unknown>,
): string | null {
  const candidates = [
    taskBook.product_idea,
    input.product_type,
    input.productType,
    input.product_idea,
    input.productIdea,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const prohibited = arrayOfStrings(taskBook.prohibited_product_types)
    .map((value) => ({ original: value.trim(), normalized: normalizeProductType(value) }))
    .filter((value) => value.original.length > 0 && value.normalized.length > 0);
  for (const blocked of prohibited) {
    if (candidates.some((candidate) => phraseContains(
      normalizeProductType(candidate), blocked.normalized,
    ))) return blocked.original;
  }
  return null;
}

function normalizeProductType(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function phraseContains(candidate: string, prohibited: string): boolean {
  if (candidate === prohibited) return true;
  const containsCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
    .test(prohibited);
  if (containsCjk) return candidate.includes(prohibited);
  return (` ${candidate} `).includes(` ${prohibited} `);
}

function isManualValidationField(field: string): boolean {
  return ['ip_risk', 'certification_available', 'supply_chain_validation'].includes(field);
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function requiredNumber(value: unknown, name: string): number {
  const parsed = numeric(value);
  if (parsed === null) throw new Error(`规则输入 ${name} 必须是有限数字。`);
  return parsed;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`规则输入 ${name} 必须是字符串。`);
  return value;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
