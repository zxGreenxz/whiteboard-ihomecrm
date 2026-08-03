import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useOpenClawBootstrap } from "@/hooks/openclaw-zalo/useOpenClawBootstrap";
import { useOpenClawOrganization } from "@/hooks/openclaw-zalo/useOpenClawOrganization";
import { openClawQueryKeys } from "@/hooks/openclaw-zalo/queryKeys";
// Single source of truth for the action list; a local copy drifts from the hook
// the rest of the product reads, and the two already disagreed on key shape.
import { OPENCLAW_PERMISSION_ACTIONS } from "@/hooks/openclaw-zalo/useOpenClawPermissions";
import type {
  OpenClawBootstrap,
  OpenClawOrganization,
  OpenClawPermissionAction,
  OpenClawPermissionSnapshot,
} from "@/lib/openclaw-zalo/types";
import OpenClawBoundaryState from "./OpenClawBoundaryState";

/**
 * PASSTHROUGH on purpose, and it must stay that way.
 *
 * `get_authorization_context_v1` is a shared platform RPC this feature does not
 * own; its authenticated branch returns ten fields (membershipId, memberType,
 * authorizationVersion, isPlatformAdmin, isOffboarded, organizations, scopeSets,
 * scopes, …) and its empty-package branch adds nearestDeadline, of which the guard
 * reads exactly two. Making this `.strict()` took
 * the WHOLE route down for every user - the parse threw `unrecognized_keys`, the
 * query errored, and since a ZodError carries no `.code` the 42501 branch never
 * matched, so everyone landed on the fatal "cannot verify permission" screen.
 *
 * Strictness belongs on contracts this feature owns, where an unexpected key
 * really is a contract change. On a platform RPC whose shape is set elsewhere it
 * only means the next field someone adds upstream breaks OpenClaw.
 */
export const authorizationSchema = z.object({
  organizationId: z.string().uuid().nullable(),
  permissions: z.record(z.string(), z.boolean()),
}).passthrough();

const OPENCLAW_VIEW_PERMISSION = "openclaw_zalo.view";

function isPermissionDenied(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "42501");
}

interface OpenClawRouteContextValue {
  organizations: readonly OpenClawOrganization[];
  organization: OpenClawOrganization;
  selectedOrganizationId: string;
  selectOrganization: (organizationId: string) => void;
  bootstrap: OpenClawBootstrap;
  permissions: OpenClawPermissionSnapshot;
  can: (action: OpenClawPermissionAction) => boolean;
}

const OpenClawRouteContext = createContext<OpenClawRouteContextValue | null>(null);

// The guard owns this route-scoped context; the cockpit is its only consumer.
// eslint-disable-next-line react-refresh/only-export-components
export function useOpenClawRouteContext() {
  const context = useContext(OpenClawRouteContext);
  if (!context) throw new Error("useOpenClawRouteContext must be used inside OpenClawRouteGuard");
  return context;
}

interface OpenClawRouteGuardProps {
  children: ReactNode;
}

