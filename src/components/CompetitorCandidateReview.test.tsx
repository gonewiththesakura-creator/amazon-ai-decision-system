// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompetitorCandidateReview from './CompetitorCandidateReview';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { get: getMock, post: postMock } }));

const candidate = {
  id: 'candidate-1', asin: 'B0PUBLIC02', status: 'pending_review', brand: 'Other',
  title: 'Foam pillow', price: 39, createdAt: '2026-09-19', reviewedAt: null,
};

beforeEach(() => {
  getMock.mockReset().mockResolvedValue([candidate]);
  postMock.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('CompetitorCandidateReview', () => {
  it('keeps discovered candidates pending until a human supplies a reason and confirms', async () => {
    const onConfirmed = vi.fn();
    render(<CompetitorCandidateReview productId="owned-1" isViewer={false} onConfirmed={onConfirmed} />);
    const confirm = await screen.findByRole('button', { name: '确认候选 B0PUBLIC02' });
    expect(confirm).toBeDisabled();
    expect(postMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /发现候选/ }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/owned-products/owned-1/competitor-candidates', { size: 20 },
    ));
    fireEvent.change(screen.getByRole('textbox', { name: 'B0PUBLIC02 纳入理由' }), {
      target: { value: '关键词、价格带与自有 SKU 匹配' },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/owned-products/owned-1/competitor-candidates/candidate-1/confirm',
      { relationType: 'direct', reason: '关键词、价格带与自有 SKU 匹配' },
    ));
    expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it('allows rejection but makes all mutations unavailable to a viewer', async () => {
    const { rerender } = render(<CompetitorCandidateReview productId="owned-1" isViewer={false} onConfirmed={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '拒绝候选 B0PUBLIC02' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/owned-products/owned-1/competitor-candidates/candidate-1/reject', {},
    ));
    rerender(<CompetitorCandidateReview productId="owned-1" isViewer onConfirmed={vi.fn()} />);
    expect(screen.getByRole('button', { name: '拒绝候选 B0PUBLIC02' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /发现候选/ })).toBeDisabled();
  });
});
