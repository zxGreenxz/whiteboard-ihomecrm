import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type CopilotFlagState = 'disabled' | 'shadow' | 'enabled';

export const COPILOT_ROLLOUT_CONTRACTS = [
  { scope: 'page' as const, contractId: 'rooms.list', label: 'Danh sách phòng' },
  { scope: 'page' as const, contractId: 'customers.list', label: 'Danh sách khách hàng' },
  { scope: 'page' as const, contractId: 'invoices.list', label: 'Danh sách hóa đơn' },
];

export interface CopilotRolloutRow {
  scope: 'page' | 'action';
  contractId: string;
  label: string;
  state: CopilotFlagState;
  revision: number;
}

export function copilotRolloutTransitions(state: CopilotFlagState): CopilotFlagState[] {
  if (state === 'disabled') return ['shadow'];
  if (state === 'shadow') return ['enabled', 'disabled'];
  return ['shadow', 'disabled'];
}

export function formatCopilotRolloutError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('copilot_rollout_stale_revision')) {
    return 'Rollout đã thay đổi bởi phiên khác; hãy tải lại snapshot rồi thử lại.';
  }
  if (message.includes('rollout_evidence_required')) {
    return 'Cần nhập đầy đủ lý do, liên kết bằng chứng và tham chiếu rollback.';
  }
  if (message.includes('invalid_rollout_transition')) {
    return 'Chuyển trạng thái rollout không hợp lệ theo quy trình.';
  }
  if (message.includes('not_permitted')) return 'Bạn không có quyền thay đổi rollout Copilot.';
  return `Không thể thay đổi rollout: ${message}`;
}

export interface CopilotAvailabilitySnapshot {
  revision: number;
  fetchedAt: number;
  states: Record<string, CopilotFlagState>;
  /** The server-bound organization this snapshot authorizes. */
  organizationId: string;
  digest?: string;
}

export function rolloutRowsFromAvailability(
  snapshot: CopilotAvailabilitySnapshot | null | undefined,
): CopilotRolloutRow[] {
  return COPILOT_ROLLOUT_CONTRACTS.map((contract) => ({
    ...contract,
    state: copilotAvailability(snapshot, contract.contractId),
    revision: snapshot?.revision ?? 0,
  }));
}

type AvailabilityRpc = (organizationId: string) => PromiseLike<{ data: unknown; error: unknown }>;
type SupabaseAvailabilityRpc = (
  name: 'get_my_copilot_availability_v1',
  args: { p_organization_id: string },
) => PromiseLike<{ data: unknown; error: unknown }>;

// The migration is newer than the checked-in generated catalog. Keep the gap
// isolated to this exact RPC until production types can be captured safely.
const callAvailabilityRpc: AvailabilityRpc = (organizationId) =>
  (supabase.rpc as unknown as SupabaseAvailabilityRpc)(
    'get_my_copilot_availability_v1',
    { p_organization_id: organizationId },
  );

function unavailableCopilotSnapshot(): CopilotAvailabilitySnapshot | null {
  // A missing snapshot is an explicit deny decision, not an empty successful result.
  return null;
}

export interface SetCopilotRolloutInput {
  scope: 'page' | 'action';
  contractId: string;
  state: CopilotFlagState;
  expectedRevision: number;
  canaryOrg?: string | null;
  reason: string;
  evidenceLink: string;
  expiresAt?: string | null;
  rollbackReference: string;
}

export async function setCopilotFeatureFlagV2(input: SetCopilotRolloutInput): Promise<unknown> {
  const { data, error } = await supabase.rpc('set_copilot_feature_flag_v2', {
    p_scope: input.scope,
    p_contract_id: input.contractId,
    p_state: input.state,
    p_expected_revision: input.expectedRevision,
    ...(typeof input.canaryOrg === 'string' ? { p_canary_org: input.canaryOrg } : {}),
    p_reason: input.reason,
    p_evidence_link: input.evidenceLink,
    ...(typeof input.expiresAt === 'string' ? { p_expires_at: input.expiresAt } : {}),
    p_rollback_reference: input.rollbackReference,
  });
  if (error) throw error;
  return data;
}

/** Parse the server-owned availability payload; malformed or empty payloads are denied. */
export function parseCopilotAvailability(value: unknown): CopilotAvailabilitySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as {
    revision?: unknown;
    fetchedAt?: unknown;
    fetched_at?: unknown;
    states?: unknown;
    organizationId?: unknown;
    organization_id?: unknown;
    digest?: unknown;
  };
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) <= 0) return null;
  const rawFetchedAt = input.fetchedAt ?? input.fetched_at;
  const fetchedAt =
    typeof rawFetchedAt === 'number'
      ? rawFetchedAt < 1_000_000_000_000
        ? rawFetchedAt * 1000
        : rawFetchedAt
      : typeof rawFetchedAt === 'string'
        ? Number.isFinite(Number(rawFetchedAt))
          ? Number(rawFetchedAt) < 1_000_000_000_000
            ? Number(rawFetchedAt) * 1000
            : Number(rawFetchedAt)
          : Date.parse(rawFetchedAt)
        : Number.NaN;
  if (!Number.isFinite(fetchedAt) || fetchedAt < 0) return null;
  if (!input.states || typeof input.states !== 'object' || Array.isArray(input.states)) return null;
  const states: Record<string, CopilotFlagState> = {};
  for (const [key, state] of Object.entries(input.states as Record<string, unknown>)) {
    // Server keys include their scope so page and action contracts cannot collide.
    if (!/^(?:page|action):.+$/.test(key)) return null;
    if (state !== 'enabled' && state !== 'shadow' && state !== 'disabled') return null;
    states[key] = state;
  }
  const rawOrganizationIds = [input.organizationId, input.organization_id].filter(
    (value) => value !== undefined,
  );
  if (
    rawOrganizationIds.length === 0 ||
    rawOrganizationIds.some(
      (value) => typeof value !== 'string' || value.trim().length === 0,
    )
  ) {
    return null;
  }
  const organizationId = String(rawOrganizationIds[0]);
  if (
    rawOrganizationIds.some(
      (value) => typeof value === 'string' && value !== organizationId,
    )
  ) {
    return null;
  }
  if (input.digest !== undefined && typeof input.digest !== 'string') return null;
  return {
    revision: input.revision as number,
    fetchedAt,
    states,
    organizationId,
    ...(typeof input.digest === 'string' && input.digest ? { digest: input.digest } : {}),
  };
}

