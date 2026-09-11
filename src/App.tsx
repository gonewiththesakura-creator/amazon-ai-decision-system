import { lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const MarketPage = lazy(() => import('./pages/MarketPage'));
const OwnedProductsPage = lazy(() => import('./pages/OwnedProductsPage'));
const DevelopmentPage = lazy(() => import('./pages/DevelopmentPage'));
const OpportunityLabPage = lazy(() => import('./pages/OpportunityLabPage'));
const OpportunitiesPage = lazy(() => import('./pages/OpportunitiesPage'));
const MonitoringPage = lazy(() => import('./pages/MonitoringPage'));
const DataTasksPage = lazy(() => import('./pages/DataTasksPage'));
const ResearchJobsPage = lazy(() => import('./pages/ResearchJobsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="market" element={<MarketPage />} />
          <Route path="owned-products" element={<OwnedProductsPage />} />
          <Route path="owned-products/:productId" element={<OwnedProductsPage />} />
          <Route path="development" element={<DevelopmentPage />} />
          <Route path="opportunity-lab" element={<OpportunityLabPage />} />
          <Route path="opportunities" element={<OpportunitiesPage />} />
          <Route path="monitoring" element={<MonitoringPage />} />
          <Route path="data-tasks" element={<DataTasksPage />} />
          <Route path="research-jobs" element={<ResearchJobsPage />} />
          <Route path="research-jobs/:jobId" element={<ResearchJobsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
