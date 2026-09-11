import type { ResearchJobStatus } from '../../shared/types.js';

const TRANSITIONS: Readonly<Record<ResearchJobStatus, readonly ResearchJobStatus[]>> = {
  draft: ['planned', 'failed'],
  planned: ['collecting', 'failed'],
  collecting: ['normalizing', 'needs_data', 'failed'],
  normalizing: ['validating', 'needs_data', 'failed'],
  validating: ['calculating', 'needs_data', 'failed'],
  calculating: ['analyzing', 'needs_data', 'rejected', 'failed'],
  analyzing: ['reverse_review', 'waiting_approval', 'monitoring', 'needs_data', 'rejected', 'failed'],
  reverse_review: ['waiting_approval', 'needs_data', 'rejected', 'failed'],
  waiting_approval: ['approved', 'watch', 'needs_data', 'rejected', 'failed'],
  approved: ['monitoring'],
  watch: ['monitoring', 'planned'],
  rejected: ['planned'],
  monitoring: ['planned', 'failed'],
  failed: ['planned'],
  needs_data: ['planned', 'rejected'],
};

export function canTransitionResearchJob(
  from: ResearchJobStatus,
  to: ResearchJobStatus,
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertResearchJobTransition(
  from: ResearchJobStatus,
  to: ResearchJobStatus,
): void {
  if (!canTransitionResearchJob(from, to)) {
    throw new Error(`非法 Research Job 状态流转：${from} -> ${to}`);
  }
}

export function isTerminalResearchJobStatus(status: ResearchJobStatus): boolean {
  return ['approved', 'watch', 'rejected', 'monitoring'].includes(status);
}
