import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowAssets = [
  {
    jobType: 'existing_market',
    prompts: ['market-analysis.v1.md'],
    skill: 'amazon-market-diagnosis',
  },
  {
    jobType: 'owned_product',
    prompts: ['owned-sku-analysis.v1.md'],
    skill: 'owned-sku-analysis',
  },
  {
    jobType: 'adjacent_product',
    prompts: ['product-research.v1.md', 'review-gap.v1.md', 'reverse-review.v1.md'],
    skill: 'amazon-product-research',
  },
  {
    jobType: 'new_opportunity',
    prompts: ['product-research.v1.md', 'review-gap.v1.md', 'reverse-review.v1.md'],
    skill: 'amazon-product-research',
  },
] as const;

describe('versioned workflow assets', () => {
  it.each(workflowAssets)('resolves every prompt and primary skill for $jobType', ({ prompts, skill }) => {
    for (const prompt of prompts) {
      const content = readFileSync(resolve('prompts', prompt), 'utf8');
      expect(content).toMatch(/^# .+v1/m);
      expect(content).toMatch(/Evidence|evidence/);
    }

    const skillContent = readFileSync(resolve('skills', skill, 'SKILL.md'), 'utf8');
    expect(skillContent).toContain(`name: ${skill}`);
    expect(skillContent).toContain('## Workflow');
    expect(skillContent).toContain('## Prohibited');
  });

  it('keeps the specialized review and reverse-review skills versioned in the repository', () => {
    for (const skill of ['review-gap-analysis', 'reverse-risk-review']) {
      const content = readFileSync(resolve('skills', skill, 'SKILL.md'), 'utf8');
      expect(content).toContain(`name: ${skill}`);
      expect(content).toContain('Evidence');
    }
  });
});
