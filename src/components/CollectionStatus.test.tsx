// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {it,expect,afterEach} from 'vitest';
import {CollectionStatus} from './CollectionStatus';
import type {AppSettings} from '../../shared/types';
afterEach(cleanup);
it.each(['FRESH','STALE','UNKNOWN'] as const)('retains successful real collection with %s operational status',connectionFreshness=>{
  render(<CollectionStatus settings={{lastSuccessfulSync:null,latestSuccessfulCritical:{runId:'golden',completedAt:'2026-09-27T09:49:32Z'},connectionFreshness} as AppSettings}/>);
  expect(screen.getByText(/2026.*9.*27/)).toBeInTheDocument();
  expect(screen.getByText(/当前连接状态/)).toHaveTextContent(connectionFreshness==='FRESH'?'Fresh':connectionFreshness==='STALE'?'Stale':'未复测');
  expect(screen.queryByText(/尚无成功|从未同步|尚未同步/)).not.toBeInTheDocument();
});
