import { describe, expect, it } from 'vitest';
import { parsePastedReviews } from './reviewInput';

describe('pasted review input', () => {
  it('parses line input and labels operator provenance', () => {
    expect(parsePastedReviews('B0COMP001 | Too firm for my neck.')).toEqual([{
      reviewId: 'operator-paste-1', sourceRecordId: 'operator-paste-1',
      productId: 'B0COMP001', text: 'Too firm for my neck.', source: 'Operator pasted review',
    }]);
  });

  it('preserves optional JSON fields without inventing rating or date', () => {
    expect(parsePastedReviews('[{"reviewId":"r-1","productId":"p-1","text":"Strong odor"}]')[0])
      .toEqual(expect.not.objectContaining({ rating: expect.anything(), date: expect.anything() }));
  });

  it('rejects malformed lines and duplicate source IDs', () => {
    expect(() => parsePastedReviews('missing separator')).toThrow(/ProductId/);
    expect(() => parsePastedReviews('[{"reviewId":"r","productId":"p1","text":"a"},{"reviewId":"r","productId":"p2","text":"b"}]'))
      .toThrow(/重复/);
  });
});
