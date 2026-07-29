import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCheck,
  X,
  Clock,
  Receipt,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Sparkles,
  Megaphone,
  Bell,
  AlertCircle,
  FileText,
  ChevronRight,
  Trash2,
} from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/dashboardMobile.css";
import {
  useNotifications,
  useMarkAsRead,
  useMarkAllAsRead,
  useDeleteNotification,
  type Notification,
  type NotificationType,
} from "@/hooks/useNotifications";
import { format, formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { usePersistedState } from "@/hooks/usePersistedState";
import { resolveNotificationUrl } from "@/lib/notificationRoutes";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import type { PermsLike } from "@/lib/permissionPages";

type NotifMeta = { label: string; Icon: typeof Bell; c: string; bg: string; line: string };

const NT_META: Record<string, NotifMeta> = {
  // Amber = "còn việc phải làm" (khớp badge Chờ duyệt của phiếu thu chi).
  ACTION_REQUIRED: { label: "Chờ tôi xử lý", Icon: ClipboardCheck, c: "#d97706", bg: "#fdf0d9", line: "#f2d9a4" },
  APPROVAL_RESULT: { label: "Kết quả duyệt", Icon: CheckCircle2, c: "#059669", bg: "#e3f6ee", line: "#b9e7d6" },
  NEW_INVOICE: { label: "Hóa đơn mới", Icon: Receipt, c: "#2563eb", bg: "#e7eefc", line: "#c9dafa" },
  PAYMENT_REMINDER: { label: "Nhắc thanh toán", Icon: Clock, c: "#ea580c", bg: "#fdecdc", line: "#f8d4b0" },
  OVERDUE_INVOICE: { label: "Quá hạn", Icon: AlertTriangle, c: "#dc2626", bg: "#fde8e6", line: "#f5c4bf" },
  CONTRACT_EXPIRING: { label: "Hợp đồng hết hạn", Icon: CalendarClock, c: "#9333ea", bg: "#f3e8fd", line: "#e2cbf8" },
  ISSUE_RESOLVED: { label: "Công việc", Icon: CheckCircle2, c: "#16a34a", bg: "#e6f5ec", line: "#bfe6cd" },
  GENERAL_ANNOUNCEMENT: { label: "Thông báo chung", Icon: Megaphone, c: "#52525b", bg: "#f4f4f5", line: "#e4e4e7" },
  DEPOSIT_SHORTFALL: { label: "Thiếu cọc", Icon: AlertCircle, c: "#d97706", bg: "#fbf1da", line: "#f0dca8" },
  SALARY_BONUS: { label: "Thưởng/Lương", Icon: Sparkles, c: "#059669", bg: "#e3f6ee", line: "#b9e7d6" },
  CUSTOM: { label: "Thông báo", Icon: Bell, c: "#52525b", bg: "#f4f4f5", line: "#e4e4e7" },
};
const metaOf = (t: NotificationType | string): NotifMeta => NT_META[t] || NT_META.CUSTOM;

const TYPE_CHIPS: { v: NotificationType | "all"; label: string }[] = [
  { v: "all", label: "Tất cả" },
  { v: "ACTION_REQUIRED", label: "Chờ tôi xử lý" },
  { v: "APPROVAL_RESULT", label: "Kết quả duyệt" },
  { v: "PAYMENT_REMINDER", label: "Nhắc thanh toán" },
  { v: "OVERDUE_INVOICE", label: "Quá hạn" },
  { v: "CONTRACT_EXPIRING", label: "HĐ hết hạn" },
  { v: "DEPOSIT_SHORTFALL", label: "Thiếu cọc" },
  { v: "SALARY_BONUS", label: "Thưởng/Lương" },
  { v: "NEW_INVOICE", label: "Hóa đơn mới" },
  { v: "ISSUE_RESOLVED", label: "Công việc" },
  { v: "GENERAL_ANNOUNCEMENT", label: "Thông báo chung" },
  { v: "CUSTOM", label: "Thông báo" },
];
const CHIP_VALUES = new Set<string>(TYPE_CHIPS.map((c) => String(c.v)));

const linkOf = (
  n: Notification,
  perms: PermsLike,
): { Icon: typeof Bell; to: string; label: string } | null => {
  // metadata.url ĐỨNG TRƯỚC mọi nhánh id — nơi phát sự kiện mới biết đích đúng.
  const url = resolveNotificationUrl(n.metadata?.url, perms);
  if (url) {
    if (url.startsWith("/invoices/")) return { Icon: Receipt, to: url, label: "Xem hóa đơn" };
    if (url.startsWith("/contracts/")) return { Icon: FileText, to: url, label: "Xem hợp đồng" };
    if (url.startsWith("/tasks")) return { Icon: ClipboardCheck, to: url, label: "Xem công việc" };
    if (url.startsWith("/finance/salary")) return { Icon: Sparkles, to: url, label: "Xem bảng lương" };
    return { Icon: ChevronRight, to: url, label: "Xem chi tiết" };
  }
  if (n.invoice_id) return { Icon: Receipt, to: `/invoices/${n.invoice_id}`, label: "Xem hóa đơn" };
  if (n.contract_id) return { Icon: FileText, to: `/contracts/${n.contract_id}`, label: "Xem hợp đồng" };
  // Nhánh issue_id ĐÃ XOÁ: route /issues/:id không tồn tại trong App.tsx — nút cũ
  // dẫn thẳng vào trang trắng.
  return null;
};

const relTime = (iso: string) => {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: vi });
  } catch {
    return "";
  }
};

