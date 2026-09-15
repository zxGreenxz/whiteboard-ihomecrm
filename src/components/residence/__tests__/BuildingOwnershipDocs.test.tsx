// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  perms: { buildings: { edit: true } } as Record<string, Record<string, boolean>>,
  files: [] as unknown[],
  lastBuildingId: undefined as string | undefined,
}));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => ({ data: boundary.perms }) }));
vi.mock('@/lib/permissionPages', () => ({ canUse: (p: Record<string, Record<string, boolean>>, m: string, a: string) => !!p?.[m]?.[a] }));
vi.mock('@/hooks/useResidenceDossierFiles', () => ({
  useBuildingOwnershipFiles: (id?: string) => { boundary.lastBuildingId = id; return { data: boundary.files, isError: false }; },
  useDossierFileMutations: () => ({ upload: { mutateAsync: vi.fn() }, remove: { mutateAsync: vi.fn() } }),
}));
vi.mock('@/components/ui/storage-image', () => ({ StorageImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));
vi.mock('@/lib/storage', () => ({ getPublicUrl: (b: string, p: string) => `${b}/${p}` }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/authSession', () => ({ getSessionUser: vi.fn() }));

import BuildingOwnershipDocs from '../BuildingOwnershipDocs';

afterEach(cleanup);

describe('BuildingOwnershipDocs', () => {
  it('hiện nhãn giấy tờ chỗ ở hợp pháp và nút tải khi có quyền sửa toà', () => {
    render(<BuildingOwnershipDocs buildingId="b1" />);
    expect(screen.getByText(/Giấy tờ chứng minh chỗ ở hợp pháp/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /chụp ảnh/i })).toBeTruthy();
    expect(screen.getByText(/tải một lần/i)).toBeTruthy();
  });

  it('có quyền in hồ sơ nhưng không sửa toà thì chỉ xem', () => {
    boundary.perms = { buildings: { edit: false }, customers: { print: true } };
    render(<BuildingOwnershipDocs buildingId="b1" />);
    expect(screen.getByText(/Giấy tờ chứng minh chỗ ở hợp pháp/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /chụp ảnh/i })).toBeNull();
  });

  it('không có quyền nào thì không hiện khối và không gọi dữ liệu', () => {
    boundary.perms = { buildings: { edit: false }, customers: { print: false } };
    const { container } = render(<BuildingOwnershipDocs buildingId="b1" />);
    expect(container.textContent).toBe('');
    expect(boundary.lastBuildingId).toBeUndefined();
  });
});
