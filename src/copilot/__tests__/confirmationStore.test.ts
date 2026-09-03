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
});
