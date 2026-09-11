import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  MissingDataItem,
  ResearchJobDetail,
  ReviewInsight,
  WorkflowEvidence,
} from '../shared/types.js';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './database/database.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function uShapedFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    new URL('../examples/research-job-u-shaped.json', import.meta.url), 'utf8',
  )) as Record<string, unknown>;
}

async function runFixture(
  mutate?: (input: Record<string, unknown>) => void,
): Promise<{ app: Express; completed: ResearchJobDetail }> {
  database = openDatabase(':memory:');
  const app = createApp({ database });
  await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
  const body = uShapedFixture();
  const input = body.input as Record<string, unknown>;
  mutate?.(input);
  const created = (await request(app).post('/api/research-jobs').send(body).expect(201))
    .body.data as ResearchJobDetail;
  const completed = (
    await request(app).post(`/api/research-jobs/${created.id}/run`).send({}).expect(200)
  ).body.data as ResearchJobDetail;
  return { app, completed };
}

function insightFor(completed: ResearchJobDetail, issue: string): ReviewInsight {
  const insight = completed.reviewInsights.find((item) => item.issue === issue);
  if (!insight) throw new Error(`Missing review insight for ${issue}`);
  return insight;
}

describe('review-gap evidence and support gates', () => {
  it('keeps unsupported Demo issues unknown while preserving original review provenance', async () => {
    const { app, completed } = await runFixture();

    expect(completed).toMatchObject({
      status: 'waiting_approval',
      reverseReview: { verdict: 'proceed_with_caution' },
      approval: { status: 'pending' },
    });
    expect(completed.reviewInsights.length).toBeGreaterThan(0);
    expect(completed.reviewInsights.every((item) => (
      item.supplyChainSolvable === null
      && item.costImpact === null
      && item.opportunityLevel === 'insufficient_evidence'
    ))).toBe(true);

    const tooFirm = insightFor(completed, 'too_firm');
    expect(tooFirm).toMatchObject({ frequency: 0.5, competitorsAffected: 2 });
    const evidence = (
      await request(app).get(`/api/research-jobs/${completed.id}/evidence`).expect(200)
    ).body.data as WorkflowEvidence[];
    const linked = evidence.filter((item) => tooFirm.evidenceIds.includes(item.id));
    expect(linked.map((item) => item.sourceRecordId).sort()).toEqual([
      'u-review-01', 'u-review-03',
    ]);
    expect(linked.every((item) => (
      item.metricName === 'review_gap.too_firm'
      && item.calculation.includes('frequency=2/4=0.5')
      && item.calculation.includes('competitorsAffected=unique(')
    ))).toBe(true);

    const missing = (
      await request(app).get(`/api/research-jobs/${completed.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    const missingFields = missing.map((item) => item.fieldName);
    expect(missingFields).toContain('review_gap_support.too_firm');
    expect(missing.filter((item) => item.fieldName.startsWith('review_gap_support.'))
      .every((item) => !item.requiredForDecision && item.manualValidationRequired)).toBe(true);
    expect(completed.latestInsight?.missingData).toEqual(expect.arrayContaining(missingFields));
    expect(completed.latestInsight?.opportunities).toEqual([]);
  });

  it('raises only issue-specific opportunities backed by complete verified supplier and cost records', async () => {
    const { app, completed } = await runFixture((input) => {
      input.review_gap_support = {
        too_firm: {
          supplier: {
            verified: true,
            solvable: true,
            source: 'Supplier capability verification',
            source_record_id: 'supplier-too-firm-01',
            collected_at: '2026-09-10T03:00:00.000Z',
          },
          cost: {
            verified: true,
            impact: 'low',
            source: 'Costed BOM verification',
            source_record_id: 'cost-too-firm-01',
            collected_at: '2026-09-10T04:00:00.000Z',
          },
        },
        odor: {
          supplier: {
            verified: true,
            solvable: true,
            source: 'Supplier odor-process verification',
            source_record_id: 'supplier-odor-01',
          },
          cost: {
            verified: true,
            impact: 'high',
            source: 'Odor-process cost verification',
            source_record_id: 'cost-odor-01',
          },
        },
        neck_pressure: {
          supplier: {
            verified: true,
            solvable: true,
            source: 'Supplier geometry verification',
            source_record_id: 'supplier-neck-01',
          },
          cost: {
            verified: true,
            impact: 'low',
            source: 'Geometry cost verification',
          },
        },
      };
    });

    const tooFirm = insightFor(completed, 'too_firm');
    expect(tooFirm).toMatchObject({
      supplyChainSolvable: true,
      costImpact: 'low',
      opportunityLevel: 'high',
    });
    const odor = insightFor(completed, 'odor');
    expect(odor).toMatchObject({
      supplyChainSolvable: true,
      costImpact: 'high',
      opportunityLevel: 'medium',
    });
    expect(insightFor(completed, 'neck_pressure')).toMatchObject({
      supplyChainSolvable: null,
      costImpact: null,
      opportunityLevel: 'insufficient_evidence',
    });

    const evidence = (
      await request(app).get(`/api/research-jobs/${completed.id}/evidence`).expect(200)
    ).body.data as WorkflowEvidence[];
    const tooFirmSourceIds = evidence
      .filter((item) => tooFirm.evidenceIds.includes(item.id))
      .map((item) => item.sourceRecordId);
    expect(tooFirmSourceIds).toEqual(expect.arrayContaining([
      'u-review-01', 'u-review-03', 'supplier-too-firm-01', 'cost-too-firm-01',
    ]));
    expect(evidence.filter((item) => tooFirm.evidenceIds.includes(item.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metricName: 'review_gap.too_firm.supply_chain_solvable',
          sourceRecordId: 'supplier-too-firm-01',
        }),
        expect.objectContaining({
          metricName: 'review_gap.too_firm.cost_impact',
          sourceRecordId: 'cost-too-firm-01',
        }),
      ]),
    );

    const missing = (
      await request(app).get(`/api/research-jobs/${completed.id}/missing-data`).expect(200)
    ).body.data as MissingDataItem[];
    const missingFields = missing.map((item) => item.fieldName);
    expect(missingFields).not.toContain('review_gap_support.too_firm');
    expect(missingFields).not.toContain('review_gap_support.odor');
    expect(missingFields).toContain('review_gap_support.neck_pressure');
    expect(completed.latestInsight?.missingData).toEqual(expect.arrayContaining([
      'review_gap_support.neck_pressure',
    ]));
    expect(completed.latestInsight?.opportunities).toContain('too_firm 为高优先级评论缺口。');
  });
});
