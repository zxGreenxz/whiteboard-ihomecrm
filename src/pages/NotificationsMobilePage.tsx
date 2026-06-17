import { useMemo, useState } from "react";
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

type NotifMeta = { label: string; Icon: typeof Bell; c: string; bg: string; line: string };

const NT_META: Record<string, NotifMeta> = {
  NEW_INVOICE: { label: "Hóa đơn mới", Icon: Receipt, c: "#2563eb", bg: "#e7eefc", line: "#c9dafa" },
  PAYMENT_REMINDER: { label: "Nhắc thanh toán", Icon: Clock, c: "#ea580c", bg: "#fdecdc", line: "#f8d4b0" },
  OVERDUE_INVOICE: { label: "Quá hạn", Icon: AlertTriangle, c: "#dc2626", bg: "#fde8e6", line: "#f5c4bf" },
  CONTRACT_EXPIRING: { label: "Hợp đồng hết hạn", Icon: CalendarClock, c: "#9333ea", bg: "#f3e8fd", line: "#e2cbf8" },
  ISSUE_RESOLVED: { label: "Công việc", Icon: CheckCircle2, c: "#16a34a", bg: "#e6f5ec", line: "#bfe6cd" },
  GENERAL_ANNOUNCEMENT: { label: "Thông báo chung", Icon: Megaphone, c: "#52525b", bg: "#f4f4f5", line: "#e4e4e7" },
  DEPOSIT_SHORTFALL: { label: "Thiếu cọc", Icon: AlertCircle, c: "#d97706", bg: "#fbf1da", line: "#f0dca8" },
  CUSTOM: { label: "Thông báo", Icon: Bell, c: "#52525b", bg: "#f4f4f5", line: "#e4e4e7" },
};
const metaOf = (t: NotificationType | string): NotifMeta => NT_META[t] || NT_META.CUSTOM;

const TYPE_CHIPS: { v: NotificationType | "all"; label: string }[] = [
  { v: "all", label: "Tất cả" },
  { v: "NEW_INVOICE", label: "Hóa đơn mới" },
  { v: "PAYMENT_REMINDER", label: "Nhắc thanh toán" },
  { v: "OVERDUE_INVOICE", label: "Quá hạn" },
  { v: "CONTRACT_EXPIRING", label: "HĐ hết hạn" },
  { v: "DEPOSIT_SHORTFALL", label: "Thiếu cọc" },
  { v: "ISSUE_RESOLVED", label: "Công việc" },
  { v: "GENERAL_ANNOUNCEMENT", label: "Thông báo chung" },
];

const linkOf = (n: Notification): { Icon: typeof Bell; to: string; label: string } | null => {
  if (n.invoice_id) return { Icon: Receipt, to: `/invoices/${n.invoice_id}`, label: "Xem hóa đơn" };
  if (n.contract_id) return { Icon: FileText, to: `/contracts/${n.contract_id}`, label: "Xem hợp đồng" };
  if (n.issue_id) return { Icon: CheckCircle2, to: `/issues/${n.issue_id}`, label: "Xem công việc" };
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
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const deleteNotification = useDeleteNotification();

  const [tab, setTab] = useState<"all" | "unread">("all");
  const [type, setType] = useState<NotificationType | "all">("all");
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

  const current = sel ? list.find((n) => n.id === sel) : undefined;

  const openDetail = (n: Notification) => {
    if (n.status !== "READ") markAsRead.mutate(n.id);
    setSel(n.id);
  };

  // ---- Chi tiết bản tin ----
  if (current) {
    const meta = metaOf(current.type);
    const HeroIcon = meta.Icon;
    const link = linkOf(current);
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
              {TYPE_CHIPS.map((c) => (
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
