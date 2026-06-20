import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Search, ChevronDown, X, BarChart3 } from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import { useInvoices } from "@/hooks/useInvoices";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { usePagination } from "@/hooks/usePagination";
import { uniqueRoomNames } from "@/lib/roomSort";
import type {
  InvoiceFilters,
  InvoiceStatus,
  InvoiceWithRelations,
} from "@/types/invoice";
import type { BuildingWithRelations } from "@/types/building";
import type { RoomWithRelations } from "@/types/room";
import InvoiceStatsSummary from "@/components/invoices/InvoiceStatsSummary";
import GenerateInvoiceDialog from "@/components/invoices/GenerateInvoiceDialog";
import MobileListSkeleton from "@/components/mobile/MobileListSkeleton";

const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "tỷ";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "tr";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return n.toLocaleString("vi-VN");
};

const fmtBillingMonth = (m: string | null | undefined) => {
  if (!m) return null;
  const [y, mo] = m.split("-");
  if (!y || !mo) return m;
  return `${parseInt(mo, 10)}/${y}`;
};

const STATUS: Record<
  InvoiceStatus,
  { label: string; c: string; bg: string; line: string }
> = {
  PAID: { label: "Đã thu", c: "#1f9d57", bg: "#e6f5ec", line: "#bfe6cd" },
  PARTIAL_PAID: { label: "Trả 1 phần", c: "#2563eb", bg: "#e7eefc", line: "#c9dafa" },
  OVERDUE: { label: "Quá hạn", c: "#d6453f", bg: "#fcebe9", line: "#f2c8c4" },
  APPROVED: { label: "Đã duyệt", c: "#0ea5e9", bg: "#e0f2fe", line: "#bae6fd" },
  DRAFT: { label: "Nháp", c: "#8a8377", bg: "#efece6", line: "#ddd8cd" },
  CANCELLED: { label: "Đã huỷ", c: "#8a8377", bg: "#efece6", line: "#ddd8cd" },
};

const STAT_TABS: { id: "all" | InvoiceStatus; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "PAID", label: "Đã thu" },
  { id: "PARTIAL_PAID", label: "Trả 1 phần" },
  { id: "OVERDUE", label: "Quá hạn" },
  { id: "DRAFT", label: "Nháp" },
];

/**
 * Hoá đơn — màn hình app full-screen trên mobile (web-app). Dựng theo handoff
 * Claude Design (ui_kits/mobile-app: InvoicesScreen) nối DỮ LIỆU THẬT (useInvoices
 * + lọc toà/phòng/trạng thái/tìm kiếm như desktop). Chạm hàng → /invoices/:id
 * (mở chi tiết mobile). Chạm tiêu đề → báo cáo (InvoiceStatsSummary). Nút ← về
 * trang chủ. Scope .cm-stage/.cm-app, ngoài MainLayout.
 */
