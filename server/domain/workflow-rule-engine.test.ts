import { describe, expect, it } from 'vitest';
import type { RuleProfile } from '../../shared/types.js';
import { executeProductRules } from './workflow-rule-engine.js';

const profile: RuleProfile = {
  id: 'test-v1', name: 'Test', version: 1, active: true,
  jobTypes: ['adjacent_product'], createdAt: '2026-09-10T00:00:00Z',
  hardGates: {
    reject: {
      ipRisk: ['critical'], certificationAvailable: [false],
      contributionProfitBelowMinimum: true, moqBeyondBudget: true,
      logisticsCapabilityExceeded: true,
    },
    needsData: [
      'ip_risk', 'certification_required', 'estimated_contribution_profit_rate',
      'moq_cost', 'weight', 'dimensions', 'supply_chain_validation',
    ],
  },
  scoring: Object.fromEntries([
    ['demandQuality', 25], ['competitiveEntry', 20],
    ['profitAndCashEfficiency', 25], ['supplyChainFit', 15], ['riskControl', 15],
  ].map(([key, max]) => [key, {
    max, components: [{ field: `${key}_value`, weight: max, direction: 'higher', min: 0, max: 100 }],
  }])),
  thresholds: { developMin: 80, testMin: 65, watchMin: 50 },
};

const taskBook = {
  marketplace: 'US', category_scope: 'Pillows', product_idea: 'Test pillow',
  price_range: { min: 20, max: 40, currency: 'USD' }, total_budget: 30_000,
  per_product_budget: 10_000, min_profit_rate: 20, max_weight: 3,
  max_dimension: { length: 60, width: 40, height: 30 },
  allowed_materials: ['memory foam'], supply_chain_capability: ['foam molding'],
  prohibited_product_types: ['medical claims'], compliance_tolerance: 'low',
  seasonality_tolerance: 'medium', target_customer: 'travellers',
  buyer_need: 'neck support', notes: 'Research only',
};
const complete = {
  ip_risk: 'low', certification_required: false,
  estimated_contribution_profit_rate: 30, moq_cost: 4_000, weight: 1.2,
  dimensions: { length: 40, width: 30, height: 15 }, supply_chain_validation: true,
  demandQuality_value: 90, competitiveEntry_value: 80,
  profitAndCashEfficiency_value: 85, supplyChainFit_value: 95, riskControl_value: 90,
};

const weakProfile: RuleProfile = {
  ...profile,
  id: 'weak-profile',
  hardGates: { reject: { ipRisk: [], certificationAvailable: [] }, needsData: [] },
};

