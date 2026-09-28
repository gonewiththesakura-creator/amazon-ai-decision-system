import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResearchJobDetail, WorkflowEvidence } from '../shared/types.js';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './database/database.js';
import { previewAndConfirmCsv } from './test-utils/import-api.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function liveProductJob(): Record<string, unknown> {
  const fixture = JSON.parse(readFileSync(
    new URL('../examples/research-job-u-shaped.json', import.meta.url), 'utf8',
  )) as Record<string, unknown>;
  fixture.type = 'new_opportunity';
  delete fixture.entityType;
  delete fixture.entityId;
  const input = fixture.input as Record<string, unknown>;
  delete input.reviews;
  return fixture;
}

describe('review file import workflow', () => {
  it('binds imported reviews to a live Research Job and feeds Review Gap without filling nulls', async () => {
    database = openDatabase(':memory:');
    const app = createApp({ database });
    const created = (await request(app).post('/api/research-jobs').send(liveProductJob()).expect(201))
      .body.data as ResearchJobDetail;
    const csv = [
      'ReviewId,ProductId,ReviewText,Rating,Date,Marketplace',
      'import-r-1,B0COMP0001,"Too firm and presses against my neck.",2,2026-09-09,US',
      'import-r-2,B0COMP0002,"Strong odor for several days.",,,US',
    ].join('\n');
    const imported = await previewAndConfirmCsv(app, csv, 'reviews.csv', {
      entityType: 'review', researchJobId: created.id, sourceType: 'amazon', marketplace: 'US',
    });
    expect(imported.body.data).toMatchObject({
      entityType: 'review', rowCount: 2, successCount: 2, failureCount: 0,
    });
    expect(database.prepare(`
      SELECT rating, review_date, source FROM reviews
      WHERE research_job_id = ? AND source_record_id = 'import-r-2'
    `).get(created.id)).toMatchObject({
      rating: null, review_date: null, source: expect.stringMatching(/^Amazon Report Import:/),
    });

    const completed = (await request(app).post(`/api/research-jobs/${created.id}/run`).send({}).expect(200))
      .body.data as ResearchJobDetail;
    expect(completed.status).toBe('waiting_approval');
    expect(completed.dataVersion).not.toBe(created.dataVersion);
    expect(completed.reviewInsights.map((item) => item.issue)).toEqual(expect.arrayContaining([
      'too_firm', 'neck_pressure', 'odor',
    ]));
    const evidence = (await request(app).get(`/api/research-jobs/${created.id}/evidence`).expect(200))
      .body.data as WorkflowEvidence[];
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricName: 'review_gap.too_firm', sourceType: 'amazon' }),
      expect.objectContaining({ metricName: 'review_gap.odor', sourceType: 'amazon' }),
    ]));
  });

  it('rejects review rows for a Research Job outside the active marketplace', async () => {
    database = openDatabase(':memory:');
    const app = createApp({ database });
    const created = (await request(app).post('/api/research-jobs').send(liveProductJob()).expect(201))
      .body.data as ResearchJobDetail;
    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    const csv = [
      'ReviewId,ProductId,ReviewText,Marketplace',
      'cross-market-r-1,B0COMP0001,"Too firm",US',
    ].join('\n');
    const result = await previewAndConfirmCsv(app, csv, 'reviews.csv', {
      entityType: 'review', researchJobId: created.id, marketplace: 'CA',
    });
    expect(result.body.data).toMatchObject({ successCount: 0, failureCount: 1 });
    expect(result.body.data.errors[0]).toMatch(/US 与当前工作区站点 CA 不一致/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM reviews').get()).toMatchObject({ count: 0 });
  });
});
