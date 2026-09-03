import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ROUTE_DIEU_HUONG } from './pageScope';
import { ACTION_CATALOG } from './plan/actionCatalog';

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
export interface CopilotRolloutContract {
  scope: 'page' | 'action';
  contractId: string;
  label: string;
}

export const KHOA_ROLLOUT_DIEU_HUONG = 'copilot.navigation';

/**
 * Ba khoá rollout RIÊNG cho ba tool đọc miền nhạy cảm (G1-C4).
 *
 * `/finance/salary`, `/reports/finance/profit-distribution` và `/network-center`
 * đều nằm trong `COPILOT_PAGE_EXEMPTIONS` nên KHÔNG có contract trang. Bản đầu
 * cho ba tool mượn khoá của trang canonical gần nhất (`reports.finance` hai lần,
 * `buildings.list` một lần). Nó CHẠY, và nó sai theo đúng cách đo được: bật
 * rollout báo cáo tài chính khi đó cũng bật luôn tool BẢNG LƯƠNG. Hai quyết định
 * vận hành không liên quan đi chung một công tắc chính là thứ mà việc gỡ
 * `rolloutKeys` (03/09) sinh ra để chặn.
 *
 * Hai lựa chọn còn lại tệ hơn: không khai khoá nào thì `toolAvailableForRollout`
 * trả false ⇒ tool CHẾT vĩnh viễn; `rolloutExempt` thì tool SỐNG vĩnh viễn,
 * không còn công tắc nào.
 *
 * Zalo KHÔNG có mặt ở đây: `/chat-zalo` đã có contract thật (`chat-zalo.list`),
 * và dựng công tắc thứ hai cho cùng một trang là hai dòng cùng quyết định một
 * việc.
 *
 * Mỗi khoá ở đây PHẢI có một dòng seed tương ứng trong migration
 * `20260902224859`; `copilotRolloutSeedPagesMigration.test.ts` canh cặp đó không
 * lệch, vì `set_copilot_feature_flag_v2` chỉ UPDATE dòng CÓ SẴN.
 */
export const KHOA_ROLLOUT_LUONG = 'copilot.sensitive.salary';
export const KHOA_ROLLOUT_LOI_NHUAN_CO_DONG = 'copilot.sensitive.shareholder-profit';
export const KHOA_ROLLOUT_MANG = 'copilot.sensitive.network';

/** Ba contract trên, kèm nhãn tiếng Việt cho trang admin. */
export const COPILOT_ROLLOUT_MIEN_NHAY_CAM: readonly CopilotRolloutContract[] = [
  { scope: 'page', contractId: KHOA_ROLLOUT_LUONG, label: 'Bảng lương quản lý (Copilot đọc)' },
  {
    scope: 'page',
    contractId: KHOA_ROLLOUT_LOI_NHUAN_CO_DONG,
    label: 'Lợi nhuận cổ đông (Copilot đọc)',
  },
  { scope: 'page', contractId: KHOA_ROLLOUT_MANG, label: 'Trung tâm mạng (Copilot đọc)' },
];

/**
 * Contract của KẾ HOẠCH THỰC THI (G3) — công tắc duy nhất cho cả cơ chế plan.
 *
 * Không sinh ra từ `ACTION_CATALOG` vì nó không phải một hành động: nó là cái
 * máy chạy nhiều hành động. Tắt nó thì từng hành động lẻ vẫn dùng được qua
 * đường một-bước hôm nay; tắt một hành động thì kế hoạch nào chạm tới nó cũng
 * dừng. Hai câu hỏi khác nhau, hai công tắc.
 *
 * Hằng số mang SẴN tiền tố `action:` vì nó được truyền thẳng vào
 * `copilotAvailability()`, nơi khoá trần bị gắn `page:`.
 */
export const CONTRACT_KE_HOACH = 'copilot.execution_plan';
export const KHOA_ROLLOUT_KE_HOACH = `action:${CONTRACT_KE_HOACH}`;

/**
 * Contract scope `action` — sinh TỪ `ACTION_CATALOG`, không chép tay.
 *
 * Cho tới 03/09/2026 danh sách này RỖNG và chú thích cũ giải thích vì sao: bảng
 * `copilot_feature_flags` chưa có dòng scope `action` nào, mà
 * `set_copilot_feature_flag_v2` chỉ UPDATE dòng CÓ SẴN — khai tên ở client mà
 * server không có dòng thì người vận hành bấm nút và nhận `unknown_rollout_contract`,
 * một lỗi không có cách nào tự chữa. Migration G2-A
 * (`20260903043956`) đã seed đúng hai dòng đó ở trạng thái `disabled`, nên điều
 * kiện ấy đã hết.
 *
 * Nguồn là catalog chứ không phải một mảng gõ tay: thêm một hành động vào sổ mà
 * quên công tắc của nó là dựng một đường ghi không tắt được — đúng thứ mà kill
 * switch sinh ra để chặn. `actionCatalog.test.ts` canh catalog khớp seed
 * registry; `actionRolloutSeedMigration.test.ts` canh mỗi contract ở đây có một
 * dòng seed cờ.
 */
export const COPILOT_ROLLOUT_ACTION_CONTRACTS: readonly CopilotRolloutContract[] = [
  ...Object.values(ACTION_CATALOG).map((entry) => ({
    scope: 'action' as const,
    contractId: entry.actionId,
    label: entry.labelVi,
  })),
  {
    scope: 'action',
    contractId: CONTRACT_KE_HOACH,
    label: 'Kế hoạch thực thi nhiều bước (Copilot Mức 3)',
  },
];

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
  // Ba miền nhạy cảm không sinh ra từ `ROUTE_DIEU_HUONG` được vì ba trang của
  // chúng nằm trong danh sách miễn trừ — nên chúng được chèn thẳng ở đây, đúng
  // cách khoá điều hướng được chèn ngay trên.
  for (const contract of COPILOT_ROLLOUT_MIEN_NHAY_CAM) {
    theoKhoa.set(contract.contractId, contract);
  }
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

/**
 * Chiếu snapshot server thành hàng cho trang admin.
 *
 * `contracts` tham số hoá để test được luật với một contract scope `action` —
 * danh sách thật hôm nay toàn `page`, nên một test nạp danh sách thật KHÔNG
 * bao giờ chạm được nhánh sai scope.
 */
export function rolloutRowsFromAvailability(
  snapshot: CopilotAvailabilitySnapshot | null | undefined,
  contracts: readonly CopilotRolloutContract[] = COPILOT_ROLLOUT_CONTRACTS,
): CopilotRolloutRow[] {
  return contracts.map((contract) => ({
    ...contract,
    // Khoá PHẢI mang tiền tố scope của chính hàng. `copilotAvailability` mặc
    // định gắn `page:` cho khoá trần (xem hàm đó), nên một contract scope
    // `action` sẽ đọc trạng thái của khoá `page:` cùng tên: trang admin hiện
    // sai trạng thái, mời sai bộ nút chuyển tiếp, và cú bấm cuối cùng chết ở
    // `invalid_rollout_transition` — lỗi nói về transition trong khi bệnh nằm
    // ở chỗ đọc. Hôm nay mọi contract đều `page` nên không ai thấy; đúng lúc
    // ai đó dùng tới điểm mở rộng `action` thì nó mới lộ.
    state: copilotAvailability(snapshot, `${contract.scope}:${contract.contractId}`),
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
