import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResearchJobDetail } from '../shared/types.js';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './database/database.js';

let database: AppDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function testApp(): Express {
  database = openDatabase(':memory:');
  return createApp({ database });
}

function productResearchFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    new URL('../examples/research-job-u-shaped.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
}

async function enableDemo(app: Express): Promise<void> {
  await request(app).post('/api/settings/demo').send({ enabled: true }).expect(200);
}

async function createAndRunProductJob(
  app: Express,
  entityType: 'development_project' | 'opportunity',
  entityId: string,
): Promise<ResearchJobDetail> {
  const input = productResearchFixture();
  Object.assign(input, {
    name: `Security gate ${entityType} ${entityId}`,
    type: entityType === 'development_project' ? 'adjacent_product' : 'new_opportunity',
    entityType,
    entityId,
  });
  const created = await request(app).post('/api/research-jobs').send(input).expect(201);
  const run = await request(app)
    .post(`/api/research-jobs/${created.body.data.id as string}/run`)
    .send({})
    .expect(200);
  return run.body.data as ResearchJobDetail;
}

async function approveJob(app: Express, job: ResearchJobDetail): Promise<ResearchJobDetail> {
  expect(job).toMatchObject({
    status: 'waiting_approval',
    approval: { status: 'pending', action: 'test' },
    latestRuleExecution: { hardGateStatus: 'pass' },
    reverseReview: { verdict: 'proceed_with_caution' },
  });
  const response = await request(app)
    .post(`/api/research-jobs/${job.id}/approve`)
    .send({
      decision: 'approved',
      reason: '仅批准规则建议的小规模测试，不授权其他业务动作。',
      decidedBy: 'Security Approver',
    })
    .expect(201);
  return response.body.data as ResearchJobDetail;
}

