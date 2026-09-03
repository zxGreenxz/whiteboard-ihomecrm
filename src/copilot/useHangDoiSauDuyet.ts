// Hàng đợi MỘT chỗ: kế hoạch vừa được người dùng bấm duyệt, chờ tới lượt gửi.
//
// VÌ SAO CẦN NÓ (sự cố đã đo, không phải giả định)
//   `KeHoachCard` cố ý vẽ NGOÀI `{!running && …}` — sau khi bấm, lượt chạy các
//   bước LÀ một lượt đang chạy, và ẩn thẻ lúc đó là giấu đúng bảng trạng thái
//   người dùng cần nhìn. Nhưng hệ quả là nút Duyệt vẫn bấm được TRONG LÚC mô
//   hình đang viết dở một lượt khác. Đường gửi (`chayKeHoachSauKhiDuyet`) mở
//   đầu bằng `if (running) return;` để không đẻ hai lượt chat chồng nhau, nên
//   cú bấm đó rơi vào im lặng — trong khi phía server thì KHÔNG im lặng chút
//   nào: `copilot_plan_approve_v1` đã chạy, nonce đã tiêu, kế hoạch đã
//   APPROVED. Người dùng nhìn thấy một cái thẻ "đang chạy" đứng yên vĩnh viễn,
//   và cách duy nhất để chạy tiếp là… không có cách nào, vì nonce không phát
//   lại được.
//
//   Hai lớp chữa, và cần CẢ HAI:
//     · Nút Duyệt bị khoá khi `running` (ở `KeHoachCard`) — chặn ngay từ đầu,
//       kèm câu nói rõ vì sao.
//     · Hàng đợi này — cho những đường vào mà lớp trên không phủ: cú bấm lọt
//       đúng khoảnh khắc `running` vừa bật, hoặc một nơi gọi khác sau này.
//       Khoá nút mà không có hàng đợi thì vẫn còn một khe hở; hàng đợi mà không
//       khoá nút thì người dùng bấm xong không hiểu vì sao chưa thấy gì.
//
// VÌ SAO PHẦN QUYẾT ĐỊNH LÀ MỘT HÀM THUẦN
//   Repo này không có jsdom/react-test-renderer, nên một hook chỉ đo được qua
//   phần thuần của nó. Đưa toàn bộ luật vào `quyetDinhChay` để nó được đo thật,
//   thay vì để luật nằm trong thân `useEffect` rồi tuyên bố là đã kiểm.
import { useEffect, useRef, useState } from 'react';

export interface KeHoachDaDuyet {
  planId: string;
  planVersion: number;
}

/**
 * Còn giữ gì lại, và chạy cái gì ngay bây giờ.
 *
 * MỘT CHỖ, KHÔNG PHẢI MỘT HÀNG. Một người dùng chỉ bấm duyệt được một kế hoạch
 * tại một thời điểm (mỗi thẻ cầm một nonce, và tiêu xong là thẻ biến mất). Nếu
 * bằng cách nào đó có cái thứ hai, cái MỚI thắng: nó là thứ người dùng vừa
 * đồng ý, còn cái cũ đã tiêu nonce nhưng không còn thẻ nào chờ nó.
 */
export function quyetDinhChay(
  cho: KeHoachDaDuyet | null,
  running: boolean,
): { chay: KeHoachDaDuyet | null; conLai: KeHoachDaDuyet | null } {
  if (!cho) return { chay: null, conLai: null };
  if (running) return { chay: null, conLai: cho };
  return { chay: cho, conLai: null };
}

/**
 * Hook mỏng bọc `quyetDinhChay`.
 *
 * `chay` được giữ trong ref: nó là một closure dựng lại mỗi lần render, và đưa
 * nó vào deps của effect sẽ làm effect chạy lại mỗi render — tức gửi lại một
 * kế hoạch đã gửi.
 */
export function useHangDoiSauDuyet(
  running: boolean,
  chay: (planId: string, planVersion: number) => void | Promise<void>,
): { xepHang: (planId: string, planVersion: number) => void; dangCho: KeHoachDaDuyet | null } {
  const [cho, setCho] = useState<KeHoachDaDuyet | null>(null);
  const chayRef = useRef(chay);
  chayRef.current = chay;

  useEffect(() => {
    const { chay: canChay, conLai } = quyetDinhChay(cho, running);
    if (!canChay) return;
    setCho(conLai);
    void chayRef.current(canChay.planId, canChay.planVersion);
  }, [cho, running]);

  return {
    xepHang: (planId: string, planVersion: number) => setCho({ planId, planVersion }),
    dangCho: cho,
  };
}
