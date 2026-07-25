// Tầng dữ liệu cho 4 màn quản trị phân quyền (Tổ chức / Thành viên / Mẫu vai
// trò / hộp thoại phân quyền).
//
// MỌI truy vấn đều qua RPC, KHÔNG select thẳng bảng: 13 bảng của mô hình phân
// quyền chỉ có policy SELECT cho is_super_admin(), nên chủ sở hữu tổ chức đọc
// thẳng sẽ ra 0 dòng. Các RPC dưới đây là SECURITY DEFINER và tự kiểm users.view
// trong đúng tổ chức của người gọi.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

/* ────────────────────────────── Kiểu dữ liệu ───────────────────────────── */

export type MemberType = 'OWNER' | 'STAFF' | 'SHAREHOLDER' | 'PARTNER' | 'SERVICE';
export type MemberStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type ScopeType = 'ORGANIZATION' | 'AREA' | 'BUILDING' | 'CASHBOOK';
export type Effect = 'ALLOW' | 'DENY';
export type ScopeMode = 'ORGANIZATION' | 'SCOPED';

export interface ScopeRef {
  scopeId: string;
  scopeType: ScopeType;
  label: string;
}

export interface MemberRoleSummary {
  bindingId: string;
  roleId: string;
  roleName: string;
  isSystem: boolean;
  scopes: ScopeRef[];
}

export interface OrganizationMember {
  membershipId: string;
  userId: string;
  email: string | null;
  fullName: string | null;
  memberType: MemberType;
  status: MemberStatus;
  version: number;
  isSelf: boolean;
  roles: MemberRoleSummary[];
  overrideAllow: number;
  overrideDeny: number;
  cashbooksHeld: number;
  permissionCount: number;
}

export interface MemberRoleBinding {
  bindingId: string;
  roleId: string;
  roleName: string;
  scopeIds: string[];
}

export interface MemberOverride {
  overrideId: string;
  permissionKey: string;
  effect: Effect;
  scopeMode: ScopeMode;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
  scopeIds: string[];
}

export interface MemberAuthorization {
  membershipId: string;
  userId: string;
  email: string | null;
  fullName: string | null;
  memberType: MemberType;
  status: MemberStatus;
  /** Khoá chống ghi chen — phải gửi lại nguyên vẹn khi lưu. */
  version: number;
  isSelf: boolean;
  roleBindings: MemberRoleBinding[];
  overrides: MemberOverride[];
  cashbooksHeld: { cashbookId: string; name: string | null; kind: string }[];
  effectiveKeys: string[];
}

export interface OrganizationRole {
  roleId: string;
  name: string;
  isSystem: boolean;
  status: string;
  version: number;
  memberCount: number;
  allowKeys: string[];
  denyKeys: string[];
}

export interface AuthorizationScope {
  scopeId: string;
  scopeType: ScopeType;
  label: string;
  buildingId: string | null;
  areaId: string | null;
  cashbookId: string | null;
}

export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  sensitivity: string | null;
  scopeKinds: ScopeType[];
  requiredDimensions: string[];
  requiresCashbookPossession: boolean;
}

export interface AuthorizationCatalog {
  scopes: AuthorizationScope[];
  permissions: PermissionDefinition[];
}

export interface OrganizationInvitation {
  invitationId: string;
  email: string;
  memberType: MemberType;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expiresAt: string;
  createdAt: string;
  roleName: string | null;
  isExpired: boolean;
}

export interface AuthorizationAuditEvent {
  eventId: string;
  occurredAt: string;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  reason: string | null;
  actorEmail: string | null;
  actorName: string | null;
  newState: Record<string, unknown> | null;
}

export interface OrganizationProfile {
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  isDemo: boolean;
  createdAt: string;
  authorizationVersion: number;
  canEdit: boolean;
  counts: {
    members: number;
    owners: number;
    roles: number;
    buildings: number;
    areas: number;
    cashbooks: number;
    pendingInvitations: number;
    activeOverrides: number;
  };
  invitations: OrganizationInvitation[];
  auditTrail: AuthorizationAuditEvent[];
}

/* ─────────────────────────────── Khoá cache ─────────────────────────────── */

export const authzKeys = {
  members: ['authz', 'members'] as const,
  member: (id: string) => ['authz', 'member', id] as const,
  roles: ['authz', 'roles'] as const,
  catalog: ['authz', 'catalog'] as const,
  organization: ['authz', 'organization'] as const,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (name: string, args?: Record<string, unknown>) => (supabase as any).rpc(name, args);

async function callRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(name, args);
  if (error) throw error;
  return data as T;
}

/* ────────────────────────────────  Đọc  ─────────────────────────────────── */

export const useOrganizationMembers = (enabled = true) =>
  useQuery({
    queryKey: authzKeys.members,
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const d = await callRpc<{ organizationId: string; members: OrganizationMember[] }>(
        'list_organization_members_v1',
      );
      return d ?? { organizationId: '', members: [] };
    },
  });

export const useMemberAuthorization = (membershipId: string | null) =>
  useQuery({
    queryKey: authzKeys.member(membershipId ?? '∅'),
    enabled: !!membershipId,
    // Không cache: `version` là khoá chống ghi chen, đọc lại số cũ sẽ khiến
    // người dùng ăn lỗi 40001 dù không ai sửa gì.
    staleTime: 0,
    gcTime: 0,
    queryFn: () =>
      callRpc<MemberAuthorization>('get_member_authorization_v1', { p_membership: membershipId }),
  });

export const useOrganizationRoles = (enabled = true) =>
  useQuery({
    queryKey: authzKeys.roles,
    enabled,
    staleTime: 30_000,
    queryFn: async () => (await callRpc<OrganizationRole[]>('list_organization_roles_v1')) ?? [],
  });

