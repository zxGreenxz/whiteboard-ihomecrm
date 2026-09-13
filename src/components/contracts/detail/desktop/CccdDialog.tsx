// Xem ảnh CCCD của khách NGAY TẠI màn hợp đồng (chủ yêu cầu 13/09/2026).
//
// Trước đây muốn đối chiếu giấy tờ phải rời màn hợp đồng sang /customers/:id —
// mất ngữ cảnh đang xem, xong lại phải quay về. Nút ảnh nằm ngay sau số CCCD,
// bấm là mở lớn tại chỗ.
//
// Hộp thoại có HAI phần và cả hai đều cần:
//   · khối thông tin đã nhập vào hệ thống (tên, ngày sinh, CCCD, ngày cấp, địa
//     chỉ) — đặt TRÊN ảnh để đối chiếu trong một nhịp;
//   · ảnh hai mặt, phóng to hết cỡ vì ảnh chụp điện thoại hay mờ ở chữ nhỏ.
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
import { thongTinGiayTo, type KhachChoGiayTo } from './idCardInfo';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  khach: KhachChoGiayTo;
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

export function CccdDialog({ open, onOpenChange, khach, anh }: Props) {
  const soMat = [anh.truoc, anh.sau].filter(Boolean).length;
  const muc = thongTinGiayTo(khach);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Gần hết màn hình (chủ yêu cầu 13/09: "cho mở gần full luôn tầm 80–90%").
          KHÔNG đặt max-width cố định: bản trước kẹp 1500px, trên màn rộng
          (~2500px CSS) hộp thoại chỉ còn chiếm 59% bề ngang — đúng cái chủ kêu
          "khung còn nhỏ quá". `max-w-none` để huỷ trần mặc định của shadcn. */}
      <DialogContent
        className="max-h-[94vh] w-[90vw] max-w-none overflow-y-auto"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-base">
            Ảnh giấy tờ — {khach.full_name || 'khách thuê'}
          </DialogTitle>
        </DialogHeader>

        {muc.length > 0 && (
          <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-[#e2e5ea] bg-[#f9fafb] px-5 py-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            {muc.map((m) => (
              <div key={m.nhan} className="min-w-0">
                <dt className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-[#67737E]">
                  {m.nhan}
                </dt>
                <dd
                  className={`m-0 mt-1 text-[15px] font-medium text-[#121f17] ${
                    m.nhan === 'Số CCCD' ? 'font-mono tracking-[.02em]' : ''
                  }`}
                >
                  {m.gia}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <div className={soMat > 1 ? 'flex gap-5' : ''}>
          {anh.truoc && <Mat nhan="Mặt trước" value={anh.truoc} />}
          {anh.sau && <Mat nhan="Mặt sau" value={anh.sau} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