export default function OpenClawRouteGuard({ children }: OpenClawRouteGuardProps) {
  const organizationQuery = useOpenClawOrganization();
  const selectedOrganizationId = organizationQuery.selectedOrganizationId;
  const bootstrapQuery = useOpenClawBootstrap(selectedOrganizationId);
  const authorizationQuery = useQuery({
    queryKey: [
      ...openClawQueryKeys.scope(selectedOrganizationId, null),
      "authorization",
    ],
    enabled: Boolean(selectedOrganizationId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_authorization_context_v1", {
        p_organization_id: selectedOrganizationId!,
      });
      if (error) throw error;
      const authorization = authorizationSchema.parse(data);
      if (authorization.organizationId !== selectedOrganizationId) {
        return { organizationId: null, permissions: {} as Record<string, boolean> };
      }
      return authorization;
    },
  });

  const permissionSnapshot = useMemo<OpenClawPermissionSnapshot | null>(() => {
    if (!selectedOrganizationId || !authorizationQuery.data) return null;
    const actions = Object.fromEntries(OPENCLAW_PERMISSION_ACTIONS.map(action => [
      action,
      authorizationQuery.data.permissions[
        action === "view" ? OPENCLAW_VIEW_PERMISSION : `openclaw_zalo.${action}`
      ] === true,
    ])) as Record<OpenClawPermissionAction, boolean>;
    return { organizationId: selectedOrganizationId, actions };
  }, [authorizationQuery.data, selectedOrganizationId]);

  if (organizationQuery.isLoading) {
    return <OpenClawBoundaryState state="loading" />;
  }

  if (organizationQuery.error) {
    return (
      <div className="min-h-screen bg-[#f7f2e8] px-4 py-12">
        <OpenClawBoundaryState
          state="fatal-error"
          message="Không thể tải danh sách tổ chức của bạn."
          actionLabel="Thử lại"
          onAction={() => void organizationQuery.refetch()}
        />
      </div>
    );
  }

  if (organizationQuery.organizations.length === 0) {
    return (
      <div className="min-h-screen bg-[#f7f2e8] px-4 py-12">
        <OpenClawBoundaryState state="no-permission" message="Tài khoản chưa thuộc tổ chức đang hoạt động nào." />
      </div>
    );
  }

  if (organizationQuery.needsSelection || !selectedOrganizationId) {
    return (
      <main className="min-h-screen bg-[#f7f2e8] px-4 py-12 text-[#102a43]">
        <section className="mx-auto w-full max-w-xl border border-[#aebdc8] bg-[#fffdf8] p-6">
          <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-[#0f766e]">OpenClaw Zalo</p>
          <h1 className="mt-2 text-2xl font-black tracking-[-0.03em]">Chọn tổ chức để tiếp tục</h1>
          <p className="mt-2 text-sm leading-6 text-[#526777]">
            Quyền và dữ liệu được kiểm tra lại theo đúng tổ chức bạn chọn. Trình duyệt chỉ lưu organization ID trong URL.
          </p>
          <div className="mt-6 grid gap-2">
            {organizationQuery.organizations.map(organization => (
              <button
                key={organization.organizationId}
                type="button"
                onClick={() => organizationQuery.selectOrganization(organization.organizationId)}
                className="flex min-h-11 items-center justify-between border border-[#9fb0bf] bg-white px-4 text-left text-sm font-bold hover:border-[#0f766e] hover:bg-[#edf4f2]"
              >
                <span>{organization.name}</span>
                <span aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        </section>
      </main>
    );
  }

  if (authorizationQuery.isLoading || bootstrapQuery.isLoading) {
    return <OpenClawBoundaryState state="loading" />;
  }

  if (isPermissionDenied(authorizationQuery.error) || isPermissionDenied(bootstrapQuery.error)) {
    return <Navigate to="/" replace />;
  }

  if (authorizationQuery.error) {
    return (
      <div className="min-h-screen bg-[#f7f2e8] px-4 py-12">
        <OpenClawBoundaryState
          state="fatal-error"
          message="Không thể xác minh quyền OpenClaw Zalo cho tổ chức đã chọn."
          actionLabel="Thử lại"
          onAction={() => void authorizationQuery.refetch()}
        />
      </div>
    );
  }

  if (!permissionSnapshot?.actions.view) {
    return <Navigate to="/" replace />;
  }

  if (bootstrapQuery.error || !bootstrapQuery.data) {
    return (
      <div className="min-h-screen bg-[#f7f2e8] px-4 py-12">
        <OpenClawBoundaryState
          state="fatal-error"
          message="Quyền đã được xác nhận nhưng bootstrap OpenClaw Zalo chưa tải được."
          actionLabel="Thử lại"
          onAction={() => void Promise.all([authorizationQuery.refetch(), bootstrapQuery.refetch()])}
        />
      </div>
    );
  }

  const organization = organizationQuery.selectedOrganization;
  if (!organization) return <Navigate to="/" replace />;

  const value: OpenClawRouteContextValue = {
    organizations: organizationQuery.organizations,
    organization,
    selectedOrganizationId,
    selectOrganization: organizationQuery.selectOrganization,
    bootstrap: bootstrapQuery.data,
    permissions: permissionSnapshot,
    can: action => permissionSnapshot.actions[action] === true,
  };

  return <OpenClawRouteContext.Provider value={value}>{children}</OpenClawRouteContext.Provider>;
}
