// Mảnh dựng hình dùng chung cho màn chi tiết hợp đồng bản desktop mới.
//
// VÌ SAO KHÔNG DÙNG <Card> CỦA SHADCN: bản thiết kế là một bố cục DÀY có chủ ý
// — thẻ bo 10px, viền #e2e5ea, đầu thẻ cao 10px/14px, mỗi dòng chỉ 7px đệm dọc.
// Card mặc định của shadcn đệm 24px và bo 8px; đè lại từng thuộc tính còn dài
// hơn tự viết, mà lại che mất chuyện đây là hình dạng riêng của màn này.
// Các primitive tương tác (Dialog, Button trong dialog…) vẫn dùng shadcn.

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function The({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        'overflow-hidden rounded-[10px] border border-[#e2e5ea] bg-white',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DauThe({
  icon: Icon,
  nhan,
  children,
}: {
  icon: LucideIcon;
  nhan: string;
  /** Chip/nút xếp về bên phải đầu thẻ. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-[#eef0f3] px-[var(--px)] py-[13px]">
      <Icon className="h-[17px] w-[17px] shrink-0 text-[#12764a]" strokeWidth={2} />
      <span className="text-[14px] font-bold uppercase tracking-[.06em] text-[#33443c]">
        {nhan}
      </span>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** Nhãn nhóm nhỏ bên trong thẻ ("Hợp đồng", "Dịch vụ", "Lịch sử hợp đồng"). */
export function NhanMuc({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-[var(--px)] pb-[6px] pt-[11px] text-[length:var(--fs-xs)] font-bold uppercase tracking-[.06em] text-[#67737E]">
      {children}
    </div>
  );
}

/** Dòng "nhãn — giá trị" trong thẻ Hợp đồng. Đệm dọc theo biến --rp. */
export function DongKV({
  nhan,
  children,
  className,
}: {
  nhan: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(104px,max-content)_minmax(0,1fr)] gap-3 border-t border-[#f2f4f6] px-[var(--px)] py-[var(--rp)] text-[length:var(--fs)]">
      <span className="text-[#67737E]">{nhan}</span>
      <span className={cn('font-medium tabular-nums', className)}>{children}</span>
    </div>
  );
}

/** Chip nhỏ viền xanh dùng ở đầu thẻ. */
export function ChipXanh({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[5px] border border-[#cfe7db] bg-[#eef7f2] px-2 py-0.5 text-[length:var(--fs-xs)] font-bold text-[#12764a]">
      {children}
    </span>
  );
}

/** Nút vuông 👁 / hành động nhỏ trong bảng và danh sách. */
export function NutTron({
  title,
  onClick,
  children,
  size = 30,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  size?: 28 | 30;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{ height: size, width: size }}
      className="inline-flex items-center justify-center rounded-[5px] border border-[#e2e5ea] bg-white text-[#67737E] transition-colors hover:border-[#cfe7db] hover:bg-[#f1f6f3] hover:text-[#12764a]"
    >
      {children}
    </button>
  );
}