/** Fetch availability from the server RPC. No organization or RPC error means deny all tools. */
export async function fetchCopilotAvailability(
  organizationId: string | null | undefined,
  rpc: AvailabilityRpc,
  now = Date.now(),
): Promise<CopilotAvailabilitySnapshot | null> {
  if (!organizationId) return null;
  try {
    const { data, error } = await rpc(organizationId);
    if (error) {
      // Fail closed: an unavailable rollout snapshot must expose no Copilot capability.
      return unavailableCopilotSnapshot();
    }
    const snapshot = parseCopilotAvailability(data);
    if (!snapshot || snapshot.fetchedAt > now || now - snapshot.fetchedAt > 60_000) return null;
    if (snapshot.organizationId !== organizationId) return null;
    return snapshot;
  } catch {
    // Fail closed: transport or parser failures must not enable stale/unverified tools.
    return unavailableCopilotSnapshot();
  }
}

/**
 * React Query adapter for the server-owned availability RPC.
 *
 * `live` là cho màn hình MỞ LÂU (panel chat). Snapshot hết hạn sau 60s và
 * `buildRegistry` trả danh sách tool rỗng khi hết hạn, nên không poll thì Copilot
 * tự cụt công cụ sau một phút mà không báo gì — bệnh đã đo. Poll 30s là nửa hạn
 * dùng: luôn có một lượt làm tươi trước khi snapshot chết.
 *
 * `refetchIntervalInBackground: false` để tab bị ẩn không nã RPC; lúc quay lại
 * tab, `refetchOnWindowFocus` mặc định của React Query lo phần làm tươi.
 *
 * Trang admin gọi KHÔNG kèm `live` — ở đó snapshot là thứ người dùng chủ động
 * tải lại, và poll ngầm sẽ đá mất trạng thái đang thao tác.
 */
export function useCopilotAvailability(
  organizationId: string | null | undefined,
  opts?: { live?: boolean },
) {
  return useQuery<CopilotAvailabilitySnapshot | null>({
    queryKey: ['copilot-availability', organizationId ?? null],
    enabled: Boolean(organizationId),
    staleTime: 60_000,
    retry: false,
    ...(opts?.live ? { refetchInterval: 30_000, refetchIntervalInBackground: false } : {}),
    queryFn: async () => {
      if (!organizationId) return null;
      return fetchCopilotAvailability(
        organizationId,
        callAvailabilityRpc,
      );
    },
  });
}

export function copilotAvailability(
  snapshot: CopilotAvailabilitySnapshot | null | undefined,
  key: string,
  maxAgeMs = 60_000,
  now = Date.now(),
): CopilotFlagState {
  if (!copilotAvailabilitySnapshotIsFresh(snapshot, maxAgeMs, now)) return 'disabled';
  const scopedKey = key.includes(':') ? key : `page:${key}`;
  const state = snapshot.states?.[scopedKey];
  return state === 'enabled' || state === 'shadow' ? state : 'disabled';
}

/** A rollout exemption still requires a recent, server-owned snapshot. */
export function copilotAvailabilitySnapshotIsFresh(
  snapshot: CopilotAvailabilitySnapshot | null | undefined,
  maxAgeMs = 60_000,
  now = Date.now(),
): snapshot is CopilotAvailabilitySnapshot {
  if (
    !snapshot ||
    typeof snapshot.organizationId !== 'string' ||
    snapshot.organizationId.trim().length === 0 ||
    !Number.isFinite(snapshot.fetchedAt) ||
    snapshot.fetchedAt < 0
  ) return false;
  if (snapshot.fetchedAt > now) return false;
  return now - snapshot.fetchedAt <= maxAgeMs;
}

export function filterAvailableContractKeys(
  keys: readonly string[],
  snapshot: CopilotAvailabilitySnapshot | null | undefined,
  now = Date.now(),
): string[] {
  return keys.filter((key) => copilotAvailability(snapshot, key, 60_000, now) === 'enabled');
}

export function rolloutStateAllowsExecution(
  snapshot: CopilotAvailabilitySnapshot | null | undefined,
  key: string,
  now = Date.now(),
): boolean {
  return copilotAvailability(snapshot, key, 60_000, now) === 'enabled';
}
