import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ROUTE_DIEU_HUONG } from './pageScope';

export type CopilotFlagState = 'disabled' | 'shadow' | 'enabled';

/**
 * Khoá rollout của ĐIỀU HƯỚNG (`mo_trang`) — MỘT khoá cho cả 19 đích.
 *
 * Vì sao tách khỏi rollout từng trang: điều hướng chỉ `navigate()` (UI-control)
 * hoặc trả một link markdown (chat). Nó không đọc dữ liệu và không bấm gì, nên
 * nó không cùng loại rủi ro với UI-control — và gác nó bằng ĐÚNG BỘ khoá của
 * ba trang pilot có nghĩa là: mở thêm một trang cho page-agent thao tác thì
 * cũng vô tình mở/đóng luôn khả năng dẫn đường tới 16 trang còn lại. Hai quyết
 * định khác nhau đi chung một công tắc là cách chắc chắn để một trong hai bị
 * bật nhầm.
 *
 * Khoá này scope `page` (không phải `action`) vì bảng `copilot_feature_flags`
 * chỉ nhận hai giá trị đó và điều hướng là một bề mặt TRANG, không phải một
 * thao tác ghi.
 */
export const KHOA_ROLLOUT_DIEU_HUONG = 'copilot.navigation';

export interface CopilotRolloutContract {
  scope: 'page' | 'action';
  contractId: string;
  label: string;
}

/**
 * Contract scope `action` — hôm nay RỖNG, và đó là sự thật của bảng flag.
 *
 * Seed trên server (`20260828170000`) chỉ có dòng scope `page`; chưa có mã nào
 * đọc một khoá `action:` nào cả. Khai sẵn tên ở đây sẽ dựng lên một hàng trong
 * trang admin mà `set_copilot_feature_flag_v2` từ chối với
 * `unknown_rollout_contract` (RPC chỉ UPDATE dòng CÓ SẴN, không INSERT) —
 * người vận hành bấm nút và nhận một lỗi không có cách nào tự chữa.
 *
 * Thêm một action contract = thêm dòng ở đây VÀ seed dòng tương ứng trong một
 * migration; test `copilotRolloutSeedPagesMigration` canh cặp đó không lệch.
 */
export const COPILOT_ROLLOUT_ACTION_CONTRACTS: readonly CopilotRolloutContract[] = [];

/**
 * Dựng danh sách contract rollout. Hàm THUẦN để test bằng fixture: test nạp
 * `ROUTE_DIEU_HUONG` thật chỉ khẳng định lại dữ liệu của hôm nay.
 *
 * Nguồn là `ROUTE_DIEU_HUONG` — tức `COPILOT_PAGE_CONTRACTS` đã lọc canonical
 * (bỏ route `:param`, gộp trang chi tiết về trang danh sách) và đã có nhãn
 * tiếng Việt từ catalog quyền. Chép tay ba dòng như bản trước có nghĩa là 16
 * trang còn lại KHÔNG BAO GIỜ bật được: RPC transition chỉ UPDATE dòng có sẵn,
 * nên một trang thiếu contract là một trang thiếu công tắc.
 */
export function taoRolloutContracts(
  dichDieuHuong: readonly { key: string; label: string }[],
  contractAction: readonly CopilotRolloutContract[] = COPILOT_ROLLOUT_ACTION_CONTRACTS,
): CopilotRolloutContract[] {
  const theoKhoa = new Map<string, CopilotRolloutContract>();
  for (const muc of dichDieuHuong) {
    if (!theoKhoa.has(muc.key)) {
      theoKhoa.set(muc.key, { scope: 'page', contractId: muc.key, label: muc.label });
    }
  }
  theoKhoa.set(KHOA_ROLLOUT_DIEU_HUONG, {
    scope: 'page',
    contractId: KHOA_ROLLOUT_DIEU_HUONG,
    label: 'Điều hướng của Copilot (mở trang)',
  });
  return [...theoKhoa.values(), ...contractAction];
}

export const COPILOT_ROLLOUT_CONTRACTS: readonly CopilotRolloutContract[] =
  taoRolloutContracts(ROUTE_DIEU_HUONG);

export interface CopilotRolloutRow extends CopilotRolloutContract {
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

export interface NhomRollout {
  scope: 'page' | 'action';
  nhan: string;
  rows: CopilotRolloutRow[];
}

const NHAN_SCOPE: Readonly<Record<'page' | 'action', string>> = {
  page: 'Trang (page)',
  action: 'Thao tác (action)',
};

/**
 * Gom hàng rollout theo scope cho trang admin.
 *
 * Danh sách đi từ 3 dòng lên 20; một bảng phẳng 20 dòng với khoá kỹ thuật
 * `page:reports.real-estate` bên dưới mỗi nhãn thì người vận hành phải đọc từng
 * dòng mới biết mình đang bật cái gì. Nhóm rỗng bị bỏ hẳn — một tiêu đề
 * "Thao tác (action)" không có dòng nào dưới nó chỉ nói dối rằng có thứ để bật.
 */
export function nhomRolloutTheoScope(rows: readonly CopilotRolloutRow[]): NhomRollout[] {
  const nhom: NhomRollout[] = [];
  for (const scope of ['page', 'action'] as const) {
    const cua = rows.filter((row) => row.scope === scope);
    if (cua.length > 0) nhom.push({ scope, nhan: NHAN_SCOPE[scope], rows: cua });
  }
  return nhom;
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
