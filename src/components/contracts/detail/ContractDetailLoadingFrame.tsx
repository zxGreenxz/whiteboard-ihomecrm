// Khung trang chi tiết hợp đồng lúc CHƯA có dữ liệu hợp đồng (chủ chốt 02/10/2026).
//
// Trước đây cả màn chỉ có một dòng "Đang tải thông tin hợp đồng…" trên nền trắng.
// Nay khung trang hiện ngay — thanh trên có nút quay lại/đóng và tiêu đề (mã HĐ nếu
// nơi mở đã biết, không thì "Chi tiết hợp đồng") — chỗ dữ liệu là khối xám do
// `children` (QueryRegion skeleton="detail") vẽ, lỗi thật cũng hiện trong khung này.

import type { CSSProperties, ReactNode } from 'react';
import { ArrowLeft, FileText, X } from 'lucide-react';
import '@/pages/contracts/contractDetailMobile.css';
import { KHUNG } from './desktop/ContractTopBar';

interface Props {
  isMobile: boolean;
  /** Mã HĐ đã biết từ nơi mở (dòng danh sách); thiếu thì hiện "Chi tiết hợp đồng". */
  title?: string | null;
  onBack: () => void;
  children: ReactNode;
}

export function ContractDetailLoadingFrame({ isMobile, title, onBack, children }: Props) {
  if (isMobile) {
    return (
      <div className="cdt-stage">
        <div className="cdt-app">
          <div className="route route-anim">
            <div className="mtop">
              <button className="mback" onClick={onBack} aria-label="Quay lại"><ArrowLeft /></button>
              <div className="mtitle">
                {title ? (
                  <>
                    <h1>{title}</h1>
                    <p>Chi tiết hợp đồng</p>
                  </>
                ) : (
                  <h1 className="cdt-title-plain">Chi tiết hợp đồng</h1>
                )}
              </div>
            </div>
            <div className="mbody"><div className="cd-card">{children}</div></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-full bg-[#f4f6f8] text-[#121f17]"
      style={{ '--px': '18px' } as CSSProperties}
    >
      {/* Cùng nền, cùng chiều cao tầng 1 với ContractTopBar để lúc dữ liệu về màn không nhảy. */}
      <div className="sticky top-0 z-30 bg-[#11231b]">
        <div className={`${KHUNG} flex items-center gap-2.5 py-3`}>
          <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg bg-white/[.09]">
            <FileText className="h-[17px] w-[17px] text-[#4fbf87]" strokeWidth={2} />
          </div>
          <span className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.01em] text-white">
            {title || 'Chi tiết hợp đồng'}
          </span>
          <button
            type="button"
            title="Đóng"
            aria-label="Đóng"
            onClick={onBack}
            className="ml-auto inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-md border border-white/[.16] text-[#cfd8d3] transition-colors hover:bg-white/[.14] hover:text-white"
          >
            <X className="h-[17px] w-[17px]" strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className={`${KHUNG} pb-12 pt-4`}>
        <div className="rounded-[10px] bg-white p-3">{children}</div>
      </div>
    </div>
  );
}
