import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { AppSettings } from '../../shared/types';
import { api } from './api';

const fallbackSettings: AppSettings = {
  mode: 'empty',
  role: 'admin',
  marketplace: 'US',
  currency: 'USD',
  timezone: 'Asia/Shanghai',
  defaultMarketId: '',
  aiModel: '未配置',
  refreshFrequency: 'manual',
  lastSuccessfulSync: null,
};

interface AppContextValue {
  settings: AppSettings;
  loading: boolean;
  error: Error | null;
  refreshKey: number;
  refreshAll: () => void;
  reloadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setDemoMode: (enabled: boolean) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: PropsWithChildren) {
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const reloadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.get<AppSettings>('/api/settings');
      setSettings(next);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError : new Error('无法读取系统设置'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadSettings();
  }, [reloadSettings]);

  const refreshAll = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await api.patch<AppSettings>('/api/settings', patch);
    setSettings(next);
    setError(null);
    setRefreshKey((value) => value + 1);
  }, []);

  const setDemoMode = useCallback(async (enabled: boolean) => {
    const next = await api.post<AppSettings>('/api/settings/demo', { enabled });
    setSettings(next);
    setError(null);
    setRefreshKey((value) => value + 1);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      settings,
      loading,
      error,
      refreshKey,
      refreshAll,
      reloadSettings,
      updateSettings,
      setDemoMode,
    }),
    [error, loading, refreshAll, refreshKey, reloadSettings, setDemoMode, settings, updateSettings],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// This module intentionally co-locates the provider and its hook as one public context API.
// eslint-disable-next-line react-refresh/only-export-components
export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp 必须在 AppProvider 内使用');
  return context;
}
