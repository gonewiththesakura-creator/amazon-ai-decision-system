import type {ProductSnapshot} from '../../shared/types';

export function salesLabel(snapshot:Pick<ProductSnapshot,'periodState'>, revenue=false):string {
  return snapshot.periodState==='current_mtd' ? (revenue?'本月累计销售额 MTD':'本月累计销量 MTD') : (revenue?'月销售额':'月销量');
}
