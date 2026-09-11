import { describe, expect, it } from 'vitest';
import {
  assertResearchJobTransition,
  canTransitionResearchJob,
} from './research-job-state-machine.js';

describe('research job state machine', () => {
  it('allows the orchestrated happy path and a needs-data retry', () => {
    expect(canTransitionResearchJob('draft', 'planned')).toBe(true);
    expect(canTransitionResearchJob('planned', 'collecting')).toBe(true);
    expect(canTransitionResearchJob('collecting', 'normalizing')).toBe(true);
    expect(canTransitionResearchJob('validating', 'needs_data')).toBe(true);
    expect(canTransitionResearchJob('needs_data', 'planned')).toBe(true);
    expect(canTransitionResearchJob('reverse_review', 'waiting_approval')).toBe(true);
    expect(canTransitionResearchJob('waiting_approval', 'approved')).toBe(true);
  });

  it('rejects approval bypasses', () => {
    expect(() => assertResearchJobTransition('draft', 'approved')).toThrow(/非法/);
    expect(() => assertResearchJobTransition('calculating', 'approved')).toThrow(/非法/);
    expect(() => assertResearchJobTransition('analyzing', 'approved')).toThrow(/非法/);
  });
});
