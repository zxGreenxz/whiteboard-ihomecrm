import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { docRegistry, quyenCuaRoute, superAdminGuardValid } from '../check-route-permission-drift.mjs';
const root = new URL('../../', import.meta.url);
const guard = readFileSync(new URL('src/components/auth/RequireSuperAdmin.tsx', root), 'utf8');
describe('system-only route gate rejects access mutations', () => {
  it('recognizes the live explicit system capability and strict guard', () => {
    const registry = readFileSync(new URL('src/app/capabilities/registry.ts', root), 'utf8');
    expect(docRegistry(registry).find(value => value.id === 'bank-events')).toMatchObject({ superAdminOnly: true, permissionNull: true });
    expect(superAdminGuardValid(guard)).toBe(true);
  });
  it.each(['AdminOnlyRoute', 'RequirePermission'])('rejects %s as the super admin route guard', name => {
    expect(quyenCuaRoute(`<Route path="/bien-dong-so-du" element={<ProtectedRoute><${name}><Page /></${name}></ProtectedRoute>} />`, '/bien-dong-so-du').loai).not.toBe('super-admin');
  });
  it('rejects broad admin hooks, owner sentinels and truthy decisions', () => {
    expect(superAdminGuardValid(guard.replace('useIsSuperAdmin()', 'useIsAdmin()'))).toBe(false);
    expect(superAdminGuardValid(guard.replace('permission.data !== true', '!permission.data'))).toBe(false);
    expect(superAdminGuardValid(guard.replace('permission.data !== true', 'permission.data !== true && !perms.__superadmin'))).toBe(false);
    expect(superAdminGuardValid(guard.replace('permission.isError', 'false'))).toBe(false);
  });
});
