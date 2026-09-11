import { describe, expect, it } from 'vitest';
import { missingFieldLabel, missingValueKind, parseMissingFieldValue } from './researchJobMissingData';

describe('research job missing-data inputs', () => {
  it('coerces rule and Task Book numbers instead of sending strings', () => {
    expect(parseMissingFieldValue('moq_cost', '4200')).toBe(4200);
    expect(parseMissingFieldValue('per_product_budget', '5000')).toBe(5000);
    expect(parseMissingFieldValue('dimensions.height', '15.5')).toBe(15.5);
    expect(parseMissingFieldValue('max_dimension.width', '45')).toBe(45);
  });

  it('coerces manually validated booleans', () => {
    expect(parseMissingFieldValue('supply_chain_validation', 'true')).toBe(true);
    expect(parseMissingFieldValue('certification_required', 'false')).toBe(false);
    expect(() => parseMissingFieldValue('supply_chain_validation', 'yes')).toThrow();
  });

  it('parses structured roots and rejects malformed JSON', () => {
    expect(parseMissingFieldValue('dimensions', '{"length":40,"width":30,"height":15}')).toEqual({ length: 40, width: 30, height: 15 });
    expect(parseMissingFieldValue('price_range', '{"min":20,"max":40,"currency":"USD"}')).toEqual({ min: 20, max: 40, currency: 'USD' });
    expect(missingValueKind('reviews')).toBe('json');
    expect(() => parseMissingFieldValue('dimensions', '{bad')).toThrow();
  });

  it('turns Task Book comma lists into validated arrays', () => {
    expect(parseMissingFieldValue('allowed_materials', '记忆棉，涤纶, 冰丝')).toEqual(['记忆棉', '涤纶', '冰丝']);
    expect(missingValueKind('supply_chain_capability')).toBe('list');
    expect(() => parseMissingFieldValue('prohibited_product_types', '，, ')).toThrow();
  });

  it('keeps a readable label while preserving the contract field name separately', () => {
    expect(missingFieldLabel('dimensions.height')).toBe('产品高度');
    expect(missingFieldLabel('custom_field', 'Custom Field')).toBe('Custom Field');
    expect(missingFieldLabel('buyer_need')).toBe('买家需求');
  });
});
