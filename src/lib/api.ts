import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '../../shared/types';

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
};

function isApiResponse<T>(value: unknown): value is ApiResponse<T> {
  return Boolean(value && typeof value === 'object' && 'data' in value);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String(payload.error)
        : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, payload);
  }

  return isApiResponse<T>(payload) ? payload.data : (payload as T);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;

  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const response = await fetch(path, {
    ...options,
    headers,
    body,
  });

  return parseResponse<T>(response);
}

export const api = {
  get: <T,>(path: string, signal?: AbortSignal) => apiRequest<T>(path, { signal }),
  post: <T,>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T,>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T,>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
  upload: <T,>(path: string, formData: FormData) =>
    apiRequest<T>(path, { method: 'POST', body: formData }),
};

export type ImportDetectedType =
  | 'sellersprite_product'
  | 'sellersprite_market'
  | 'amazon_business_report'
  | 'owned_product_master'
  | 'unknown';

export interface ImportPreviewResult {
  token: string;
  detectedType: ImportDetectedType;
  entityType: string | null;
  totalCount: number;
  newCount: number;
  duplicateCount: number;
  errorCount: number;
  errors: string[];
  expiresAt: string;
}

export interface ConfirmedImportResult {
  batchId: string;
  entityType: string;
  rowCount: number;
  successCount: number;
  failureCount: number;
  errors: string[];
}

export function previewImport(file: File): Promise<ImportPreviewResult> {
  const format = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx';
  const formData = new FormData();
  formData.append('file', file);
  return api.upload<ImportPreviewResult>(`/api/import/preview/${format}`, formData);
}

export function confirmImport(token: string, entityType?: string): Promise<ConfirmedImportResult> {
  return api.post<ConfirmedImportResult>('/api/import/confirm', { token, entityType });
}

export interface ApiQuery<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
}

export function useApi<T>(path: string | null, refreshKey = 0): ApiQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const previousPath = useRef<string | null>(null);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useEffect(() => {
    if (!path) {
      previousPath.current = null;
      setLoading(false);
      setRefreshing(false);
      setData(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    const pathChanged = previousPath.current !== path;
    previousPath.current = path;
    setError(null);
    if (pathChanged) {
      setData(null);
      setLoading(true);
      setRefreshing(false);
    } else {
      setData((current) => {
        if (current === null) setLoading(true);
        else setRefreshing(true);
        return current;
      });
    }

    api.get<T>(path, controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(requestError instanceof Error ? requestError : new Error('未知请求错误'));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [path, refreshKey, reloadKey]);

  const pathMatchesData = previousPath.current === path;
  return {
    data: pathMatchesData ? data : null,
    error: pathMatchesData ? error : null,
    loading: pathMatchesData ? loading : Boolean(path),
    refreshing: pathMatchesData ? refreshing : false,
    reload,
  };
}
