import { describe, expect, it } from 'vitest';
import {
  copilotAvailability,
  fetchCopilotAvailability,
  parseCopilotAvailability,
  filterAvailableContractKeys,
  COPILOT_ROLLOUT_CONTRACTS,
  COPILOT_ROLLOUT_MIEN_NHAY_CAM,
  COPILOT_ROLLOUT_ACTION_CONTRACTS,
  KHOA_ROLLOUT_DIEU_HUONG,
  taoRolloutContracts,
  nhomRolloutTheoScope,
  rolloutRowsFromAvailability,
  copilotRolloutTransitions,
  formatCopilotRolloutError,
  type CopilotAvailabilitySnapshot,
} from '../featureFlags';
import { ROUTE_DIEU_HUONG } from '../pageScope';

const ORG = 'aaaa0000-0000-4000-8000-000000000001';

describe('Copilot feature flags', () => {
  it('fails closed for missing or stale snapshots', () => {
    expect(copilotAvailability(undefined, 'rooms.list')).toBe('disabled');
    const stale: CopilotAvailabilitySnapshot = { revision: 1, fetchedAt: 0, organizationId: ORG, states: { 'page:rooms.list': 'enabled' } };
    expect(copilotAvailability(stale, 'rooms.list', 60_000, 60_001)).toBe('disabled');
  });

  it('exposes enabled keys only; shadow is not executable', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 2,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled', 'page:invoices.list': 'shadow', 'page:customers.list': 'disabled' },
    };
    expect(filterAvailableContractKeys(['rooms.list', 'invoices.list', 'customers.list'], snapshot)).toEqual(['rooms.list']);
  });

  it('keeps page and action rollout keys independent', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 3,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:shared.read': 'enabled', 'action:shared.read': 'disabled' },
    };
    expect(copilotAvailability(snapshot, 'shared.read')).toBe('enabled');
    expect(copilotAvailability(snapshot, 'action:shared.read')).toBe('disabled');
  });

  it('accepts only server snapshots with a finite revision, timestamp, and valid states', () => {
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, organization_id: ORG, states: { 'page:rooms.list': 'enabled' } })).toEqual({
      revision: 4,
      // Numeric epoch values below the millisecond range are interpreted as
      // seconds; the client contract stores timestamps in milliseconds.
      fetchedAt: 1_234_000,
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled' },
    });
    expect(parseCopilotAvailability({ revision: 0, fetchedAt: 1234, organizationId: ORG, states: { 'page:rooms.list': 'enabled' } })).toBeNull();
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, organizationId: ORG, states: { 'page:rooms.list': 'ON' } })).toBeNull();
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, organizationId: ORG, states: { 'rooms.list': 'enabled' } })).toBeNull();
    expect(parseCopilotAvailability(['rooms.list'])).toBeNull();
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, states: { 'page:rooms.list': 'enabled' } })).toBeNull();
    expect(parseCopilotAvailability({ revision: 4, fetchedAt: 1234, organizationId: ORG, organization_id: 'other', states: { 'page:rooms.list': 'enabled' } })).toBeNull();
  });

  it('fails closed when the server availability RPC errors or returns malformed data', async () => {
    const rpc = async () => ({ data: { revision: 1, fetchedAt: 1_700_000_000_000, organization_id: 'org-1', states: { 'page:rooms.list': 'enabled' } }, error: null });
    await expect(fetchCopilotAvailability('org-1', rpc, 1_700_000_000_001)).resolves.toMatchObject({ revision: 1, organizationId: 'org-1' });
    const malformed = async () => ({ data: { revision: 1, fetchedAt: 1_700_000_000_000, organization_id: 'org-1', states: { 'page:rooms.list': 'ON' } }, error: null });
    await expect(fetchCopilotAvailability('org-1', malformed, 1_700_000_000_001)).resolves.toBeNull();
    const failed = async () => ({ data: null, error: new Error('network') });
    await expect(fetchCopilotAvailability('org-1', failed, 200)).resolves.toBeNull();
  });

  it('does not query availability without a selected organization', async () => {
    let called = false;
    const rpc = async () => {
      called = true;
      return { data: null, error: null };
    };
    await expect(fetchCopilotAvailability(null, rpc, 200)).resolves.toBeNull();
    expect(called).toBe(false);
  });

  it('projects the server snapshot into the admin rollout rows without inventing enabled state', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 7,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled', 'page:customers.list': 'shadow' },
    };
    const rows = rolloutRowsFromAvailability(snapshot);
    expect(rows).toHaveLength(COPILOT_ROLLOUT_CONTRACTS.length);
    expect(rows.find((row) => row.contractId === 'rooms.list')?.state).toBe('enabled');
    expect(rows.find((row) => row.contractId === 'customers.list')?.state).toBe('shadow');
    expect(rows.find((row) => row.contractId === 'invoices.list')?.state).toBe('disabled');
    expect(rows.every((row) => row.revision === 7)).toBe(true);
  });

  it('only offers legal rollout transitions and maps CAS conflicts to an operator action', () => {
    expect(copilotRolloutTransitions('disabled')).toEqual(['shadow']);
    expect(copilotRolloutTransitions('shadow')).toEqual(['enabled', 'disabled']);
    expect(copilotRolloutTransitions('enabled')).toEqual(['shadow', 'disabled']);
    expect(formatCopilotRolloutError(new Error('copilot_rollout_stale_revision'))).toContain('tải lại');
    expect(formatCopilotRolloutError(new Error('rollout_evidence_required'))).toContain('bằng chứng');
  });
});