/**
 * Bản tin (Thông báo) — màn hình app full-screen trên mobile (web-app). Dựng
 * theo handoff Claude Design (ui_kits/mobile-app: NotificationsScreen +
 * NotificationDetailScreen) nối DỮ LIỆU THẬT (useNotifications + mutations).
 * Danh sách: tab Tất cả/Chưa đọc + lọc theo loại + thẻ thông báo (chấm chưa
 * đọc, badge loại, trích nội dung, nút xoá). Chạm thẻ → chi tiết trong trang
 * (hero theo loại, nội dung đầy đủ, nút "Xem hóa đơn/hợp đồng/công việc" theo
 * liên kết, nút xoá). Nút ← về trang chủ. Scope .cm-stage/.cm-app.
 */
export default function NotificationsMobilePage() {
  const navigate = useNavigate();
  const { data: list = [] } = useNotifications();
  // Allow-list URL cần quyền của người bấm (route bị chặn → hạ về /my-day).
  const { data: perms } = useMyPermissions();
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const deleteNotification = useDeleteNotification();

  const [tab, setTab] = usePersistedState<"all" | "unread">("flt:notifications-mb:tab", "all");
  const [type, setType] = usePersistedState<NotificationType | "all">("flt:notifications-mb:type", "all");
  const [sel, setSel] = useState<string | null>(null);

  const unread = useMemo(() => list.filter((n) => n.status !== "READ").length, [list]);

  const rows = useMemo(
    () =>
      list.filter((n) => {
        if (tab === "unread" && n.status === "READ") return false;
        if (type !== "all" && n.type !== type) return false;
        return true;
      }),
    [list, tab, type],
  );

  // Đếm theo loại: chip nào 0 dòng thì ẩn (không xoá khỏi TYPE_CHIPS — có dữ liệu là
  // tự hiện lại). Màn hình điện thoại chỉ đủ chỗ cho vài chip, bày 12 chip rỗng là nhiễu.
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of list) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return m;
  }, [list]);

  const chips = useMemo(
    () => TYPE_CHIPS.filter((c) => c.v === "all" || (typeCounts.get(c.v) ?? 0) > 0 || type === c.v),
    [typeCounts, type],
  );

  // 🔴 Bẫy "màn hình rỗng vĩnh viễn": chip đã lưu trong sessionStorage có thể không còn
  // trong danh sách đang render (loại bị gỡ, hoặc chip bị ẩn vì 0 dòng). Thiếu nhánh hạ
  // về "all", người từng chọn chip đó mở app chỉ thấy khoảng trắng và KHÔNG còn nút nào
  // để bấm quay lại.
  useEffect(() => {
    if (type === "all") return;
    if (!CHIP_VALUES.has(type)) {
      setType("all");
      return;
    }
    // Chỉ kết luận "chip rỗng" khi đã có dữ liệu — lần render đầu list rỗng, kết luận
    // sớm sẽ xoá oan lựa chọn hợp lệ.
    if (list.length > 0 && (typeCounts.get(type) ?? 0) === 0) setType("all");
  }, [type, setType, list.length, typeCounts]);

  const current = sel ? list.find((n) => n.id === sel) : undefined;

  const openDetail = (n: Notification) => {
    if (n.status !== "READ") markAsRead.mutate(n.id);
    setSel(n.id);
  };

  // ---- Chi tiết bản tin ----
  if (current) {
    const meta = metaOf(current.type);
    const HeroIcon = meta.Icon;
    const link = linkOf(current, perms);
    const paragraphs = (current.content || "").split("\n");
    return (
      <div className="cm-stage">
        <div className="cm-app">
          <div className="route route-anim">
            <div className="mtop">
              <button className="mback" onClick={() => setSel(null)} aria-label="Quay lại">
                <ArrowLeft />
              </button>
              <div className="mtitle">
                <h1>Chi tiết bản tin</h1>
                <p>{meta.label}</p>
              </div>
            </div>

            <div className="mbody">
              <div className="ntd-hero" style={{ background: meta.bg, borderColor: meta.line }}>
                <span className="ntd-hero-ic" style={{ background: meta.c, color: "#fff" }}>
                  <HeroIcon size={24} />
                </span>
                <div className="ntd-hero-badge" style={{ color: meta.c }}>
                  {meta.label}
                </div>
                <h2 className="ntd-subj">{current.subject || meta.label}</h2>
                <div className="ntd-time">
                  <Clock size={13} />
                  {format(new Date(current.created_at), "dd/MM/yyyy HH:mm", { locale: vi })} · {relTime(current.created_at)}
                </div>
              </div>

              {current.content ? (
                <div className="ntd-content">
                  {paragraphs.map((p, i) =>
                    p.trim() === "" ? <div key={i} style={{ height: 8 }} /> : <p key={i}>{p}</p>,
                  )}
                </div>
              ) : null}

              <div className="ntd-acts">
                {link ? (
                  <button className="ntd-cta" onClick={() => navigate(link.to)}>
                    <link.Icon size={17} />
                    {link.label}
                    <ChevronRight size={16} style={{ marginLeft: "auto", opacity: 0.8 }} />
                  </button>
                ) : null}
                <button
                  className="ntd-del"
                  onClick={() => {
                    deleteNotification.mutate(current.id);
                    setSel(null);
                  }}
                >
                  <Trash2 size={16} />
                  Xoá thông báo
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Danh sách bản tin ----
  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Bản tin</h1>
              <p>{unread > 0 ? `${unread} thông báo chưa đọc` : "Đã đọc hết thông báo"}</p>
            </div>
            {unread > 0 && (
              <div className="mtop-act">
                <button
                  className="mtop-btn ghost"
                  onClick={() => markAllAsRead.mutate()}
                  disabled={markAllAsRead.isPending}
                >
                  <CheckCheck size={15} />
                  Đã đọc
                </button>
              </div>
            )}
          </div>

          <div className="mbody">
            <div className="ntseg">
              <button className={"ntseg-b" + (tab === "all" ? " on" : "")} onClick={() => setTab("all")}>
                Tất cả
                <span className="ntseg-n">{list.length}</span>
              </button>
              <button className={"ntseg-b" + (tab === "unread" ? " on" : "")} onClick={() => setTab("unread")}>
                Chưa đọc
                <span className="ntseg-n">{unread}</span>
              </button>
            </div>

            <div className="ntfilter">
              {chips.map((c) => (
                <button
                  key={c.v}
                  className={"ntfchip" + (type === c.v ? " on" : "")}
                  onClick={() => setType(c.v)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {rows.length === 0 ? (
              <div className="stub" style={{ padding: "52px 24px" }}>
                <Bell size={26} style={{ color: "var(--ink-faint)" }} />
                <p style={{ fontWeight: 700, color: "var(--ink-2)" }}>Không có thông báo</p>
                <p>{tab === "unread" ? "Bạn đã đọc hết tất cả thông báo." : "Chưa có thông báo nào."}</p>
              </div>
            ) : (
              <div className="rowlist">
                {rows.map((n) => {
                  const meta = metaOf(n.type);
                  const Ico = meta.Icon;
                  const un = n.status !== "READ";
                  return (
                    <div className={"ntcard" + (un ? " unread" : "")} key={n.id} onClick={() => openDetail(n)}>
                      <span className="ntcard-ic" style={{ color: meta.c, background: meta.bg }}>
                        <Ico size={18} />
                      </span>
                      <div className="ntcard-body">
                        <div className="ntcard-top">
                          <span
                            className="ntcard-badge"
                            style={{ color: meta.c, background: meta.bg, borderColor: meta.line }}
                          >
                            {meta.label}
                          </span>
                          <span className="ntcard-ago">{relTime(n.created_at)}</span>
                          {un ? <span className="ntcard-dot" /> : null}
                        </div>
                        {n.subject ? <div className="ntcard-subj">{n.subject}</div> : null}
                        <div className="ntcard-snip">{(n.content || "").replace(/\n+/g, " ")}</div>
                      </div>
                      <button
                        className="ntcard-x"
                        aria-label="Xoá"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteNotification.mutate(n.id);
                        }}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
