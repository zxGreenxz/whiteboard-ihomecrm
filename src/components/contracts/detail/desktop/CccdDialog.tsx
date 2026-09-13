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
        className="mx-auto max-h-[72vh] w-auto max-w-full rounded-lg border border-[#e2e5ea] object-contain"
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
      <DialogContent className="max-w-5xl" aria-describedby={undefined}>
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

        <div className={soMat > 1 ? 'flex gap-4' : ''}>
          {anh.truoc && <Mat nhan="Mặt trước" value={anh.truoc} />}
          {anh.sau && <Mat nhan="Mặt sau" value={anh.sau} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
