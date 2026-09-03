// Modal nhập PIN step-up (G5-A, điểm nối #3) — bốn ô số, mở khi `KeHoachCard`
// thấy kế hoạch có bước L5 dưới trần L5.
//
// VÌ SAO MỘT DIV NỔI, KHÔNG DÙNG `@/components/ui/dialog`
//   Mọi thẻ Copilot khác (`KeHoachCard`, `XacNhanPhieuCard`) đều là card nội
//   tuyến, không phải overlay Radix — giữ cùng khuôn để không kéo thêm focus
//   trap/portal chỉ cho MỘT màn hình, và để test render được mà không cần dựng
//   thêm hạ tầng Radix trong môi trường test.
//
// VÌ SAO PIN KHÔNG NẰM TRONG STATE LÂU HƠN MỨC CẦN
//   `pin` chỉ sống trong state của modal này, mất khi modal đóng (unmount).
//   Token trả về từ `xacThucPin` không bao giờ chạm state của component này —
//   nó đi thẳng vào `confirmationStore` bên trong `stepUpClient.ts` (xem chú
//   thích ở đầu file đó). Modal chỉ biết "xong" hay "chưa", không cầm token.
import { useEffect, useRef, useState } from 'react';

import { xacThucPin } from './plan/stepUpClient';

const SO_O = 4;

/** Chỉ giữ ký tự số, cắt về đúng 4 ký tự. */
function locSo(gt: string): string {
  return gt.replace(/[^0-9]/g, '').slice(0, SO_O);
}

interface Props {
  organizationId: string;
  /** Gọi sau khi xác thực THÀNH CÔNG — token đã nằm trong confirmationStore. */
  onXacThucXong: () => void;
  onHuy: () => void;
}

/**
 * Modal nhập PIN — bốn ô `inputmode="numeric"` `autocomplete="one-time-code"`,
 * tự dồn thành một chuỗi 4 số, hiện số lần thử còn lại / thời gian khoá lấy từ
 * `xacThucPin`.
 */
export default function StepUpPinModal({ organizationId, onXacThucXong, onHuy }: Props) {
  const [oSo, setOSo] = useState<string[]>(() => Array(SO_O).fill(''));
  const [dangGui, setDangGui] = useState(false);
  const [loi, setLoi] = useState('');
  const oRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    oRefs.current[0]?.focus();
  }, []);

  const pin = oSo.join('');
  const duDo = pin.length === SO_O;

  const datO = (chiSo: number, gt: string) => {
    const so = locSo(gt);
    setOSo((truoc) => {
      const ke = [...truoc];
      if (so.length <= 1) {
        ke[chiSo] = so;
        return ke;
      }
      // Dán cả chuỗi (paste) vào một ô — rải từ ô hiện tại trở đi.
      for (let i = 0; i < so.length && chiSo + i < SO_O; i += 1) {
        ke[chiSo + i] = so[i] ?? '';
      }
      return ke;
    });
    if (so.length >= 1 && chiSo < SO_O - 1) {
      oRefs.current[chiSo + 1]?.focus();
    }
  };

  const banPhim = (chiSo: number, phim: string) => {
    if (phim === 'Backspace' && !oSo[chiSo] && chiSo > 0) {
      oRefs.current[chiSo - 1]?.focus();
    }
  };

  const gui = async () => {
    if (dangGui || !duDo) return;
    setDangGui(true);
    setLoi('');
    const kq = await xacThucPin(pin, organizationId);
    setDangGui(false);
    if (!kq.ok) {
      const phan: string[] = [];
      if (kq.thongBao) phan.push(kq.thongBao);
      if (kq.soLanConLai !== null) phan.push(`Còn ${kq.soLanConLai} lần thử.`);
      if (kq.khoaConGiay !== null) phan.push(`Thử lại sau ${kq.khoaConGiay} giây.`);
      setLoi(phan.join(' ') || 'Không xác thực được PIN.');
      setOSo(Array(SO_O).fill(''));
      oRefs.current[0]?.focus();
      return;
    }
    onXacThucXong();
  };

  return (
    <div
      data-testid="copilot-step-up-modal"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-xs rounded-lg bg-white p-4 shadow-lg">
        <div className="mb-1 text-sm font-medium text-slate-900">Xác thực PIN</div>
        <p className="mb-3 text-xs text-slate-600">
          Bước này đòi xác thực hai lớp trước khi duyệt. Nhập mã PIN 4 số của bạn.
        </p>
        <div className="mb-3 flex justify-center gap-2">
          {oSo.map((gt, i) => (
            <input
              key={i}
              ref={(el) => {
                oRefs.current[i] = el;
              }}
              data-testid={`copilot-step-up-digit-${i}`}
              type="password"
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              maxLength={SO_O}
              value={gt}
              disabled={dangGui}
              onChange={(e) => datO(i, e.target.value)}
              onKeyDown={(e) => banPhim(i, e.key)}
              className="h-11 w-11 rounded-md border border-slate-300 text-center text-lg font-semibold focus:border-slate-500 focus:outline-none disabled:opacity-60"
            />
          ))}
        </div>
        {loi && (
          <p className="mb-3 text-xs text-red-700" data-testid="copilot-step-up-loi">
            {loi}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="copilot-step-up-submit"
            onClick={() => void gui()}
            disabled={!duDo || dangGui}
            className="flex-1 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            {dangGui ? 'Đang xác thực…' : 'Xác thực'}
          </button>
          <button
            type="button"
            data-testid="copilot-step-up-cancel"
            onClick={onHuy}
            disabled={dangGui}
            className="rounded-md border border-slate-400 px-3 py-1.5 text-xs font-medium text-slate-800 disabled:opacity-60"
          >
            Huỷ
          </button>
        </div>
      </div>
    </div>
  );
}
