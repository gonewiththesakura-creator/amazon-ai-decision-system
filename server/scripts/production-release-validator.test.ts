import {describe,it,expect} from 'vitest';
import {canonicalValue,validateContentDelta,validateEvidence,GOLDEN_RUN,type DatabaseContent,type ReleaseEvidence} from './production-release-validator.js';
const base=():DatabaseContent=>({app_settings:[{id:1,mode:'empty',currency:'USD'}],snapshots:[{id:'s',value:7}],facts:[{id:'f',value:null}],evidence:[{id:'e',run:GOLDEN_RUN}]});
const live=()=>{const x=base();x.app_settings![0]!.mode='live';return x;};
const proof=():ReleaseEvidence=>({goldenRunId:GOLDEN_RUN,systemCertification:'PASS',evidence:4,requiredEvidence:4,market:'LIMITED',owned:'LIMITED',roster:5,competitors:5,relations:9,mock:0,mcpCalls:49,usageEvents:59});
describe('production release value semantics',()=>{
 it('ignores null prototype and key insertion order while preserving values',()=>{const row=Object.assign(Object.create(null),{z:null,a:1});expect(canonicalValue(row)).toStrictEqual(canonicalValue({a:1,z:null}));});
 it('ignores inherited prototype properties',()=>{expect(canonicalValue(Object.assign(Object.create({inherited:1}),{a:2}))).toStrictEqual({a:2});});
 it('accepts exactly empty to live and returns per-table logical hashes',()=>{const result=validateContentDelta(base(),live(),'activation');expect(result.tables.facts!.beforeHash).toBe(result.tables.facts!.afterHash);});
 it('accepts SQLite prototypes in the entire activation comparison',()=>{const x=live();for(const t of Object.keys(x))x[t]=x[t]!.map(r=>Object.assign(Object.create(null),r));expect(()=>validateContentDelta(base(),x,'activation')).not.toThrow();});
 it.each(['currency','id','extra','missing','second-row'])('rejects app_settings %s change',kind=>{const x=live();if(kind==='missing')delete x.app_settings![0]!.currency;else if(kind==='second-row')x.app_settings!.push({id:2,mode:'live'});else x.app_settings![0]![kind]='changed';expect(()=>validateContentDelta(base(),x,'activation')).toThrow();});
 it.each(['snapshots','facts','evidence'])('rejects %s content change',table=>{const x=live();x[table]![0]!.value=8;expect(()=>validateContentDelta(base(),x,'activation')).toThrow();});
 it.each(['add','remove'])('rejects row %s',kind=>{const x=live();if(kind==='add')x.facts!.push({id:'f2'});else x.facts!.pop();expect(()=>validateContentDelta(base(),x,'activation')).toThrow();});
 it.each(['extra-table','missing-table','type','null'])('rejects %s mutation',kind=>{const x=live();if(kind==='extra-table')x.extra=[];if(kind==='missing-table')delete x.facts;if(kind==='type')x.snapshots![0]!.value='7';if(kind==='null')x.facts![0]!.value=0;expect(()=>validateContentDelta(base(),x,'activation')).toThrow();});
 it.each(['goldenRunId','evidence','systemCertification','market','owned','roster','competitors','relations','mcpCalls','usageEvents'])('rejects %s invariant change',field=>{const b=proof(),a={...b,[field]:field==='evidence'?3:'wrong'} as ReleaseEvidence;expect(()=>validateEvidence(b,a)).toThrow();});
 it('accepts rollback matching pre-live content',()=>{expect(()=>validateContentDelta(base(),structuredClone(base()),'rollback')).not.toThrow();});
 it('rejects rollback that remains live',()=>{expect(()=>validateContentDelta(base(),live(),'rollback')).toThrow();});
});