describe('COPILOT_ROLLOUT_CONTRACTS sinh từ page contract', () => {
  it('có ĐÚNG một dòng cho mỗi đích điều hướng, cộng điều hướng và 3 miền nhạy cảm', () => {
    // Bản trước chép tay 3 dòng. Vì `set_copilot_feature_flag_v2` chỉ UPDATE
    // dòng CÓ SẴN, một trang thiếu contract là một trang không bao giờ bật
    // được — im lặng, và chỉ lộ ra khi ai đó hỏi "sao trang này không có nút".
    //
    // Ba khoá `copilot.sensitive.*` KHÔNG sinh ra từ `ROUTE_DIEU_HUONG` được:
    // ba trang của chúng nằm trong `COPILOT_PAGE_EXEMPTIONS`. Chúng được chèn
    // thẳng, đúng cách khoá điều hướng được chèn — và phải có mặt ở đây, nếu
    // không thì tool tương ứng không bao giờ bật được.
    expect(ROUTE_DIEU_HUONG.length).toBeGreaterThanOrEqual(15); // sàn chống-xanh-rỗng
    const khoaTrang = COPILOT_ROLLOUT_CONTRACTS.filter((c) => c.scope === 'page').map(
      (c) => c.contractId,
    );
    const nhayCam = COPILOT_ROLLOUT_MIEN_NHAY_CAM.map((c) => c.contractId);
    expect(nhayCam).toEqual([
      'copilot.sensitive.salary',
      'copilot.sensitive.shareholder-profit',
      'copilot.sensitive.network',
    ]);
    expect(new Set(khoaTrang)).toEqual(
      new Set([...ROUTE_DIEU_HUONG.map((m) => m.key), KHOA_ROLLOUT_DIEU_HUONG, ...nhayCam]),
    );
    expect(khoaTrang.length).toBe(ROUTE_DIEU_HUONG.length + 1 + nhayCam.length);
    // Không khoá nhạy cảm nào được trùng tên một trang thật: trùng là hai nút
    // admin cùng bấm vào một flag.
    for (const khoa of nhayCam) {
      expect(ROUTE_DIEU_HUONG.map((m) => m.key), khoa).not.toContain(khoa);
    }
  });

  it('không có contractId trùng — trùng là hai dòng admin cùng bấm vào một flag', () => {
    const khoa = COPILOT_ROLLOUT_CONTRACTS.map((c) => `${c.scope}:${c.contractId}`);
    expect(new Set(khoa).size).toBe(khoa.length);
  });

  it('nhãn là tiếng Việt lấy từ catalog, không phải khoá kỹ thuật', () => {
    for (const contract of COPILOT_ROLLOUT_CONTRACTS) {
      expect(contract.label.trim().length, contract.contractId).toBeGreaterThan(0);
      expect(contract.label, contract.contractId).not.toBe(contract.contractId);
    }
    expect(
      COPILOT_ROLLOUT_CONTRACTS.find((c) => c.contractId === 'rooms.list')?.label,
    ).toBe('Căn hộ / Phòng');
  });

  it('khoá điều hướng là scope `page` — bảng flag chỉ nhận page|action', () => {
    const dieuHuong = COPILOT_ROLLOUT_CONTRACTS.find(
      (c) => c.contractId === KHOA_ROLLOUT_DIEU_HUONG,
    );
    expect(dieuHuong?.scope).toBe('page');
    expect(KHOA_ROLLOUT_DIEU_HUONG).toBe('copilot.navigation');
  });

  it('hàm dựng là THUẦN: fixture vào, contract ra, giữ nguyên contract action', () => {
    const contracts = taoRolloutContracts(
      [
        { key: 'x.list', label: 'Trang X' },
        { key: 'x.list', label: 'Trang X (trùng)' },
        { key: 'y.list', label: 'Trang Y' },
      ],
      [{ scope: 'action', contractId: 'z.do', label: 'Thao tác Z' }],
    );
    expect(contracts.map((c) => `${c.scope}:${c.contractId}`)).toEqual([
      'page:x.list',
      'page:y.list',
      `page:${KHOA_ROLLOUT_DIEU_HUONG}`,
      ...COPILOT_ROLLOUT_MIEN_NHAY_CAM.map((c) => `page:${c.contractId}`),
      'action:z.do',
    ]);
    expect(contracts.find((c) => c.contractId === 'x.list')?.label).toBe('Trang X');
  });

  it('danh sách contract action rỗng khớp seed server — không dựng nút bấm hỏng', () => {
    // Có tên ở đây mà không có dòng trong bảng ⇒ admin bấm và nhận
    // `unknown_rollout_contract`, không cách nào tự chữa.
    expect(COPILOT_ROLLOUT_ACTION_CONTRACTS).toEqual([]);
    expect(COPILOT_ROLLOUT_CONTRACTS.every((c) => c.scope === 'page')).toBe(true);
  });

  it('khoá vắng mặt trong snapshot ⇒ disabled, không phải "không rõ"', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 9,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled' },
    };
    const rows = rolloutRowsFromAvailability(snapshot);
    expect(rows).toHaveLength(COPILOT_ROLLOUT_CONTRACTS.length);
    expect(rows.filter((row) => row.state !== 'disabled').map((row) => row.contractId)).toEqual([
      'rooms.list',
    ]);
    expect(rows.find((row) => row.contractId === KHOA_ROLLOUT_DIEU_HUONG)?.state).toBe('disabled');
  });
});

