// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from './Onboarding';

vi.mock('../lib/AppContext', () => ({
  useApp: () => ({ settings: { marketplace: 'US' }, setDemoMode: vi.fn() }),
}));

afterEach(cleanup);

describe('Onboarding', () => {
  it('routes a file import to the review-first Import Center without uploading it', () => {
    const router = createMemoryRouter([
      { path: '/', element: <Onboarding /> },
      { path: '/data-tasks', element: <div>审核文件导入</div> },
    ], { initialEntries: ['/'] });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole('button', { name: /导入 CSV \/ XLSX/ }));
    expect(router.state.location).toMatchObject({ pathname: '/data-tasks', hash: '#import-center-title' });
    expect(screen.getByText('审核文件导入')).toBeInTheDocument();
    expect(screen.queryByLabelText('导入文件来源')).not.toBeInTheDocument();
  });
});