describe('V2 workflow advancement security', () => {
  it('blocks opportunity promotion and development advancement when no V2 job exists', async () => {
    const app = testApp();
    await enableDemo(app);

    await request(app).post('/api/opportunities/opp-school-kit/promote').send({}).expect(409);
    for (const decision of ['develop', 'test'] as const) {
      await request(app)
        .post('/api/development-projects/dev-travel/decision')
        .send({ decision, reason: 'attempt without gate', decidedBy: 'Bypass Client' })
        .expect(409);
    }

    const legacyDecisions = database!.prepare(`
      SELECT COUNT(*) AS count FROM decisions
      WHERE entity_type = 'development_project' AND entity_id = 'dev-travel'
    `).get() as { count: number };
    const promotedProjects = database!.prepare(`
      SELECT COUNT(*) AS count FROM development_projects
      WHERE source_opportunity_id = 'opp-school-kit'
    `).get() as { count: number };
    expect(legacyDecisions.count).toBe(0);
    expect(promotedProjects.count).toBe(0);
  });

  it('blocks advancement while the matching V2 job is still waiting for approval', async () => {
    const app = testApp();
    await enableDemo(app);
    const developmentJob = await createAndRunProductJob(app, 'development_project', 'dev-travel');

    await request(app)
      .post('/api/development-projects/dev-travel/decision')
      .send({ decision: 'test', reason: 'approval is still pending', decidedBy: 'Bypass Client' })
      .expect(409);
    expect(developmentJob.approval?.status).toBe('pending');
  });

  it('allows only the exact approved development action and requires the latest linked job to be approved', async () => {
    const app = testApp();
    await enableDemo(app);
    const first = await createAndRunProductJob(app, 'development_project', 'dev-travel');
    const approved = await approveJob(app, first);
    expect(approved).toMatchObject({ status: 'approved', decision: { decision: 'approved' } });

    await request(app)
      .post('/api/development-projects/dev-travel/decision')
      .send({ decision: 'develop', reason: 'escalate a test approval', decidedBy: 'Bypass Client' })
      .expect(409);

    const secondInput = productResearchFixture();
    Object.assign(secondInput, {
      name: 'Newer unapproved development research',
      type: 'adjacent_product',
      entityType: 'development_project',
      entityId: 'dev-travel',
    });
    const second = await request(app).post('/api/research-jobs').send(secondInput).expect(201);
    database!.prepare(`UPDATE research_jobs SET updated_at = '9999-12-31T23:59:59.999Z' WHERE id = ?`)
      .run(second.body.data.id as string);

    await request(app)
      .post('/api/development-projects/dev-travel/decision')
      .send({ decision: 'test', reason: 'reuse stale approval', decidedBy: 'Bypass Client' })
      .expect(409);
  });

  it('reuses the exact approved workflow lineage for a development advancement decision', async () => {
    const app = testApp();
    await enableDemo(app);
    const waiting = await createAndRunProductJob(app, 'development_project', 'dev-travel');
    const approved = await approveJob(app, waiting);

    const response = await request(app)
      .post('/api/development-projects/dev-travel/decision')
      .send({ decision: 'test', reason: 'execute the approved test', decidedBy: 'Test Owner' })
      .expect(201);

    expect(response.body.data).toMatchObject({
      status: 'test',
      decision: {
        decision: 'test',
        researchJobId: approved.id,
        reverseReviewId: approved.reverseReview?.id,
        approvalId: approved.approval?.id,
        aiInsightId: approved.latestInsight?.id,
        dataVersion: approved.dataVersion,
      },
    });
    const lineage = database!.prepare(`
      SELECT decision.research_job_id, decision.reverse_review_id,
        decision.approval_id, decision.ai_insight_id,
        insight.prompt_version, insight.evidence_ids_json
      FROM decisions decision
      JOIN ai_insights insight ON insight.id = decision.ai_insight_id
      WHERE decision.entity_type = 'development_project'
        AND decision.entity_id = 'dev-travel'
    `).get() as Record<string, string>;
    expect(lineage).toMatchObject({
      research_job_id: approved.id,
      reverse_review_id: approved.reverseReview?.id,
      approval_id: approved.approval?.id,
      ai_insight_id: approved.latestInsight?.id,
      prompt_version: approved.promptVersion,
    });
    expect(JSON.parse(lineage.evidence_ids_json)).toEqual(approved.latestInsight?.evidenceIds);
    expect(() => database!.prepare(`
      INSERT INTO decisions (
        id, entity_type, entity_id, decision, reason, ai_insight_id,
        data_version, decided_by, decided_at, research_job_id
      ) VALUES (
        'partial-lineage', 'development_project', 'dev-travel', 'test',
        'must fail', ?, ?, 'test', ?, ?
      )
    `).run(
      approved.latestInsight!.id, approved.dataVersion,
      new Date().toISOString(), approved.id,
    )).toThrow(/complete lineage/);
  });

  it('allows promotion after a current test/develop approval but never across the active marketplace', async () => {
    const app = testApp();
    await enableDemo(app);
    const job = await createAndRunProductJob(app, 'opportunity', 'opp-school-kit');
    const approved = await approveJob(app, job);

    await request(app).patch('/api/settings').send({ marketplace: 'CA' }).expect(200);
    await request(app).get('/api/research-jobs?marketplace=US').expect(200)
      .expect((response) => expect(response.body.data).toEqual([]));
    await request(app).get(`/api/research-jobs/${job.id}?marketplace=US`).expect(404);
    await request(app).post('/api/opportunities/opp-school-kit/promote?marketplace=US').send({}).expect(404);

    await request(app).patch('/api/settings').send({ marketplace: 'US' }).expect(200);
    const promoted = await request(app)
      .post('/api/opportunities/opp-school-kit/promote')
      .send({})
      .expect(201);
    expect(promoted.body.data.opportunity.status).toBe('promoted');
    expect(promoted.body.data.project).toMatchObject({
      status: 'test',
      decision: {
        decision: 'test',
        researchJobId: approved.id,
        reverseReviewId: approved.reverseReview?.id,
        approvalId: approved.approval?.id,
        aiInsightId: approved.latestInsight?.id,
        dataVersion: approved.dataVersion,
      },
    });
    expect(database!.prepare(`
      SELECT source_opportunity_id, insight_id FROM development_projects WHERE id = ?
    `).get(promoted.body.data.project.id as string)).toMatchObject({
      source_opportunity_id: 'opp-school-kit',
      insight_id: approved.latestInsight?.id,
    });
    await request(app)
      .post(`/api/development-projects/${promoted.body.data.project.id as string}/analyze`)
      .send({})
      .expect(409);
    expect(database!.prepare(`
      SELECT insight_id FROM development_projects WHERE id = ?
    `).get(promoted.body.data.project.id as string)).toMatchObject({
      insight_id: approved.latestInsight?.id,
    });

    const newerSourceJob = await createAndRunProductJob(app, 'opportunity', 'opp-school-kit');
    expect(newerSourceJob.status).toBe('waiting_approval');
    const inheritedLineage = await request(app)
      .get(`/api/development-projects/${promoted.body.data.project.id as string}`)
      .expect(200);
    expect(inheritedLineage.body.data).toMatchObject({
      insight: { id: approved.latestInsight?.id, researchJobId: approved.id },
      decision: {
        researchJobId: approved.id,
        aiInsightId: approved.latestInsight?.id,
        approvalId: approved.approval?.id,
      },
    });

    const directInput = productResearchFixture();
    Object.assign(directInput, {
      name: 'Direct research supersedes inherited promotion lineage',
      type: 'adjacent_product',
      entityType: 'development_project',
      entityId: promoted.body.data.project.id as string,
    });
    const direct = await request(app).post('/api/research-jobs').send(directInput).expect(201);
    database!.prepare(`UPDATE research_jobs SET updated_at = '9999-12-31T23:59:59.999Z' WHERE id = ?`)
      .run(direct.body.data.id as string);
    const pendingDirect = await request(app)
      .get(`/api/development-projects/${promoted.body.data.project.id as string}`)
      .expect(200);
    expect(pendingDirect.body.data).toMatchObject({
      insight: { id: '', insightType: 'workflow_required' },
    });
    expect(pendingDirect.body.data.decision).toBeUndefined();

    expect(() => database!.prepare(`
      INSERT INTO decisions (
        id, entity_type, entity_id, decision, reason, ai_insight_id,
        data_version, decided_by, decided_at
      ) VALUES (
        'legacy-after-promotion', 'development_project', ?, 'watch',
        'must fail', ?, ?, 'test', ?
      )
    `).run(
      promoted.body.data.project.id as string, approved.latestInsight!.id,
      approved.dataVersion, new Date().toISOString(),
    )).toThrow(/requires workflow lineage/);
  });
});
