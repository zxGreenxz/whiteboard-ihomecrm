import type { LucideIcon } from "lucide-react";

/** Hành động hiển thị ở góc phải app-bar khi mở một tab quản trị Sale Phòng. */
export interface HeaderAction {
  label: string;
  onClick: () => void;
  /** Icon riêng (mặc định Plus). */
  icon?: LucideIcon;
  /** Chỉ hiện icon trong nút vuông kiểu .mback (vd. bánh răng "Cài đặt chung"). */
  iconOnly?: boolean;
}