export const useAuthorizationCatalog = (enabled = true) =>
  useQuery({
    queryKey: authzKeys.catalog,
    enabled,
    // Danh mục quyền + phạm vi gần như tĩnh; ~55 kB nên đừng tải lại liên tục.
    staleTime: 10 * 60_000,
    queryFn: async () =>
      (await callRpc<AuthorizationCatalog>('list_authorization_catalog_v1')) ?? {
        scopes: [],
        permissions: [],
      },
  });

export const useOrganizationProfile = (enabled = true) =>
  useQuery({
    queryKey: authzKeys.organization,
    enabled,
    staleTime: 30_000,
    queryFn: () => callRpc<OrganizationProfile>('get_organization_profile_v1'),
  });

/* ────────────────────────────────  Ghi  ─────────────────────────────────── */

/** Thông điệp lỗi thân thiện: RPC đã viết tiếng Việt sẵn, chỉ cần lấy ra. */
const loi = (e: unknown, macDinh: string) => {
  const m = (e as { message?: string })?.message;
  return m && !/^(permission denied|JSON object)/i.test(m) ? m : macDinh;
};

export interface SaveRoleBinding {
  role_id: string;
  scope_ids: string[];
}
export interface SaveOverride {
  permission_key: string;
  effect: Effect;
  scope_mode: ScopeMode;
  scope_ids: string[];
  reason: string;
  expires_at?: string | null;
}
export interface SaveMemberResult {
  membershipId: string;
  version: number;
  roleBindings: number;
  overrides: number;
  permissionsBefore: number;
  permissionsAfter: number;
  gained: string[];
  lost: string[];
}

/**
 * Lưu phân quyền của một thành viên.
 *
 * Ngữ nghĩa THAY THẾ: gửi lên trạng thái ĐÍCH, máy chủ tự đóng cái không còn.
 * `undefined` = không đụng lớp đó; `[]` = gỡ sạch lớp đó.
 */
export const useSaveMemberAuthorization = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      membershipId: string;
      expectedVersion: number;
      roleBindings?: SaveRoleBinding[];
      overrides?: SaveOverride[];
      reason: string;
    }) =>
      callRpc<SaveMemberResult>('update_member_authorization_v1', {
        p_membership: v.membershipId,
        p_expected_version: v.expectedVersion,
        p_role_bindings: v.roleBindings ?? null,
        p_overrides: v.overrides ?? null,
        p_reason: v.reason,
      }),
    onSuccess: (r, v) => {
      qc.invalidateQueries({ queryKey: authzKeys.members });
      qc.invalidateQueries({ queryKey: authzKeys.member(v.membershipId) });
      qc.invalidateQueries({ queryKey: authzKeys.organization });
      // Nếu vừa sửa quyền của chính mình ở tab khác thì làm mới luôn quyền UI.
      qc.invalidateQueries({ queryKey: ['my-permissions'] });
      const { gained = [], lost = [] } = r ?? {};
      toast.success(
        `Đã lưu phân quyền · ${r?.permissionsAfter ?? 0} quyền` +
          (gained.length ? ` · +${gained.length}` : '') +
          (lost.length ? ` · −${lost.length}` : ''),
      );
    },
    onError: (e) => toast.error(loi(e, 'Không lưu được phân quyền.')),
  });
};

export const useUpsertOrganizationRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      roleId?: string | null;
      name?: string;
      permissions?: { permission_key: string; effect: Effect }[];
      expectedVersion?: number | null;
      reason?: string;
    }) =>
      callRpc<{ roleId: string; created: boolean; version: number; affectedMembers: number }>(
        'upsert_organization_role_v1',
        {
          p_role_id: v.roleId ?? null,
          p_name: v.name ?? null,
          p_permissions: v.permissions ?? null,
          p_expected_version: v.expectedVersion ?? null,
          p_reason: v.reason ?? null,
        },
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: authzKeys.roles });
      qc.invalidateQueries({ queryKey: authzKeys.members });
      qc.invalidateQueries({ queryKey: authzKeys.organization });
      qc.invalidateQueries({ queryKey: ['my-permissions'] });
      toast.success(
        r?.created
          ? 'Đã tạo vai trò mới.'
          : `Đã lưu vai trò${r?.affectedMembers ? ` · ảnh hưởng ${r.affectedMembers} người` : ''}.`,
      );
    },
    onError: (e) => toast.error(loi(e, 'Không lưu được vai trò.')),
  });
};

export const useInviteMember = () =>
  useMutation({
    mutationFn: (v: {
      email: string;
      memberType: MemberType;
      roleId?: string | null;
      scopeIds?: string[];
      expiresDays?: number;
    }) =>
      callRpc<{ invitationId: string; token: string; expiresAt: string; note: string }>(
        'invite_organization_member_v1',
        {
          p_email: v.email,
          p_member_type: v.memberType,
          p_role_id: v.roleId ?? null,
          p_scope_ids: v.scopeIds?.length ? v.scopeIds : null,
          p_expires_days: v.expiresDays ?? 7,
        },
      ),
    onError: (e) => toast.error(loi(e, 'Không gửi được lời mời.')),
  });

export const useRevokeInvitation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      callRpc('revoke_organization_invitation_v1', { p_invitation: invitationId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: authzKeys.organization });
      toast.success('Đã thu hồi lời mời.');
    },
    onError: (e) => toast.error(loi(e, 'Không thu hồi được lời mời.')),
  });
};

export const useUpdateOrganizationProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      callRpc<{ name: string }>('update_organization_profile_v1', { p_name: name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: authzKeys.organization });
      toast.success('Đã lưu thông tin tổ chức.');
    },
    onError: (e) => toast.error(loi(e, 'Không lưu được thông tin tổ chức.')),
  });
};
