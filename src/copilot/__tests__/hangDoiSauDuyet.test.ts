// Hàng đợi sau khi bấm Duyệt — luật nằm ở hàm THUẦN, và đây là chỗ đo nó.
//
// SỰ CỐ ĐƯỢC CHẶN: `KeHoachCard` vẽ ngoài `{!running && …}`, nên nút Duyệt bấm
// được trong lúc mô hình đang viết dở. Đường gửi mở đầu bằng `if (running)
// return;` (không đẻ hai lượt chat chồng nhau), nên cú bấm rơi vào im lặng —
// trong khi server thì KHÔNG im lặng: nonce đã tiêu, kế hoạch đã APPROVED, và
// nonce không phát lại được. Người dùng còn lại một cái thẻ "đang chạy" đứng yên.
//
// Repo không có jsdom/react-test-renderer nên hook chỉ đo được qua phần thuần
// của nó — đó chính là lý do toàn bộ luật nằm ở `quyetDinhChay` chứ không nằm
// trong thân `useEffect`.
import { describe, expect, it } from 'vitest';

import { quyetDinhChay, type KeHoachDaDuyet } from '../useHangDoiSauDuyet';

const KE_HOACH: KeHoachDaDuyet = { planId: 'bbbb0000-0000-4000-8000-000000000002', planVersion: 2 };

describe('quyetDinhChay', () => {
  it('rảnh + có kế hoạch chờ ⇒ chạy ngay và dọn khe', () => {
    expect(quyetDinhChay(KE_HOACH, false)).toEqual({ chay: KE_HOACH, conLai: null });
  });

  it('đang chạy ⇒ GIỮ LẠI, không bỏ đi', () => {
    // Đây là bài đo của cả sự cố: bỏ đi nghĩa là nonce đã tiêu mà không lượt nào
    // chạy các bước.
    expect(quyetDinhChay(KE_HOACH, true)).toEqual({ chay: null, conLai: KE_HOACH });
  });

  it('khe rỗng ⇒ không chạy gì, dù rảnh', () => {
    expect(quyetDinhChay(null, false)).toEqual({ chay: null, conLai: null });
    expect(quyetDinhChay(null, true)).toEqual({ chay: null, conLai: null });
  });

  it('chuỗi thật: bấm lúc bận → vẫn còn chờ → hết bận thì chạy đúng MỘT lần', () => {
    let cho: KeHoachDaDuyet | null = null;
    const daChay: KeHoachDaDuyet[] = [];
    const nhip = (running: boolean) => {
      const { chay, conLai } = quyetDinhChay(cho, running);
      cho = conLai;
      if (chay) daChay.push(chay);
    };

    cho = KE_HOACH; // người dùng bấm Duyệt trong lúc mô hình đang viết
    nhip(true);
    expect(cho).toEqual(KE_HOACH);
    nhip(true);
    expect(daChay).toHaveLength(0);

    nhip(false); // mô hình viết xong
    expect(daChay).toEqual([KE_HOACH]);
    expect(cho).toBeNull();

    nhip(false); // không gửi lại lần hai
    expect(daChay).toHaveLength(1);
  });

  it('kế hoạch MỚI đè kế hoạch cũ còn trong khe', () => {
    // Một người dùng chỉ bấm được một thẻ tại một thời điểm (tiêu nonce là thẻ
    // biến mất). Nếu bằng cách nào đó có cái thứ hai, cái người dùng VỪA đồng ý
    // là cái phải chạy.
    let cho: KeHoachDaDuyet | null = KE_HOACH;
    const moi: KeHoachDaDuyet = { planId: 'cccc0000-0000-4000-8000-000000000003', planVersion: 1 };
    cho = moi;
    expect(quyetDinhChay(cho, false).chay).toEqual(moi);
  });
});
