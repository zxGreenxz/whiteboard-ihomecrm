import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, FileSpreadsheet, Zap, Droplet, ChevronRight, X, Gauge } from "lucide-react";
import "@/styles/mobileApp.css";
import "@/styles/financeMobile.css";
import "@/styles/estateMobile.css";
import { useMeterReadingsList, useMeterReadingStats } from "@/hooks/useMeterReadings";
import { type MeterReadingFilters } from "@/components/meter-readings/MeterReadingFilters";
import { useBuildings } from "@/hooks/useBuildings";
import { usePagination } from "@/hooks/usePagination";
import { usePersistedState } from "@/hooks/usePersistedState";
import MeterReadingForm from "@/components/meter-readings/MeterReadingForm";
import MeterReadingImportDialog from "@/components/meter-readings/MeterReadingImportDialog";
import type { BuildingWithRelations } from "@/types/building";

const currentMonth = new Date().toISOString().slice(0, 7);

const compactNum = (n: number | null | undefined) => {
  if (!n) return "0";
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(n));
};

function buildMonths() {
  const now = new Date();
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: `Tháng ${d.getMonth() + 1}/${d.getFullYear()}`,
    });
  }
  return out;
}

const TABS: { id: "all" | "APPROVED" | "UNAPPROVED"; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "APPROVED", label: "Đã duyệt" },
  { id: "UNAPPROVED", label: "Chưa duyệt" },
];

/**
 * Ghi chỉ số — màn hình app full-screen mobile (web-app). Dựng theo handoff
 * Claude Design (iHomeCRM Mobile.dc.html · 1f). Nối dữ liệu thật:
 * useMeterReadingsList + useMeterReadingStats + lọc persisted như desktop.
 * Thêm chỉ số / Import dùng lại dialog desktop. Scope .cm-stage/.cm-app.
 */
