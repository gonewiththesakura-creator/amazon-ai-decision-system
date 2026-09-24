// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import McpQuotaControls from './McpQuotaControls';
import {api} from '../lib/api';

vi.mock('../lib/api',()=>({api:{get:vi.fn(),post:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('previews without syncing and binds explicit confirmation to a one-use plan', async()=>{
  vi.mocked(api.get).mockResolvedValue({estimatedRemaining:500,reserve:100,status:'NORMAL',
    todayRemoteCalls:0,weekRemoteCalls:0,localHitRate:null,cacheHitRate:null,remoteCallRate:null,circuit:'CLOSED',policy:{}});
  vi.mocked(api.post).mockResolvedValue({id:'plan-test',estimatedRemoteCalls:23,maximumRemoteCalls:48,
    localReuse:0,projectedRemaining:477,blockers:[],entries:[]});
  render(<McpQuotaControls marketId="market-1" month="202609" isViewer={false} onComplete={async()=>{}}/>);
  await screen.findByText(/本地估算剩余/);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox'),{target:{value:'certification'}});
  fireEvent.click(screen.getByRole('button',{name:'预览调用计划'}));
  await screen.findByText(/预计远端/);
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button',{name:'确认执行'})).toBeDisabled();
  fireEvent.click(screen.getByLabelText('已审阅调用范围与额度，同意执行'));
  fireEvent.click(screen.getByRole('button',{name:'确认执行'}));
  await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/api/integrations/sellersprite/sync/critical',{
    marketId:'market-1',month:'202609',syncMode:'certification',planId:'plan-test',confirmed:true,
  }));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'确认执行'})).not.toBeInTheDocument());
});
