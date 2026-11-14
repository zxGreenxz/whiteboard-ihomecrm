import * as TabsPrimitive from "@radix-ui/react-tabs";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
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
 * nên mỗi lúc chỉ đúng 1 tab đổ vào hero. Tab giữ sống (`keepMounted`) vẫn mount
 * khi ẩn nên slot tự tắt khi tab đó không mở (ActiveTabContext/PanelContext).
 */

export type ProfitHubSlotName = "actions" | "kpis" | "chips";

type SlotMap = Record<ProfitHubSlotName, HTMLElement | null>;

const SlotContext = createContext<SlotMap>({ actions: null, kpis: null, chips: null });
/** Tab đang mở của shell (undefined = shell không dùng tab). */
const ActiveTabContext = createContext<string | undefined>(undefined);
/** Tab chứa phần tử hiện tại (null = ngoài mọi tab). */
const PanelContext = createContext<string | null>(null);

export function ProfitHubSlot({
  name,
  children,
}: {
  name: ProfitHubSlotName;
  children: ReactNode;
}) {
  const el = useContext(SlotContext)[name];
  const activeTab = useContext(ActiveTabContext);
  const panel = useContext(PanelContext);
  // Tab giữ sống đang ẩn không được đổ KPI/nút của nó lên hero của tab khác.
  if (panel !== null && activeTab !== undefined && panel !== activeTab) return null;
  return el ? createPortal(children, el) : null;
}

export interface ProfitHubTabDef {
  value: string;
  label: string;
}

interface ProfitHubShellProps {
  tabs: ProfitHubTabDef[];
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
}

// Q9: logo chỉ là hình — không còn là nút bí mật mở tab.
const Logo = () => (
  <span className="ph-brand__icon" aria-hidden="true">
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
  </span>
);

export function ProfitHubShell({
  tabs,
  value,
  onValueChange,
  children,
}: ProfitHubShellProps) {
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [kpis, setKpis] = useState<HTMLElement | null>(null);
  const [chips, setChips] = useState<HTMLElement | null>(null);

  const hero = (
    <div className="ph-hero">
      <div className="ph-hero__inner">
        <div className="ph-hero__top">
          <Logo />
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
        <ActiveTabContext.Provider value={value}>
          <TabsPrimitive.Root value={value} onValueChange={onValueChange} className="ph">
            {hero}
            <div className="ph-body">{children}</div>
          </TabsPrimitive.Root>
        </ActiveTabContext.Provider>
      ) : (
        <div className="ph">
          {hero}
          <div className="ph-body">{children}</div>
        </div>
      )}
    </SlotContext.Provider>
  );
}

type ProfitHubTabPanelProps = Omit<
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>,
  "forceMount"
> & {
  /**
   * Giữ tab sống sau lần mở đầu: chuyển sang tab khác rồi quay lại không mất nháp đang
   * nhập (số/lý do điều chỉnh, vùng chọn nhà, tổ chức/tháng). Chưa mở lần nào thì chưa
   * mount ⇒ không tải dữ liệu nặng cho người không vào tab.
   */
  keepMounted?: boolean;
};

export function ProfitHubTabPanel({ value, keepMounted = false, ...props }: ProfitHubTabPanelProps) {
  const activeTab = useContext(ActiveTabContext);
  const isActive = activeTab === value;
  const [visited, setVisited] = useState(isActive);
  useEffect(() => {
    if (isActive) setVisited(true);
  }, [isActive]);
  const keepAlive = keepMounted && (visited || isActive);
  return (
    <PanelContext.Provider value={value}>
      <TabsPrimitive.Content
        value={value}
        {...props}
        // forceMount làm Radix bỏ `hidden` ⇒ tự ẩn khi không phải tab đang mở. Tab không giữ
        // sống thì KHÔNG truyền hidden/forceMount để Radix tự quản như cũ.
        {...(keepAlive ? { forceMount: true as const, hidden: !isActive } : {})}
      />
    </PanelContext.Provider>
  );
}

export default ProfitHubShell;
