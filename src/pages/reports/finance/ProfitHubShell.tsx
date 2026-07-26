import * as TabsPrimitive from "@radix-ui/react-tabs";
import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./profitHub.css";

/**
 * Khung trang "Báo cáo Lợi Nhuận" (desktop) theo thiết kế Claude Design:
 * dải hero xanh đậm (thương hiệu + bộ lọc kỳ + tab pill + dải KPI + chip cảnh
 * báo) rồi tới nền sáng #F4F7F5 cho nội dung tab.
 *
 * Mỗi tab tự nạp phần của mình vào hero qua <ProfitHubSlot> (React portal) —
 * portal thay vì state để nội dung hero re-render bình thường theo tab (không
 * lo closure cũ / deps của useEffect). Radix Tabs unmount tab không hoạt động
 * nên mỗi lúc chỉ đúng 1 tab đổ vào hero.
 */

export type ProfitHubSlotName = "actions" | "kpis" | "chips";

type SlotMap = Record<ProfitHubSlotName, HTMLElement | null>;

const SlotContext = createContext<SlotMap>({ actions: null, kpis: null, chips: null });

export function ProfitHubSlot({
  name,
  children,
}: {
  name: ProfitHubSlotName;
  children: ReactNode;
}) {
  const el = useContext(SlotContext)[name];
  return el ? createPortal(children, el) : null;
}

export interface ProfitHubTabDef {
  value: string;
  label: string;
  /** Tab nhạy cảm được mở bằng easter egg → gắn chấm nhắc như bản thiết kế. */
  secret?: boolean;
}

interface ProfitHubShellProps {
  tabs: ProfitHubTabDef[];
  value?: string;
  onValueChange?: (value: string) => void;
  /** Nhấp 3 lần vào logo → hiện/ẩn tab nhạy cảm (giữ nguyên hành vi cũ). */
  onIconClick?: () => void;
  children: ReactNode;
}

const Logo = ({ onClick }: { onClick?: () => void }) => (
  <button type="button" className="ph-brand__icon" onClick={onClick} aria-label="Báo cáo Lợi Nhuận">
    <span
      style={{
        width: 17,
        height: 17,
        borderRadius: "50%",
        border: "4px solid currentColor",
        borderRightColor: "rgba(255,255,255,.25)",
        display: "block",
      }}
    />
  </button>
);

export function ProfitHubShell({
  tabs,
  value,
  onValueChange,
  onIconClick,
  children,
}: ProfitHubShellProps) {
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [kpis, setKpis] = useState<HTMLElement | null>(null);
  const [chips, setChips] = useState<HTMLElement | null>(null);

  const hero = (
    <div className="ph-hero">
      <div className="ph-hero__inner">
        <div className="ph-hero__top">
          <Logo onClick={onIconClick} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ph-brand__title">Báo cáo Lợi Nhuận</div>
            <div className="ph-brand__sub">Báo cáo Tài chính → Lợi nhuận</div>
          </div>
          <div className="ph-hero__actions" ref={setActions} />
        </div>

        {tabs.length > 0 && (
          <TabsPrimitive.List className="ph-tabs">
            {tabs.map((t) => (
              <TabsPrimitive.Trigger key={t.value} value={t.value} className="ph-tab">
                {t.label}
                {t.secret && <span aria-hidden> •</span>}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
        )}

        <div className="ph-kpis" ref={setKpis} />
        <div className="ph-chips" ref={setChips} />
      </div>
    </div>
  );

  return (
    <SlotContext.Provider value={{ actions, kpis, chips }}>
      {tabs.length > 0 ? (
        <TabsPrimitive.Root value={value} onValueChange={onValueChange} className="ph">
          {hero}
          <div className="ph-body">{children}</div>
        </TabsPrimitive.Root>
      ) : (
        <div className="ph">
          {hero}
          <div className="ph-body">{children}</div>
        </div>
      )}
    </SlotContext.Provider>
  );
}

export const ProfitHubTabPanel = TabsPrimitive.Content;

export default ProfitHubShell;
