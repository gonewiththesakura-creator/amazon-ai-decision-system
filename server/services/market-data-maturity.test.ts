import {afterEach,describe,expect,it} from 'vitest';
import {openDatabase,type AppDatabase} from '../database/database.js';
import {marketDataMaturity,requires90DaySupport} from './market-data-maturity.js';
import {WorkflowRepository} from '../repository/workflow-repository.js';
import {WorkflowOrchestrator} from './workflow-orchestrator.js';
import {DataCoverageService} from './data-coverage-service.js';
import {IntelligenceRepository} from '../repository/intelligence-repository.js';
import {DeterministicAIService} from './ai-service.js';
import {ExecutiveDashboardService} from './executive-dashboard-service.js';

let db:AppDatabase;
afterEach(()=>{if(db?.isOpen) db.close();});
function fixture() {
  db=openDatabase(':memory:');
  db.exec(`INSERT INTO market_nodes(id,name,level,marketplace,source_type,created_at,status)
    VALUES('market','Cervical',1,'US','import','2026-01-01','active');
    UPDATE app_settings SET mode='empty',default_market_id='market' WHERE id=1;`);
  for(const date of ['2026-07-31','2026-08-31']) add(date);
}
function add(date:string,source='import') {
  db.prepare(`INSERT INTO market_snapshots(id,market_node_id,date,observation_date,product_count,
    monthly_sales,source,source_type,collected_at,period,is_estimated,confidence,dedup_key)
    VALUES(?,'market',?,?,3290,100,'Verified fixture',?,?,'monthly',1,0.8,?)`).run(date,date,date,source,'2026-09-01',date);
}
describe('Market data maturity is independent of permission to go Live',()=>{
  it('is LIMITED with two dates and becomes READY automatically with real 90-day coverage; ignores Mock/future dates',()=>{
    fixture();
    expect(marketDataMaturity(db,'US','market')).toMatchObject({status:'LIMITED',historyDays:31,observationDates:2,hardBlocker:false});
    add('2026-01-01','mock'); add('2099-01-01');
    expect(marketDataMaturity(db,'US','market').status).toBe('LIMITED');
    add('2026-05-31');
    expect(marketDataMaturity(db,'US','market')).toMatchObject({status:'READY',historyDays:92,observationDates:3});
  });
  it('exposes the limitation to Dashboard, ResearchJob and AI Insight and blocks unsupported 90-day claims',()=>{
    fixture();
    expect(new DataCoverageService(db).getCoverage('US').marketDataMaturity?.message).toContain('LIMITED');
    const repo=new WorkflowRepository(db);
    const job=repo.createResearchJob({name:'90 day request',type:'existing_market',entityType:'market',entityId:'market',
      createdBy:'human',input:{analysisWindow:'90D'}});
    expect(job.marketDataMaturity?.status).toBe('LIMITED');
    expect(new WorkflowOrchestrator(db).run(job.id).status).toBe('needs_data');
    expect(db.prepare('SELECT COUNT(*) n FROM ai_insights').get()).toEqual({n:0});
    const insight={status:'watch',title:'Market',summary:'90天市场销量增长20%',facts:[],opportunities:[],risks:[],recommendedActions:[],
      evidenceIds:[],confidence:0,insightType:'market_diagnosis'};
    expect(()=>repo.saveWorkflowInsight(job,insight)).toThrow(/LIMITED/);
    const saved=repo.saveWorkflowInsight(job,{...insight,summary:'仅观察到当前产品数量，其他指标待补。'});
    expect(saved.marketDataMaturity?.status).toBe('LIMITED');
    expect(saved.missingData).toContain('market_history_90d');
    const intelligence=new IntelligenceRepository(db);
    const ai=new DeterministicAIService(intelligence);
    expect(ai.answerQuestion('过去90天市场销量如何？',{entityType:'market',entityId:'market'}))
      .toMatchObject({formal:false,answer:expect.stringContaining('LIMITED')});
    expect(()=>ai.preview({entityType:'market',entityId:'market',insightType:'90D_market_trend'})).toThrow(/LIMITED/);
    expect(ai.preview({entityType:'market',entityId:'market'}).insight.marketDataMaturity?.status).toBe('LIMITED');
    const dashboard=new ExecutiveDashboardService(db,intelligence,repo);
    expect(dashboard.getDashboard('90D').trendComparison.some(s=>s.kind==='market')).toBe(false);
  });
  it('does not mistake absent 90-day values or supported 30-day analysis for a 90-day claim',()=>{
    expect(requires90DaySupport({growth_90d:null,growth_30d:12})).toBe(false);
    expect(requires90DaySupport({growth_90d:0})).toBe(true);
    expect(requires90DaySupport('市场30天增长')).toBe(false);
  });
});