export default function MeterReadingsMobilePage() {
  const navigate = useNavigate();
  const months = useMemo(buildMonths, []);

  const [filters, setFilters] = usePersistedState<MeterReadingFilters>("flt:meter-readings:filters", {
    building_id: null,
    room_id: null,
    meter_type: null,
    month: currentMonth,
    status: null,
  });

  const [fabOpen, setFabOpen] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const pagination = usePagination(30);

  const { data: buildingsData = [] } = useBuildings();
  const buildings = buildingsData as BuildingWithRelations[];

  const { data: listResult, isLoading } = useMeterReadingsList(
    {
      building_id: filters.building_id ?? undefined,
      meter_type: filters.meter_type ?? undefined,
      month: filters.month || undefined,
      status: filters.status ?? undefined,
    },
    { page: pagination.page, pageSize: pagination.pageSize },
  );
  const readings = listResult?.data ?? [];
  const totalCount = listResult?.totalCount ?? 0;

  const { data: stats } = useMeterReadingStats(filters.building_id ?? undefined, filters.month);
  const approved = stats?.approved_count ?? 0;
  const unapproved = stats?.unapproved_count ?? 0;
  const elec = stats?.electricity_consumption ?? 0;

  const monthLabel = months.find((m) => m.value === filters.month)?.label ?? `Tháng ${filters.month}`;

  const patch = (p: Partial<MeterReadingFilters>) => {
    setFilters({ ...filters, ...p });
    pagination.setPage(1);
  };

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/")} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Ghi chỉ số</h1>
              <p>{monthLabel} · {totalCount} chỉ số</p>
            </div>
            <div className="mtop-act">
              <button className="mtop-btn ghost" onClick={() => setIsImportOpen(true)} aria-label="Nhập từ Excel">
                <FileSpreadsheet />
              </button>
            </div>
          </div>

          <div className="mbody">
            <div className="cm-filterbar">
              <select className="cm-select" aria-label="Tháng" value={filters.month} onChange={(e) => patch({ month: e.target.value })}>
                {months.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select
                className="cm-select"
                aria-label="Toà nhà"
                value={filters.building_id ?? ""}
                onChange={(e) => patch({ building_id: e.target.value || null })}
              >
                <option value="">Tất cả toà</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code || b.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="bm-stats">
              <div className="bm-stat" style={{ "--bmc": "#15803d" } as React.CSSProperties}>
                <div className="n">{approved}</div>
                <div className="l">Đã duyệt</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#b45309" } as React.CSSProperties}>
                <div className="n">{unapproved}</div>
                <div className="l">Chưa duyệt</div>
              </div>
              <div className="bm-stat" style={{ "--bmc": "#2563eb" } as React.CSSProperties}>
                <div className="n">{compactNum(elec)}</div>
                <div className="l">kWh điện</div>
              </div>
            </div>

            <div className="lfilter">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className={"lchip" + ((filters.status ?? "all") === t.id ? " on" : "")}
                  onClick={() => patch({ status: t.id === "all" ? null : t.id })}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {isLoading ? (
              <div className="stub"><p>Đang tải chỉ số…</p></div>
            ) : readings.length === 0 ? (
              <div className="stub"><p>Chưa có chỉ số nào cho bộ lọc này. Thêm chỉ số qua nút (+).</p></div>
            ) : (
              <div className="rowlist">
                {readings.map((m) => {
                  const water = m.meter_type === "WATER";
                  const unit = m.meter_type === "ELECTRICITY" ? "kWh" : "m³";
                  const ok = m.status === "APPROVED";
                  return (
                    <div className="mtr" key={m.id}>
                      <span className={"mtr-ic " + (water ? "water" : "elec")}>
                        {water ? <Droplet /> : <Zap />}
                      </span>
                      <div className="mtr-body">
                        <div className="mtr-l1">
                          <span className="mtr-room">{m.room_name}</span>
                          <span className={"mtr-badge " + (ok ? "ok" : "no")}>{ok ? "Đã duyệt" : "Chưa duyệt"}</span>
                        </div>
                        <div className="mtr-sub">{[m.reading_code, m.building_name, m.meter_name].filter(Boolean).join(" · ")}</div>
                        <div className="mtr-reads">
                          {m.previous_reading?.toLocaleString("vi-VN")}
                          <ChevronRight />
                          <b>{m.current_reading?.toLocaleString("vi-VN")}</b>
                        </div>
                      </div>
                      <div className="mtr-r">
                        <div className="mtr-cons">
                          {compactNum(m.consumption)}
                          <small>{unit}</small>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {totalCount > readings.length && (
                  <button className="loadmore" onClick={() => pagination.setPageSize(pagination.pageSize + 30)}>
                    Xem thêm ({totalCount - readings.length})
                  </button>
                )}
              </div>
            )}
          </div>

          <button className={"fab" + (fabOpen ? " open" : "")} onClick={() => setFabOpen((o) => !o)} aria-label="Thêm chỉ số">
            <Plus />
          </button>

          {fabOpen && (
            <div className="sheet-ov" onClick={() => setFabOpen(false)}>
              <div className="sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grab" />
                <div className="cmenu-hd">
                  <span className="cmenu-hd-t">Ghi chỉ số</span>
                  <button className="sheet-x" style={{ marginLeft: "auto" }} onClick={() => setFabOpen(false)} aria-label="Đóng">
                    <X size={18} />
                  </button>
                </div>
                <div className="cmenu">
                  <button
                    className="cmenu-opt"
                    onClick={() => {
                      setFabOpen(false);
                      setIsFormOpen(true);
                    }}
                  >
                    <span className="cmenu-ic" style={{ background: "#e7eefc", color: "#2563eb" }}><Gauge size={19} /></span>
                    <span className="cmenu-tx">
                      <span className="cmenu-t">Thêm chỉ số</span>
                      <span className="cmenu-s">Nhập chỉ số điện / nước một phòng</span>
                    </span>
                  </button>
                  <button
                    className="cmenu-opt"
                    onClick={() => {
                      setFabOpen(false);
                      setIsImportOpen(true);
                    }}
                  >
                    <span className="cmenu-ic" style={{ background: "#e8f3ec", color: "#1f7a52" }}><FileSpreadsheet size={19} /></span>
                    <span className="cmenu-tx">
                      <span className="cmenu-t">Nhập từ Excel</span>
                      <span className="cmenu-s">Import cả toà nhà theo mẫu</span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Thêm chỉ số / Import — dùng lại dialog desktop */}
      <MeterReadingForm open={isFormOpen} onOpenChange={setIsFormOpen} reading={null} />
      <MeterReadingImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  );
}