describe('hàng admin đọc ĐÚNG scope của chính nó', () => {
  it('contract `action` đọc khoá `action:`, không rơi về `page:` cùng tên', () => {
    // `copilotAvailability` gắn `page:` cho khoá TRẦN. Truyền `contract.contractId`
    // trần vào đó nghĩa là mọi hàng đều đọc trạng thái scope `page` — vô hại
    // hôm nay (mọi contract đều `page`), nhưng ngay khi có một contract
    // `action` thì trang admin hiện sai trạng thái, mời sai bộ nút chuyển
    // tiếp, và cú bấm cuối chết ở `invalid_rollout_transition`: một lỗi nói về
    // transition trong khi bệnh nằm ở chỗ đọc.
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 21,
      fetchedAt: Date.now(),
      organizationId: ORG,
      // CÙNG tên contract, HAI scope, HAI trạng thái ngược nhau — chỉ cách này
      // mới phân biệt được "đọc đúng scope" với "tình cờ trùng giá trị".
      states: { 'action:x.do': 'enabled', 'page:x.do': 'disabled' },
    };
    const rows = rolloutRowsFromAvailability(snapshot, [
      { scope: 'action', contractId: 'x.do', label: 'Thao tác X' },
      { scope: 'page', contractId: 'x.do', label: 'Trang X' },
    ]);
    expect(rows.find((row) => row.scope === 'action')?.state).toBe('enabled');
    expect(rows.find((row) => row.scope === 'page')?.state).toBe('disabled');
    // Và bộ nút chuyển tiếp đi theo trạng thái đọc được — đây là thứ người
    // vận hành thực sự bấm.
    expect(copilotRolloutTransitions(rows[0].state)).toEqual(['shadow', 'disabled']);
  });

  it('mặc định vẫn là danh sách contract thật khi không truyền tham số', () => {
    const snapshot: CopilotAvailabilitySnapshot = {
      revision: 22,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: { 'page:rooms.list': 'enabled' },
    };
    expect(rolloutRowsFromAvailability(snapshot)).toHaveLength(COPILOT_ROLLOUT_CONTRACTS.length);
  });
});

describe('nhóm rollout theo scope cho trang admin', () => {
  it('giữ nguyên thứ tự trong nhóm, bỏ nhóm rỗng', () => {
    const rows = rolloutRowsFromAvailability({
      revision: 11,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: {},
    });
    const nhom = nhomRolloutTheoScope(rows);
    expect(nhom.map((n) => n.scope)).toEqual(['page']); // chưa có contract action nào
    expect(nhom[0].rows.map((r) => r.contractId)).toEqual(rows.map((r) => r.contractId));
    expect(nhom[0].nhan).toContain('Trang');
  });

  it('tách đúng hai nhóm khi có contract action', () => {
    const rows = [
      { scope: 'action' as const, contractId: 'z.do', label: 'Z', state: 'disabled' as const, revision: 1 },
      { scope: 'page' as const, contractId: 'a.list', label: 'A', state: 'enabled' as const, revision: 1 },
    ];
    const nhom = nhomRolloutTheoScope(rows);
    expect(nhom.map((n) => `${n.scope}:${n.rows.length}`)).toEqual(['page:1', 'action:1']);
  });

  it('tổng số hàng của các nhóm bằng số contract — không nuốt dòng nào', () => {
    const rows = rolloutRowsFromAvailability({
      revision: 12,
      fetchedAt: Date.now(),
      organizationId: ORG,
      states: {},
    });
    const tong = nhomRolloutTheoScope(rows).reduce((n, g) => n + g.rows.length, 0);
    expect(tong).toBe(COPILOT_ROLLOUT_CONTRACTS.length);
  });
});
