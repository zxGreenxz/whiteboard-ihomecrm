// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ALL_PAGES } from '@/lib/permissionPages';

const recovery = vi.hoisted(() => ({ budget: false, pending: false, reload: vi.fn(() => false), report: vi.fn() }));
vi.mock('@/lib/chunkReload', () => ({
  isChunkLoadError: (error: Error) => error.message.includes('Failed to fetch dynamically imported module'),
  reloadOnceForStaleChunk: recovery.reload,
  hasAutoReloadBudget: () => recovery.budget,
  isReloadPending: () => recovery.pending,
}));
vi.mock('./boundaryReporter', () => ({ reportBoundaryError: recovery.report }));
import ErrorBoundary from './ErrorBoundary';

function Broken({ message = 'render failed' }: { message?: string }): React.ReactNode { throw new Error(message); }

function canonicalPageName(path: string): string {
  return [...ALL_PAGES]
    .sort((a, b) => b.route.length - a.route.length)
    .find(page => path === page.route || (page.route !== '/' && path.startsWith(`${page.route}/`)))?.label ?? 'đang mở';
}

const routeCases = ALL_PAGES.flatMap(page => [
  { path: page.route, kind: 'route' },
  { path: `${page.route === '/' ? '' : page.route}/notification-feedback-child/nested`, kind: 'descendant' },
]);

let labelModuleMocked = false;
function mockLabelLoader(loader: () => Promise<{ errorPageName: (path: string) => string }>): void {
  vi.resetModules();
  vi.doMock('@/lib/errorPageNames', loader);
  labelModuleMocked = true;
}

function suppressExpectedRenderError(event: ErrorEvent): void { event.preventDefault(); }
beforeEach(() => {
  recovery.budget = false;
  recovery.pending = false;
  recovery.reload.mockClear();
  recovery.reload.mockReturnValue(false);
  recovery.report.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.addEventListener('error', suppressExpectedRenderError);
});
afterEach(() => {
  cleanup();
  if (labelModuleMocked) {
    vi.doUnmock('@/lib/errorPageNames');
    vi.resetModules();
    labelModuleMocked = false;
  }
  vi.restoreAllMocks();
  window.removeEventListener('error', suppressExpectedRenderError);
  window.history.replaceState({}, '', '/');
});

describe('lightweight page names for boot error feedback', () => {
  it('does not import the permission catalog at the boot boundary', () => {
    const source = ts.createSourceFile('ErrorBoundary.tsx', readFileSync('src/components/errors/ErrorBoundary.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map(statement => ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '');
    expect(imports).not.toContain('@/lib/permissionPages');
    expect(imports).not.toContain('@/lib/permissions');
    expect(imports).not.toContain('@/lib/errorPageNames');
  });

  it.each(routeCases)('preserves the canonical label for $kind $path', async ({ path }) => {
    window.history.replaceState({}, '', path);
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(await screen.findByRole('heading', { name: `Chưa mở được trang ${canonicalPageName(path)}.` })).toBeTruthy();
  });

  it.each(['/unknown-notification-page', '/contracts-other', ''])('keeps the unknown route fallback for %s', async path => {
    window.history.replaceState({}, '', path || '/unknown-empty-path');
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(await screen.findByRole('heading', { name: 'Chưa mở được trang đang mở.' })).toBeTruthy();
  });

  it('keeps an explicit pageName ahead of a known route', () => {
    window.history.replaceState({}, '', '/contracts/123');
    render(<ErrorBoundary pageName="Chi tiết hợp đồng"><Broken /></ErrorBoundary>);
    expect(screen.getByRole('heading').textContent).toBe('Chưa mở được trang Chi tiết hợp đồng.');
  });

  it('keeps an explicitly empty pageName instead of resolving the route', () => {
    window.history.replaceState({}, '', '/contracts');
    render(<ErrorBoundary pageName=""><Broken /></ErrorBoundary>);
    expect(screen.getByRole('heading').textContent).toBe('Chưa mở được trang .');
  });

  it('keeps safe feedback and reload available while the label module is still loading', async () => {
    let resolveLabel!: (module: { errorPageName: (path: string) => string }) => void;
    const module = new Promise<{ errorPageName: (path: string) => string }>(resolve => { resolveLabel = resolve; });
    mockLabelLoader(() => module);
    window.history.replaceState({}, '', '/contracts/123');
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByRole('heading').textContent).toBe('Chưa mở được trang đang mở.');
    expect(screen.getByRole('button', { name: 'Tải lại' })).toBeTruthy();
    resolveLabel({ errorPageName: canonicalPageName });
    expect(await screen.findByRole('heading', { name: 'Chưa mở được trang Hợp đồng.' })).toBeTruthy();
  });

  it('keeps generic safe feedback and reload when the label import rejects', async () => {
    const load = vi.fn(async () => { throw new TypeError('Failed to fetch private label chunk /SQL/secret'); });
    mockLabelLoader(load);
    window.history.replaceState({}, '', '/contracts');
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByRole('heading').textContent).toBe('Chưa mở được trang đang mở.');
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Tải lại' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('SQL');
    expect(recovery.report).toHaveBeenCalledOnce();
  });

  it('does not load page labels for healthy children', async () => {
    const load = vi.fn(async () => ({ errorPageName: canonicalPageName }));
    mockLabelLoader(load);
    render(<ErrorBoundary><p>Trang đang hoạt động</p></ErrorBoundary>);
    expect(screen.getByText('Trang đang hoạt động')).toBeTruthy();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps the custom fallback and skips page label loading', async () => {
    const load = vi.fn(async () => ({ errorPageName: canonicalPageName }));
    mockLabelLoader(load);
    render(<ErrorBoundary fallback={<p>Phản hồi riêng</p>}><Broken /></ErrorBoundary>);
    expect(screen.getByText('Phản hồi riêng')).toBeTruthy();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    expect(recovery.report).toHaveBeenCalledOnce();
  });

  it('resolves labels for a chunk error after its reload budget is exhausted', async () => {
    window.history.replaceState({}, '', '/contracts');
    render(<ErrorBoundary><Broken message="Failed to fetch dynamically imported module: /assets/route.js" /></ErrorBoundary>);
    expect(await screen.findByRole('heading', { name: 'Chưa tải được trang Hợp đồng.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tải lại' })).toBeTruthy();
    expect(recovery.reload).toHaveBeenCalledOnce();
    expect(recovery.report).toHaveBeenCalledOnce();
  });

  it('keeps automatic recovery and reporting ahead of page name loading', async () => {
    const load = vi.fn(async () => ({ errorPageName: canonicalPageName }));
    mockLabelLoader(load);
    recovery.budget = true;
    recovery.reload.mockReturnValue(true);
    render(<ErrorBoundary><Broken message="Failed to fetch dynamically imported module: /assets/route.js" /></ErrorBoundary>);
    expect(screen.getByText('Đang tải…')).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(recovery.report).toHaveBeenCalledOnce();
    expect(recovery.reload).toHaveBeenCalledOnce();
    expect(recovery.report.mock.invocationCallOrder[0]).toBeLessThan(recovery.reload.mock.invocationCallOrder[0]!);
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
  });
});
