import { useEffect, useState } from 'react';

import { formatVND } from '@/lib/utils';
import { layXacNhanDangCho, tieuXacNhan, xoaXacNhanDangCho } from './confirmationStore';
import { layNguCanhXacNhan } from './confirmationStore';
import { thucThiXacNhan, type ConfirmationExecutionContext } from './tools/writeTools';
import {
  copilotAvailability,
  copilotAvailabilitySnapshotIsFresh,
  type CopilotAvailabilitySnapshot,
} from './featureFlags';
import { khoaRolloutHanhDong } from './plan/actionCatalog';

/**
 * Khoá kill switch của hành động này — cùng khoá mà `taoPhieuThuChiNhap` khai
 * làm `rolloutKey`.
 *
 * Kiểm ở ĐÂY nữa, dù danh sách tool đã lọc theo cùng khoá: giữa lúc mô hình lập
 * đề xuất và lúc người dùng bấm nút có tới 5 phút, và một sự cố xảy ra trong 5
 * phút đó thì thứ duy nhất còn chặn được là cú kiểm ngay trước khi tiêu nonce.
 * Snapshot làm tươi mỗi 30 giây nên cờ vừa tắt sẽ tới nơi trước khi hết TTL.
 */
export const KHOA_HANH_DONG_TAO_PHIEU = khoaRolloutHanhDong('income_expense.create_draft');

/** Câu báo khi quản trị đã tắt hành động giữa lúc đề xuất còn treo. */
export const LOI_HANH_DONG_DA_TAT = 'Hành động đã bị tắt bởi quản trị.';

/**
 * Hành động tạo phiếu có đang đóng không — tách hàm để đo được mà không cần
 * dựng DOM.
 *
 * Điều kiện là `!== 'enabled'`, không phải `=== 'disabled'`. Ba trạng thái, hai
 * quyết định: `shadow` nghĩa là đang QUAN SÁT chứ chưa cho chạy thật — cả
 * `rolloutStateAllowsExecution` lẫn `toolAvailableForRollout` đều đòi đúng
 * `enabled`, nên một cú bấm ghi thật dưới cờ `shadow` sẽ là chỗ DUY NHẤT trong
 * hệ hiểu `shadow` là "được ghi".
 *
 * Snapshot thiếu hoặc hết hạn cũng trả `true`: không đọc được cờ thì không
 * được ghi.
 */
export function hanhDongTaoPhieuDaTat(
  availability: CopilotAvailabilitySnapshot | null | undefined,
): boolean {
  return copilotAvailability(availability, KHOA_HANH_DONG_TAO_PHIEU) !== 'enabled';
}

interface Props {
  onXong: (thongBao: string) => void;
  organizationId: string | null;
  threadId: string | null;
  generation: number;
  availability: CopilotAvailabilitySnapshot | null | undefined;
}

/**
 * Thẻ xác nhận tạo phiếu — CÚ BẤM THẬT, chỗ duy nhất mở được đường ghi.
 *
 * VÌ SAO LÀ MỘT COMPONENT RIÊNG, KHÔNG PHẢI MỘT ĐOẠN VĂN BẢN CỦA MÔ HÌNH
 *   Mô hình sinh ra được văn bản, kể cả văn bản trông y hệt một cái nút. Nó
 *   KHÔNG sinh ra được một sự kiện click từ người dùng lên một component mà nó
 *   không điều khiển. Đó là toàn bộ khác biệt giữa hàng rào này và cờ
 *   `xac_nhan` cũ.
 *
 *   Nonce cũng không đi qua đây theo đường mô hình: nó nằm trong
 *   `confirmationStore` (bộ nhớ), và component đọc thẳng từ đó.
 *
 * TỰ ẨN KHI QUÁ HẠN
 *   Nonce sống 5 phút. Để nút bấm nằm đó sau khi nonce chết là mời người dùng
 *   bấm vào một lỗi, nên thẻ tự kiểm mỗi giây và biến mất đúng lúc.
 */
