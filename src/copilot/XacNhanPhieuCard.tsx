import { useEffect, useState } from 'react';

import { formatVND } from '@/lib/utils';
import { layXacNhanDangCho, tieuXacNhan, xoaXacNhanDangCho } from './confirmationStore';
import { thucThiXacNhan } from './tools/writeTools';

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
export default function XacNhanPhieuCard({ onXong }: { onXong: (thongBao: string) => void }) {
  const [dangCho, setDangCho] = useState(() => layXacNhanDangCho());
  const [dangGui, setDangGui] = useState(false);
  const [loi, setLoi] = useState('');

  // Nhịp một giây: đủ để thẻ biến mất gần như ngay khi nonce hết hạn, và rẻ hơn
  // nhiều so với việc dựng một bộ hẹn giờ chính xác cho thứ chỉ sống 5 phút.
  useEffect(() => {
    const t = setInterval(() => setDangCho(layXacNhanDangCho()), 1000);
    return () => clearInterval(t);
  }, []);

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
    const x = tieuXacNhan();
    if (!x) {
      setDangCho(null);
      setDangGui(false);
      return;
    }
    try {
      const thongBao = await thucThiXacNhan(x.nonce, x.canonical);
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
