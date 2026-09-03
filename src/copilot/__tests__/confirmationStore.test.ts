// Nonce phải sống trong bộ nhớ, hết hạn tự dọn, và tiêu đúng MỘT lần.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  datXacNhanDangCho,
  layXacNhanDangCho,
  tieuXacNhan,
  xoaXacNhanDangCho,
} from '../confirmationStore';

const MAU = {
  tool: 'income_expense.create_draft',
  nonce: 'a'.repeat(64),
  canonical: { organization_id: 'org', amount: 100000 },
  preview: { so_tien: 100000, toa_nha: 'Toà A' },
};

describe('confirmationStore', () => {
  beforeEach(() => xoaXacNhanDangCho());

  it('đặt rồi lấy được nguyên vẹn', () => {
    datXacNhanDangCho(MAU);
    const x = layXacNhanDangCho()!;
    expect(x.nonce).toBe(MAU.nonce);
    expect(x.canonical).toEqual(MAU.canonical);
    expect(x.preview).toEqual(MAU.preview);
  });

  it('tiêu MỘT lần: lần thứ hai trả null', () => {
    // Lấy-rồi-xoá gộp một bước. Tách ra thì có khoảng mà nonce đã đọc nhưng
    // chưa xoá, và hai lần bấm nhanh lấy được cùng một nonce.
    datXacNhanDangCho(MAU);
    expect(tieuXacNhan()?.nonce).toBe(MAU.nonce);
    expect(tieuXacNhan()).toBeNull();
    expect(layXacNhanDangCho()).toBeNull();
  });

  it('quá hạn thì tự dọn, KHÔNG trả về nonce chết', () => {
    // Một nonce hết hạn mà vẫn hiện nút bấm là mời người dùng bấm vào một lỗi.
    datXacNhanDangCho(MAU, 1000);
    const t0 = Date.now();
    expect(layXacNhanDangCho(t0)).toBeTruthy();
    expect(layXacNhanDangCho(t0 + 60_000)).toBeNull();
  });

  it('trừ hao trước mốc hết hạn của server', () => {
    // Server cho 5 phút; client phải hết hạn SỚM hơn để không bắn một nonce vừa
    // chết trên đường truyền.
    datXacNhanDangCho(MAU, 5 * 60_000);
    const x = layXacNhanDangCho()!;
    expect(x.hetHanLuc).toBeLessThan(Date.now() + 5 * 60_000);
  });

  it('đề xuất mới ĐÈ đề xuất cũ — một khe, không phải hàng đợi', () => {
    // Hai đề xuất cùng chờ thì người dùng không biết mình bấm cho cái nào.
    datXacNhanDangCho(MAU);
    datXacNhanDangCho({ ...MAU, nonce: 'b'.repeat(64) });
    expect(layXacNhanDangCho()?.nonce).toBe('b'.repeat(64));
  });

  it('giữ các intent độc lập để không dùng nhầm nonce giữa hai hành động', () => {
    datXacNhanDangCho({ ...MAU, intentKey: 'org-a:action-a' });
    datXacNhanDangCho({ ...MAU, nonce: 'b'.repeat(64), intentKey: 'org-b:action-b' });
    expect(layXacNhanDangCho(Date.now(), 'org-a:action-a')?.nonce).toBe(MAU.nonce);
    expect(layXacNhanDangCho(Date.now(), 'org-b:action-b')?.nonce).toBe('b'.repeat(64));
    expect(tieuXacNhan(Date.now(), 'org-a:action-a')?.nonce).toBe(MAU.nonce);
    expect(layXacNhanDangCho(Date.now(), 'org-a:action-a')).toBeNull();
  });

  it('KHÔNG chạm localStorage/sessionStorage', async () => {
    // Nonce sống 5 phút và chỉ có nghĩa trong lượt chat đang mở. Ghi xuống đĩa
    // là kéo dài vòng đời của một thứ cố ý ngắn, và thêm một chỗ nữa để nó rò ra.
    //
    // Kiểm trên MÃ NGUỒN chứ không bẫy Storage lúc chạy: test này chạy ở môi
    // trường node không có Storage, nên một cái bẫy sẽ không bao giờ nổ và test
    // sẽ xanh vĩnh viễn dù ai đó thêm localStorage vào file.
    const { readFileSync } = await import('node:fs');
    const nguon = readFileSync('src/copilot/confirmationStore.ts', 'utf8');
    const ma = nguon
      .split(/\r?\n/)
      .filter((d) => !d.trim().startsWith('//') && !d.trim().startsWith('*'))
      .join('\n');
    expect(ma).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it('accessors không đối số vẫn lấy đề xuất intent mới nhất cho thẻ xác nhận', () => {
    datXacNhanDangCho({ ...MAU, intentKey: 'org-a:action-a' });
    expect(layXacNhanDangCho()?.nonce).toBe(MAU.nonce);
    expect(tieuXacNhan()?.nonce).toBe(MAU.nonce);
    expect(layXacNhanDangCho()).toBeNull();
  });

  // ── Loại đề xuất (G3) ─────────────────────────────────────────────────────
  //
  // HAI THẺ, HAI KHE. Thẻ phiếu và thẻ kế hoạch cùng đọc kho này; nếu chúng
  // chia nhau MỘT con trỏ "mới nhất" thì lập một kế hoạch sẽ làm thẻ phiếu vẽ
  // nhầm (hoặc mất) đề xuất phiếu vẫn còn hạn — và ngược lại.
  const KE_HOACH = {
    kind: 'ke_hoach' as const,
    tool: 'lap_ke_hoach',
    nonce: 'b'.repeat(64),
    canonical: { plan_id: 'p1', plan_digest: 'c'.repeat(64) },
    preview: { ke_hoach: { planId: 'p1' } },
    intentKey: 'ke_hoach:p1',
  };

  it('hai loại đề xuất KHÔNG vẽ nhầm sang nhau', () => {
    datXacNhanDangCho(MAU);
    datXacNhanDangCho(KE_HOACH);
    // Thẻ phiếu (mặc định `kind: 'phieu'`) vẫn thấy đúng đề xuất phiếu, dù đề
    // xuất kế hoạch mới hơn.
    expect(layXacNhanDangCho()?.tool).toBe(MAU.tool);
    expect(layXacNhanDangCho(Date.now(), undefined, undefined, 'ke_hoach')?.tool).toBe('lap_ke_hoach');
  });

  it('lọc theo loại kể cả khi nơi gọi tự đưa intentKey', () => {
    datXacNhanDangCho(KE_HOACH);
    expect(layXacNhanDangCho(Date.now(), 'ke_hoach:p1')).toBeNull();
    expect(layXacNhanDangCho(Date.now(), 'ke_hoach:p1', undefined, 'ke_hoach')?.nonce).toBe(KE_HOACH.nonce);
  });

  it('tiêu đúng loại, không cướp nonce của loại kia', () => {
    datXacNhanDangCho(MAU);
    datXacNhanDangCho(KE_HOACH);
    expect(tieuXacNhan(Date.now(), undefined, undefined, 'ke_hoach')?.nonce).toBe(KE_HOACH.nonce);
    expect(layXacNhanDangCho(Date.now(), undefined, undefined, 'ke_hoach')).toBeNull();
    // Đề xuất phiếu KHÔNG bị đụng tới.
    expect(layXacNhanDangCho()?.nonce).toBe(MAU.nonce);
  });

  it('huỷ thẻ kế hoạch không làm bay đề xuất phiếu đang chờ', () => {
    datXacNhanDangCho(MAU);
    datXacNhanDangCho(KE_HOACH);
    xoaXacNhanDangCho('ke_hoach');
    expect(layXacNhanDangCho(Date.now(), undefined, undefined, 'ke_hoach')).toBeNull();
    expect(layXacNhanDangCho()?.nonce).toBe(MAU.nonce);
  });

  // ── Loại `step_up` (G5-A) ────────────────────────────────────────────────
  //
  // BA THẺ, BA KHE. Token step-up là một đề xuất nữa cùng đi qua kho này
  // (`stepUpClient.ts`), và nó phải sống độc lập với `phieu` LẪN `ke_hoach` —
  // xác thực PIN xong không được làm rơi một đề xuất phiếu hay kế hoạch đang
  // chờ ở hai thẻ khác trên cùng màn hình.
  const STEP_UP = {
    kind: 'step_up' as const,
    tool: 'step_up',
    nonce: 'e'.repeat(64),
    canonical: null,
    preview: {},
    intentKey: 'step_up:org-1',
    organizationId: 'org-1',
  };

  it('ba loại đề xuất cùng tồn tại, không đè lên nhau', () => {
    datXacNhanDangCho(MAU);
    datXacNhanDangCho(KE_HOACH);
    datXacNhanDangCho(STEP_UP);
    expect(layXacNhanDangCho()?.tool).toBe(MAU.tool);
    expect(layXacNhanDangCho(Date.now(), undefined, undefined, 'ke_hoach')?.tool).toBe('lap_ke_hoach');
    expect(layXacNhanDangCho(Date.now(), undefined, undefined, 'step_up')?.nonce).toBe(STEP_UP.nonce);
  });

  it('tiêu token step-up không cướp nonce của phiếu/kế hoạch', () => {
    datXacNhanDangCho(MAU);
    datXacNhanDangCho(KE_HOACH);
    datXacNhanDangCho(STEP_UP);
    expect(tieuXacNhan(Date.now(), 'step_up:org-1', undefined, 'step_up')?.nonce).toBe(STEP_UP.nonce);
    expect(layXacNhanDangCho(Date.now(), 'step_up:org-1', undefined, 'step_up')).toBeNull();
    expect(layXacNhanDangCho()?.nonce).toBe(MAU.nonce);
    expect(layXacNhanDangCho(Date.now(), undefined, undefined, 'ke_hoach')?.nonce).toBe(KE_HOACH.nonce);
  });

  it('token step-up cũng tiêu MỘT lần: lần thứ hai trả null', () => {
    datXacNhanDangCho(STEP_UP);
    expect(tieuXacNhan(Date.now(), 'step_up:org-1', undefined, 'step_up')?.nonce).toBe(STEP_UP.nonce);
    expect(tieuXacNhan(Date.now(), 'step_up:org-1', undefined, 'step_up')).toBeNull();
  });
});