describe('workflow rule engine', () => {
  it('routes null required data to needs_data rather than zero', () => {
    const result = executeProductRules(profile, { ...complete, moq_cost: null }, taskBook);
    expect(result.hardGateStatus).toBe('needs_data');
    expect(result.score).toBeNull();
    expect(result.missing.map((item) => item.fieldName)).toContain('moq_cost');
  });

  it('rejects critical IP risk before scoring', () => {
    const result = executeProductRules(profile, { ip_risk: 'critical' }, {});
    expect(result.hardGateStatus).toBe('reject');
    expect(result.score).toBeNull();
    expect(result.rejectionReasons[0]).toMatch(/IP/);
  });

  it('reports malformed nested dimensions as missing data', () => {
    const result = executeProductRules(profile, {
      ...complete, dimensions: { length: 40, width: 30 },
    }, taskBook);
    expect(result.hardGateStatus).toBe('needs_data');
    expect(result.missing.map((item) => item.fieldName)).toContain('dimensions.height');
  });

  it.each([
    ['invalid IP enum', { ip_risk: 'definitely-safe' }, 'ip_risk'],
    ['unknown IP risk', { ip_risk: 'unknown' }, 'ip_risk'],
    ['string certification flag', { certification_required: 'no' }, 'certification_required'],
    ['string certification availability', { certification_available: 'true' }, 'certification_available'],
    ['string supply-chain flag', { supply_chain_validation: 'true' }, 'supply_chain_validation'],
    ['numeric string', { moq_cost: '4000' }, 'moq_cost'],
    ['dimension string', { dimensions: { length: '40', width: 30, height: 15 } }, 'dimensions.length'],
  ])('routes a provided %s to blocking needs_data', (_label, patch, expectedField) => {
    const result = executeProductRules(weakProfile, { ...complete, ...patch }, taskBook);
    expect(result.hardGateStatus).toBe('needs_data');
    expect(result.score).toBeNull();
    expect(result.missing.map((item) => item.fieldName)).toContain(expectedField);
  });

  it.each([
    ['critical IP risk', { ip_risk: 'critical' }, taskBook, /IP/],
    ['unavailable required certification', { certification_required: true, certification_available: false }, taskBook, /认证/],
    ['profit below the task-book minimum', { estimated_contribution_profit_rate: 19 }, taskBook, /利润率/],
    ['MOQ above budget', { moq_cost: 10_001 }, taskBook, /MOQ/],
    ['weight above capability', { weight: 3.1 }, taskBook, /重量/],
    ['dimensions above capability', { dimensions: { length: 61, width: 30, height: 15 } }, taskBook, /尺寸/],
  ])('enforces the non-downgradable safety floor for %s', (_label, patch, book, reason) => {
    const result = executeProductRules(weakProfile, { ...complete, ...patch }, book);
    expect(result.hardGateStatus).toBe('reject');
    expect(result.score).toBeNull();
    expect(result.rejectionReasons.join(' ')).toMatch(reason);
  });

  it('rejects an explicit prohibited product type but not a partial Latin token', () => {
    const prohibited = executeProductRules(weakProfile, complete, {
      ...taskBook,
      product_idea: 'Portable Medical-Claims Travel Pillow',
    });
    expect(prohibited.hardGateStatus).toBe('reject');
    expect(prohibited.rejectionReasons.join(' ')).toContain('medical claims');

    const partialToken = executeProductRules(weakProfile, complete, {
      ...taskBook,
      product_idea: 'Biomedical travel pillow',
      prohibited_product_types: ['medical'],
    });
    expect(partialToken.hardGateStatus).toBe('pass');
  });

  it.each([
    ['profit over 100', { estimated_contribution_profit_rate: 101 }, {}, 'estimated_contribution_profit_rate'],
    ['zero MOQ', { moq_cost: 0 }, {}, 'moq_cost'],
    ['negative weight', { weight: -1 }, {}, 'weight'],
    ['zero product dimension', { dimensions: { length: 0, width: 30, height: 15 } }, {}, 'dimensions.length'],
    ['zero total budget', {}, { total_budget: 0 }, 'total_budget'],
    ['negative per-product budget', {}, { per_product_budget: -1 }, 'per_product_budget'],
    ['minimum profit over 100', {}, { min_profit_rate: 101 }, 'min_profit_rate'],
    ['zero maximum weight', {}, { max_weight: 0 }, 'max_weight'],
    ['zero maximum dimension', {}, { max_dimension: { length: 0, width: 40, height: 30 } }, 'max_dimension.length'],
    ['negative minimum price', {}, { price_range: { min: -1, max: 40, currency: 'USD' } }, 'price_range.min'],
    ['reversed price range', {}, { price_range: { min: 50, max: 40, currency: 'USD' } }, 'price_range.max'],
  ])('blocks the invalid numeric domain %s', (_label, inputPatch, taskBookPatch, expectedField) => {
    const result = executeProductRules(
      weakProfile,
      { ...complete, ...inputPatch },
      { ...taskBook, ...taskBookPatch },
    );
    expect(result.hardGateStatus).toBe('needs_data');
    expect(result.score).toBeNull();
    expect(result.missing.map((item) => item.fieldName)).toContain(expectedField);
  });

  it('calculates the configured five-category score', () => {
    const result = executeProductRules(profile, complete, taskBook);
    expect(result.hardGateStatus).toBe('pass');
    expect(result.breakdown).toEqual({
      demandQuality: 22.5,
      competitiveEntry: 16,
      profitAndCashEfficiency: 21.3,
      supplyChainFit: 14.3,
      riskControl: 13.5,
    });
    expect(result.score).toBe(87.6);
    expect(result.suggestedDecision).toBe('develop');
  });

  it('derives deterministic fields before applying configured missing-data gates', () => {
    const derivedProfile: RuleProfile = {
      ...profile,
      hardGates: {
        ...profile.hardGates,
        needsData: [
          ...(profile.hardGates.needsData as string[]),
          'moq_budget_ratio',
        ],
      },
    };
    const result = executeProductRules(derivedProfile, complete, taskBook);

    expect(result.hardGateStatus).toBe('pass');
    expect(result.missing).toEqual([]);
    expect(result.calculation.preparedInputs).toMatchObject({ moq_budget_ratio: 0.4 });
  });

  it('requires the complete V2 Research Task Book before scoring', () => {
    const result = executeProductRules(profile, complete, {
      per_product_budget: 10_000, min_profit_rate: 20, max_weight: 3,
      max_dimension: { length: 60, width: 40, height: 30 },
    });
    expect(result.hardGateStatus).toBe('needs_data');
    expect(result.score).toBeNull();
    expect(result.missing.map((item) => item.fieldName)).toEqual(expect.arrayContaining([
      'marketplace', 'category_scope', 'product_idea', 'price_range', 'total_budget',
      'allowed_materials', 'supply_chain_capability', 'target_customer', 'buyer_need', 'notes',
    ]));
  });
});
