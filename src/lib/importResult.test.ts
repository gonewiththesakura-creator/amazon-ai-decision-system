import { describe, expect, it } from 'vitest';
import type { FileImportResult } from './importResult';
import { importFailureMessage, importSummary } from './importResult';

function result(status: FileImportResult['task']['status'], successCount: number, failureCount: number): FileImportResult {
  return {
    batchId: 'batch', entityType: 'product', rowCount: successCount + failureCount,
    successCount, failureCount, errors: failureCount ? ['第 2 行字段无效'] : [],
    task: {
      id: 'task', name: 'import', taskType: 'file_import', target: 'file.csv', source: 'Amazon',
      marketplace: 'US', status, startedAt: null, completedAt: null, total: successCount + failureCount,
      success: successCount, failed: failureCount, errorLog: null,
    },
  };
}

describe('file import outcomes', () => {
  it('treats an HTTP-successful all-invalid import as a failure', () => {
    expect(importFailureMessage(result('failed', 0, 2))).toContain('导入失败');
  });

  it('reports partial counts without calling the whole import successful', () => {
    expect(importFailureMessage(result('partial', 2, 1))).toBeNull();
    expect(importSummary(result('partial', 2, 1))).toBe('部分导入完成：2 行成功，1 行失败。');
  });
});
