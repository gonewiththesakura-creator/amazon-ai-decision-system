import type {ProductSnapshot} from '../../shared/types';
import './release-status.css';

export function ProductPeriod({snapshot}: {snapshot:Pick<ProductSnapshot,'periodState'|'provenance'>}) {
  return snapshot.periodState==='current_mtd' ? <small className="product-period" title={snapshot.provenance.collectedAt}>截至 {snapshot.provenance.collectedAt} · MTD 未闭月</small> : null;
}
