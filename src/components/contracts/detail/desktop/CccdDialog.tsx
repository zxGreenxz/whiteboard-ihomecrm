// Xem ảnh CCCD của khách NGAY TẠI màn hợp đồng (chủ yêu cầu 13/09/2026).
//
// Trước đây muốn đối chiếu giấy tờ phải rời màn hợp đồng sang /customers/:id —
// mất ngữ cảnh đang xem, xong lại phải quay về. Nút ảnh nằm ngay sau số CCCD,
// bấm là mở lớn tại chỗ.
//
// Ảnh nằm trong bucket private nên phải qua <StorageImage> để ký URL; dùng
// <img> thẳng sẽ ra ảnh hỏng.

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StorageImage } from '@/components/ui/storage-image';
import type { AnhCccd } from './tenantMetaLines';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenKhach: string;
  soCccd: string | null;
  anh: AnhCccd;
}

function Mat({ nhan, value }: { nhan: string; value: string }) {
  return (
    <figure className="m-0 min-w-0 flex-1">
      <figcaption className="mb-1.5 text-[13px] font-medium text-[#67737E]">
        {nhan}
      </figcaption>
      <StorageImage
        value={value}
        alt={nhan}
        // `object-contain` chứ không `cover`: ảnh CCCD chụp đủ kiểu tỉ lệ, cắt
        // đi là mất đúng góc có số hoặc dấu mộc.
        // `w-auto mx-auto` chứ không `w-full`: ảnh chụp dọc (rất phổ biến — khách
        // gửi ảnh chụp bằng điện thoại) mà ép rộng hết ô thì hai bên là hai dải
        // xám to hơn cả tấm ảnh.
        className="mx-auto max-h-[80vh] w-auto max-w-full rounded-lg border border-[#e2e5ea] object-contain"
        fallback={
          <div className="flex h-[40vh] items-center justify-center rounded-lg border border-[#e2e5ea] bg-[#f4f6f8] text-[13px] text-[#67737E]">
            Đang tải ảnh…
          </div>
        }
      />
    </figure>
  );
}

export function CccdDialog({ open, onOpenChange, tenKhach, soCccd, anh }: Props) {
  const soMat = [anh.truoc, anh.sau].filter(Boolean).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Khung rộng gần hết màn (chủ yêu cầu 13/09: "cho hiển thị lớn ra").
          Ảnh CCCD chụp bằng điện thoại thường mờ ở chữ nhỏ — phóng to là cách
          duy nhất đọc được số giấy tờ và ngày cấp mà không phải tải về. */}
      <DialogContent
        className="max-h-[94vh] w-[96vw] max-w-[1500px] overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-base">
            Ảnh giấy tờ — {tenKhach}
            {soCccd && (
              <span className="ml-2 font-mono text-[13px] font-normal text-[#67737E]">
                {soCccd}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className={soMat > 1 ? 'flex gap-5' : ''}>
          {anh.truoc && <Mat nhan="Mặt trước" value={anh.truoc} />}
          {anh.sau && <Mat nhan="Mặt sau" value={anh.sau} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
