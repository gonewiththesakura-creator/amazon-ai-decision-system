import type {AppSettings} from '../../shared/types';
import './release-status.css';

/** Read-only status: historical collection success is not current connectivity. */
export function CollectionStatus({settings}: {settings:AppSettings}) {
  const latest=settings.latestSuccessfulCritical;
  const freshness=settings.connectionFreshness??'UNKNOWN';
  return <span className="collection-status">
    <small>最近成功真实采集 / Certification</small>
    <strong>{latest ? new Date(latest.completedAt).toLocaleString('zh-CN',{hour12:false}) : '尚无成功真实采集'}</strong>
    <small>当前连接状态：{freshness==='UNKNOWN'?'未复测':freshness==='FRESH'?'Fresh':'Stale'}（不影响历史 Certification）</small>
  </span>;
}
