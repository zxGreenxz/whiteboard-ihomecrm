// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireSuperAdmin } from '../RequireSuperAdmin';
import { canShowSurface } from '@/lib/superAdminSurface';
import type { PermsLike } from '@/lib/permissionPages';
import { navFieldsFor, launcherFieldsFor } from '@/app/capabilities/surfaceAdapters';

const query = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false, isPending: false, isError: false, refetch: vi.fn() }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsSuperAdmin: () => query }));
beforeEach(() => { Object.assign(query, { data: undefined, isLoading: false, isPending: false, isError: false }); query.refetch.mockReset(); });
afterEach(cleanup);
const mount = () => render(<MemoryRouter initialEntries={['/bien-dong-so-du']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Routes><Route path="/bien-dong-so-du" element={<RequireSuperAdmin><p>Nội dung nguyên văn</p></RequireSuperAdmin>} /><Route path="/" element={<p>Trang chủ</p>} /></Routes></MemoryRouter>);
describe('super admin route and entry points', () => {
  it.each([false, undefined, null, 1, 'true', { __superadmin: true }])('denies every non-true tier response: %j', value => { query.data = value; mount(); expect(screen.queryByText('Nội dung nguyên văn')).toBeNull(); expect(screen.getByText('Trang chủ')).toBeTruthy(); });
  it('renders only confirmed boolean true', () => { query.data = true; mount(); expect(screen.getByText('Nội dung nguyên văn')).toBeTruthy(); });
  it('does not disclose cached data on permission errors; offers retry', () => { query.data = true; query.isError = true; mount(); expect(screen.queryByText('Nội dung nguyên văn')).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Thử lại' })); expect(query.refetch).toHaveBeenCalledOnce(); });
  it('does not render while permission is pending', () => { query.data = true; query.isPending = true; mount(); expect(screen.queryByText('Nội dung nguyên văn')).toBeNull(); });
  it('hides both entry points from organization owners and Admin sentinels', () => {
    const ownerPermissions: PermsLike = {};
    ownerPermissions.__superadmin = true;
    const entries = [...navFieldsFor('bank-events'), ...launcherFieldsFor('bank-events')];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.superAdminOnly).toBe(true);
      expect(canShowSurface(entry, ownerPermissions, false)).toBe(false);
      expect(canShowSurface(entry, { users: { view: true } }, false)).toBe(false);
      expect(canShowSurface(entry, ownerPermissions, undefined)).toBe(false);
      expect(canShowSurface(entry, null, true)).toBe(true);
    }
  });
});