export default function InvoicesMobilePage() {
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [roomName, setRoomName] = useState("all");
  const [stat, setStat] = useState<"all" | InvoiceStatus>("all");
  const [pageSize, setPageSize] = useState(30);
  const [createOpen, setCreateOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const { data: buildingsData } = useBuildings();
  const buildings = useMemo(
    () =>
      (Array.isArray(buildingsData) ? buildingsData : []) as unknown as BuildingWithRelations[],
    [buildingsData],
  );
  const { data: roomsData } = useRooms();
  const roomOpts = useMemo(() => {
    const all = (Array.isArray(roomsData) ? roomsData : []) as RoomWithRelations[];
    return uniqueRoomNames(
      buildingId ? all.filter((r) => r.building_id === buildingId) : all,
    );
  }, [roomsData, buildingId]);

  // room_ids: mọi phòng cùng tên (gộp toà) — khớp cơ chế lọc theo TÊN phòng.
  const roomIds = useMemo(() => {
    if (roomName === "all") return undefined;
    const all = (Array.isArray(roomsData) ? roomsData : []) as RoomWithRelations[];
    return all
      .filter(
        (r) =>
          r.name === roomName && (!buildingId || r.building_id === buildingId),
      )
      .map((r) => r.id);
  }, [roomsData, roomName, buildingId]);

  const filters: InvoiceFilters = {
    building_id: buildingId || undefined,
    room_ids: roomIds && roomIds.length ? roomIds : undefined,
    status: stat === "all" ? undefined : stat,
    search: debounced || undefined,
  };

  const statsFilters = {
    building_id: buildingId || undefined,
    room_id: roomIds && roomIds.length === 1 ? roomIds[0] : undefined,
    status: stat === "all" ? undefined : (stat as InvoiceStatus),
  };

  const { data: result, isLoading } = useInvoices(filters, {
    page: 1,
    pageSize,
  });
  const rows = (result?.data ?? []) as InvoiceWithRelations[];
  const totalCount = result?.count ?? 0;

  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, "invoices", "create");

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button
              className="mback"
              onClick={() => navigate("/")}
              aria-label="Về trang chủ"
            >
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <button className="mtitle-btn" onClick={() => setReportOpen(true)}>
                <h1>
                  Hoá đơn
                  <ChevronDown size={17} />
                </h1>
              </button>
              <p>{totalCount} hoá đơn</p>
            </div>
            {canCreate && (
              <div className="mtop-act">
                <button className="mtop-btn" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  Tạo
                </button>
              </div>
            )}
          </div>

          <div className="mbody">
            <div className="lfilter">
              {STAT_TABS.map((t) => (
                <button
                  key={t.id}
                  className={"lchip" + (stat === t.id ? " on" : "")}
                  onClick={() => setStat(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="cm-filterbar">
              <select
                className="cm-select"
                value={buildingId}
                onChange={(e) => {
                  setBuildingId(e.target.value);
                  setRoomName("all");
                }}
                aria-label="Toà nhà"
              >
                <option value="">Tất cả toà</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <select
                className="cm-select"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                aria-label="Phòng"
              >
                <option value="all">Tất cả phòng</option>
                {roomOpts.map((rn) => (
                  <option key={rn} value={rn}>
                    {rn}
                  </option>
                ))}
              </select>
            </div>

            <div className="cm-search">
              <Search />
              <input
                placeholder="Tìm mã HĐ, tên khách, tên phòng…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {isLoading && !result ? (
              <MobileListSkeleton variant="invoice" />
            ) : rows.length === 0 ? (
              <div className="stub">
                <p>Không có hoá đơn nào phù hợp bộ lọc.</p>
              </div>
            ) : (
              <div className="rowlist">
                {rows.map((inv) => {
                  const s = STATUS[inv.status] ?? STATUS.DRAFT;
                  const cancelled = inv.status === "CANCELLED";
                  const bld = inv.building?.name?.trim();
                  const room = inv.room?.name?.trim();
                  const apt =
                    bld && room ? `${bld} - ${room}` : room || bld || "—";
                  const billing = fmtBillingMonth(inv.billing_month);
                  return (
                    <div
                      className={"lrow" + (cancelled ? " off" : "")}
                      key={inv.id}
                      onClick={() => navigate(`/invoices/${inv.id}`)}
                    >
                      <span className="lrow-bar" style={{ background: s.c }} />
                      <div className="lrow-body">
                        <div className="lrow-l1">
                          <span className="lrow-name">{apt}</span>
                          {inv.status !== "APPROVED" && (
                            <span
                              className="pill"
                              style={{ color: s.c, background: s.bg, borderColor: s.line }}
                            >
                              <span className="bd" style={{ background: s.c }} />
                              {s.label}
                            </span>
                          )}
                        </div>
                        <div className="lrow-sub">
                          {billing ? `Kỳ ${billing}` : "—"}
                          {inv.invoice_number ? ` · ${inv.invoice_number}` : ""}
                          {` · Đã thu ${compact(inv.paid_amount || 0)}`}
                        </div>
                      </div>
                      <div className="lrow-r">
                        <span className="lrow-amt">
                          {compact(inv.total_amount || 0)}
                          <small>₫</small>
                        </span>
                      </div>
                    </div>
                  );
                })}
                {totalCount > rows.length && (
                  <button
                    className="loadmore"
                    onClick={() => setPageSize((s) => s + 30)}
                  >
                    Tải thêm ({totalCount - rows.length})
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Báo cáo hoá đơn — bottom sheet (dùng lại thống kê thật) */}
          {reportOpen && (
            <div className="sheet-ov" onClick={() => setReportOpen(false)}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grab" />
                <div className="cmenu-hd">
                  <span className="cmenu-hd-t" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <BarChart3 size={16} style={{ color: "var(--brand-600)" }} />
                    Báo cáo hoá đơn
                  </span>
                  <button
                    className="sheet-x"
                    style={{ marginLeft: "auto" }}
                    onClick={() => setReportOpen(false)}
                    aria-label="Đóng"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div style={{ margin: "0 -18px" }}>
                  <InvoiceStatsSummary filters={statsFilters} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <GenerateInvoiceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
