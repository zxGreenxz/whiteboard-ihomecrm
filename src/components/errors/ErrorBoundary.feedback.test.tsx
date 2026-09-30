// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
vi.mock('@/lib/chunkReload', () => ({
  isChunkLoadError: (error: Error) => error.message.includes('Failed to fetch dynamically imported module'),
  reloadOnceForStaleChunk: () => false, hasAutoReloadBudget: () => false, isReloadPending: () => false,
}));
vi.mock('./boundaryReporter', () => ({ reportBoundaryError: vi.fn() }));
import ErrorBoundary from './ErrorBoundary';
function Broken({ message }: { message: string }): React.ReactNode { throw new Error(message); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('page failure feedback', () => {
  it('does not diagnose a new version from a failed chunk request', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary pageName="Hợp đồng"><Broken message="Failed to fetch dynamically imported module: /assets/chunk.js" /></ErrorBoundary>);
    expect(screen.getByRole('heading').textContent).toBe('Chưa tải được trang Hợp đồng.');
    expect(screen.queryByText(/Có phiên bản mới|vừa được cập nhật/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Tải lại' })).toBeTruthy();
  });
  it('keeps technical details in logs even on a development build', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'development');
    render(<ErrorBoundary pageName="Sổ quỹ"><Broken message="SQL SELECT secret FROM accounts" /></ErrorBoundary>);
    expect(screen.getByRole('heading').textContent).toBe('Chưa mở được trang Sổ quỹ.');
    expect(document.body.textContent).not.toContain('SELECT');
    vi.unstubAllEnvs();
  });
});