export default function XacNhanPhieuCard({ onXong, organizationId, threadId, generation, availability }: Props) {
  const scope: ConfirmationExecutionContext = { organizationId, threadId, generation };
  const [dangCho, setDangCho] = useState(() => layXacNhanDangCho(Date.now(), undefined, scope));
  const [dangGui, setDangGui] = useState(false);
  const [loi, setLoi] = useState('');

  // Nhịp một giây: đủ để thẻ biến mất gần như ngay khi nonce hết hạn, và rẻ hơn
  // nhiều so với việc dựng một bộ hẹn giờ chính xác cho thứ chỉ sống 5 phút.
  useEffect(() => {
    const t = setInterval(() => setDangCho(layXacNhanDangCho(Date.now(), undefined, scope)), 1000);
    return () => clearInterval(t);
  }, [organizationId, threadId, generation]);

  if (!dangCho) return null;

  const p = dangCho.preview as {
    loai?: string;
    so_tien?: number;
    ten_phieu?: string;
    toa_nha?: string;
    hang_muc?: string;
    ngay?: string;
  };

  const xacNhan = async () => {
    if (dangGui) return;
    setDangGui(true);
    setLoi('');
    // Lấy-và-xoá trong một bước: hai lần bấm nhanh không được cầm cùng một nonce.
    const current = layNguCanhXacNhan();
    if (
      !current ||
      current.organizationId !== organizationId ||
      current.threadId !== threadId ||
      current.generation !== generation ||
      !copilotAvailabilitySnapshotIsFresh(availability) ||
      availability.organizationId !== organizationId
    ) {
      setDangCho(null);
      setDangGui(false);
      return;
    }
    // Kill switch phạm vi action. Khác năm điều kiện ở trên (phạm vi lệch nhau →
    // im lặng bỏ thẻ), đây là một quyết định của người vận hành nên phải NÓI RA:
    // người dùng vừa bấm một cái nút và có quyền biết vì sao không có gì xảy ra.
    if (hanhDongTaoPhieuDaTat(availability)) {
      xoaXacNhanDangCho();
      setLoi(LOI_HANH_DONG_DA_TAT);
      setDangGui(false);
      // Đi qua `onXong` chứ không chỉ `setLoi`: thẻ tự ẩn ở nhịp poll kế tiếp
      // (1 giây) vì đề xuất vừa bị xoá, nên một câu chỉ nằm trong thẻ sẽ biến
      // mất trước khi đọc xong. `onXong` đẩy nó vào khung chat và nó ở lại đó.
      setDangCho(null);
      onXong(`⚠️ ${LOI_HANH_DONG_DA_TAT} Hãy bật lại ở trang quản trị AI Copilot rồi lập lại phiếu.`);
      return;
    }
    const x = tieuXacNhan(Date.now(), undefined, scope);
    if (!x) {
      setDangCho(null);
      setDangGui(false);
      return;
    }
    try {
      const thongBao = await thucThiXacNhan(x.nonce, x.canonical, scope);
      setDangCho(null);
      onXong(thongBao);
    } catch (e) {
      setLoi(e instanceof Error ? e.message : String(e));
      // Nonce đã tiêu và không lấy lại được — nói thẳng là phải lập lại đề xuất
      // thay vì để một cái nút chết nằm đó.
      setDangCho(null);
    } finally {
      setDangGui(false);
    }
  };

  const huy = () => {
    xoaXacNhanDangCho();
    setDangCho(null);
  };

  return (
    <div
      data-testid="copilot-confirm-card"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      <div className="mb-2 font-medium text-amber-900">
        Xác nhận tạo phiếu {p.loai === 'THU' ? 'THU' : 'CHI'}
      </div>
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-amber-900">
        <dt className="text-amber-700">Nội dung</dt>
        <dd>{p.ten_phieu}</dd>
        <dt className="text-amber-700">Số tiền</dt>
        <dd className="font-medium">{formatVND(Number(p.so_tien) || 0)}</dd>
        <dt className="text-amber-700">Toà</dt>
        <dd>{p.toa_nha}</dd>
        <dt className="text-amber-700">Hạng mục</dt>
        <dd>{p.hang_muc}</dd>
        <dt className="text-amber-700">Ngày</dt>
        <dd>{p.ngay}</dd>
      </dl>
      <p className="mb-3 text-xs text-amber-800">
        Phiếu tạo ra là bản CHỜ DUYỆT — chưa duyệt, chưa vào sổ quỹ.
      </p>
      {loi && <p className="mb-2 text-xs text-red-700">{loi}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="copilot-confirm-accept"
          onClick={xacNhan}
          disabled={dangGui}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
        >
          {dangGui ? 'Đang tạo…' : 'Tạo phiếu chờ duyệt'}
        </button>
        <button
          type="button"
          data-testid="copilot-confirm-cancel"
          onClick={huy}
          disabled={dangGui}
          className="rounded-md border border-amber-400 px-3 py-1.5 text-xs font-medium text-amber-900 disabled:opacity-60"
        >
          Huỷ
        </button>
      </div>
    </div>
  );
}
