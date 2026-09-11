import type { DataTask } from '../../shared/types';

export type ImportSource = 'import' | 'amazon';

export interface FileImportResult {
  batchId: string;
  entityType: string;
  rowCount: number;
  successCount: number;
  failureCount: number;
  errors: string[];
  task: DataTask;
}

export function importFailureMessage(result: FileImportResult): string | null {
  if (result.task.status !== 'failed' && result.successCount > 0) return null;
  const details = result.errors.slice(0, 2).join('；') || result.task.errorLog;
  return details
    ? `导入失败：${details}`
    : `导入失败：${result.failureCount || result.rowCount} 行没有写入。`;
}

export function importSummary(result: FileImportResult): string {
  if (result.task.status === 'partial' || result.failureCount > 0) {
    return `部分导入完成：${result.successCount} 行成功，${result.failureCount} 行失败。`;
  }
  return `导入完成：${result.successCount} 行成功。`;
}
