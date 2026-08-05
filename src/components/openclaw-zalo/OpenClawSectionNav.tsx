import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  BookOpenText,
  CalendarClock,
  ChevronUp,
  Inbox,
  LayoutDashboard,
  MoreHorizontal,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type OpenClawSection =
  | "overview"
  | "inbox"
  | "automation"
  | "knowledge"
  | "schedules"
  | "operations";

interface SectionDefinition {
  id: OpenClawSection;
  label: string;
  mobileLabel: string;
  icon: LucideIcon;
}

const OPENCLAW_SECTIONS: readonly SectionDefinition[] = [
  { id: "overview", label: "Tổng quan", mobileLabel: "Tổng quan", icon: LayoutDashboard },
  { id: "inbox", label: "Hộp thư", mobileLabel: "Hộp thư", icon: Inbox },
  { id: "automation", label: "Tự động hóa", mobileLabel: "Tự động", icon: Bot },
  { id: "knowledge", label: "Tri thức", mobileLabel: "Tri thức", icon: BookOpenText },
  { id: "schedules", label: "Lịch & Nhóm sale", mobileLabel: "Lịch & Nhóm sale", icon: CalendarClock },
  { id: "operations", label: "Vận hành", mobileLabel: "Vận hành", icon: Settings2 },
] as const;

interface OpenClawSectionNavProps {
  activeSection: OpenClawSection;
  onSectionChange: (section: OpenClawSection) => void;
  mobile: boolean;
}

export default function OpenClawSectionNav({
  activeSection,
  onSectionChange,
  mobile,
}: OpenClawSectionNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);

  if (!mobile) {
    return (
      <nav
        aria-label="Khu vực OpenClaw Zalo"
        data-openclaw-nav="desktop"
        className="grid grid-cols-6 border-b border-[#bdc9d2] bg-[#fffdf8]"
      >
        {OPENCLAW_SECTIONS.map(section => {
          const Icon = section.icon;
          const active = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSectionChange(section.id)}
              aria-current={active ? "page" : undefined}
              // Hook cho E2E. Đặt trên NÚT ĐIỀU HƯỚNG chứ không phải panel nội
              // dung: cockpit là dạng tab, mỗi lúc chỉ một panel được mount, nên
              // khẳng định "sáu khu vực đều có mặt" chỉ đo được ở thanh nav —
              // nơi cả sáu thật sự hiện cùng lúc (grid-cols-6).
              data-openclaw-section={section.id}
              className={cn(
                "flex min-h-14 min-w-0 items-center justify-center gap-2 border-r border-[#d5dde3] px-2 py-2 text-xs font-bold text-[#4b6172] last:border-r-0 hover:bg-[#edf4f2] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0f766e] xl:text-sm",
                active && "bg-[#dfeee9] text-[#0b5d51]",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 leading-tight">{section.label}</span>
            </button>
          );
        })}
      </nav>
    );
  }

  const primarySections = OPENCLAW_SECTIONS.slice(0, 3);
  const secondarySections = OPENCLAW_SECTIONS.slice(3);
  const secondaryActive = secondarySections.some(section => section.id === activeSection);

  return (
    <nav
      aria-label="Điều hướng OpenClaw Zalo trên điện thoại"
      data-openclaw-nav="mobile"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[#aebdc8] bg-[#fffdf8] pb-[env(safe-area-inset-bottom)]"
    >
      <div
        aria-hidden={!moreOpen}
        className={cn(
          "absolute bottom-full right-2 w-[min(19rem,calc(100vw-1rem))] border border-[#aebdc8] bg-[#fffdf8] p-2",
          !moreOpen && "hidden",
        )}
      >
        {secondarySections.map(section => {
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => {
                onSectionChange(section.id);
                setMoreOpen(false);
              }}
              // KHÔNG mang data-openclaw-nav-item: đây là bảng "Thêm" bung ra,
              // không phải một trong bốn mục của thanh dưới. Gắn vào sẽ làm bài
              // đo bốn-mục đếm thành bảy và phải sửa số cho vừa — đúng kiểu làm
              // yếu bài test cho nó xanh.
              data-openclaw-section={section.id}
              className={cn(
                "flex min-h-11 w-full items-center gap-3 border-b border-[#e0e5e9] px-3 text-left text-sm font-semibold text-[#334e68] last:border-b-0",
                activeSection === section.id && "bg-[#dfeee9] text-[#0b5d51]",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {section.mobileLabel}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-4">
        {primarySections.map(section => {
          const Icon = section.icon;
          const active = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => {
                onSectionChange(section.id);
                setMoreOpen(false);
              }}
              aria-current={active ? "page" : undefined}
              data-openclaw-nav-item={section.id}
              data-openclaw-section={section.id}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] font-bold text-[#5b6f7e]",
                active && "bg-[#dfeee9] text-[#0b5d51]",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {section.mobileLabel}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(open => !open)}
          aria-expanded={moreOpen}
          // Mục thứ tư của thanh dưới. Nó KHÔNG phải một khu vực nên không mang
          // data-openclaw-section — chỉ mở bảng chứa ba khu vực còn lại.
          data-openclaw-nav-item="more"
          className={cn(
            "flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] font-bold text-[#5b6f7e]",
            (moreOpen || secondaryActive) && "bg-[#dfeee9] text-[#0b5d51]",
          )}
        >
          <span className="relative">
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            {moreOpen && <ChevronUp className="absolute -right-2 -top-1 h-3 w-3" aria-hidden="true" />}
          </span>
          Thêm
        </button>
      </div>
    </nav>
  );
}
