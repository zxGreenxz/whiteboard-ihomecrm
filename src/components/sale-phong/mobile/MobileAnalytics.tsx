import { useMemo, useState } from "react";
import { format, subDays, parseISO } from "date-fns";
import { Eye, Clock, DoorOpen, Layers, Phone, Heart } from "lucide-react";
import {
  usePraSummary, usePraTimeseries, usePraTopRooms, usePraFunnel, usePraByToken,
  usePraErrorGroups,
  type PraFilters, type PraTimeseriesRow, type PraErrorSource,
} from "@/hooks/usePublicRoomsAnalytics";
import { fmtDuration, parseUA } from "../analyticsUtils";

const fmtDay = (iso: string) => { try { return format(parseISO(iso), "dd/MM"); } catch { return iso; } };
const roomName = (r: { room_code: string | null; room_name: string | null }) => r.room_code || r.room_name || "(đã xoá)";

type AnTab = "overview" | "rooms" | "hours" | "links" | "errors";
const RANGES = [{ d: 7, l: "7 ngày" }, { d: 30, l: "30 ngày" }, { d: 90, l: "90 ngày" }];
const TABS: { k: AnTab; l: string }[] = [
  { k: "overview", l: "Tổng quan" }, { k: "rooms", l: "Phòng xem nhiều" },
  { k: "hours", l: "Theo giờ" }, { k: "links", l: "Theo link" },
  { k: "errors", l: "Lỗi" },
];
/** Mặc định "Lỗi ứng dụng": nhóm ngoài app (WebView Zalo…) áp đảo về số lượng
 *  nhưng không sửa được, để chung sẽ lấp mất lỗi thật. */
const SOURCES: { k: PraErrorSource | "all"; l: string }[] = [
  { k: "app", l: "Lỗi app" }, { k: "external", l: "Ngoài app" }, { k: "all", l: "Tất cả" },
];

/** Đường + vùng tô cho biểu đồ lưu lượng (viewBox 0 0 320 110). */
function buildPaths(values: number[]) {
  if (values.length < 2) return { line: "", area: "" };
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 320;
    const y = 105 - (v / max) * 95;
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L320 110 L0 110 Z`;
  return { line, area };
}

export default function MobileAnalytics() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<AnTab>("overview");
  const [errSource, setErrSource] = useState<PraErrorSource | "all">("app");

  const filters: PraFilters = useMemo(() => {
    const today = new Date();
    return { start: format(subDays(today, days - 1), "yyyy-MM-dd"), end: format(today, "yyyy-MM-dd") };
  }, [days]);

  const summary = usePraSummary(filters);
  const tsDay = usePraTimeseries(filters, "day");
  const tsHour = usePraTimeseries(filters, "hour");
  const funnel = usePraFunnel(filters);
  const topRooms = usePraTopRooms(filters, 50);
  const byToken = usePraByToken(filters);
  const errGroups = usePraErrorGroups(filters, errSource, 30);
  const s = summary.data;

  const tsData = tsDay.data || [];
  const paths = useMemo(() => buildPaths(tsData.map((r) => r.sessions)), [tsData]);
  const ticks = useMemo(() => {
    if (tsData.length === 0) return [];
    const idx = [0, Math.floor(tsData.length / 3), Math.floor((2 * tsData.length) / 3), tsData.length - 1];
    return [...new Set(idx)].map((i) => fmtDay(tsData[i].bucket));
  }, [tsData]);

  const byHour = useMemo(() => {
    const acc = new Array(24).fill(0);
    for (const r of (tsHour.data || []) as PraTimeseriesRow[]) {
      const m = /T(\d{2})/.exec(r.bucket);
      if (m) acc[Number(m[1])] += r.sessions;
    }
    return acc;
  }, [tsHour.data]);
  const maxHour = Math.max(1, ...byHour);

  const rooms = useMemo(() => [...(topRooms.data || [])].sort((a, b) => b.open_count - a.open_count).slice(0, 8), [topRooms.data]);
  const maxOpen = Math.max(1, ...rooms.map((r) => r.open_count));

  const errors = errGroups.data || [];

  const links = useMemo(() => [...(byToken.data || [])].sort((a, b) => b.sessions - a.sessions).slice(0, 10), [byToken.data]);
  const maxLink = Math.max(1, ...links.map((l) => l.sessions));
  const linkColors = ["var(--acc-violet)", "var(--acc-blue)", "var(--brand)", "var(--soon)", "var(--acc-cyan)"];

  const kpis = [
    { ic: <Eye size={15} />, bg: "rgba(37,99,235,.12)", fg: "var(--acc-blue)", n: String(s?.total_sessions ?? 0), l: "Lượt xem trang" },
    { ic: <Clock size={15} />, bg: "rgba(31,157,87,.12)", fg: "var(--free)", n: fmtDuration(s?.avg_session_ms ?? 0), l: "TG xem TB · phút:giây" },
    { ic: <DoorOpen size={15} />, bg: "rgba(217,119,6,.12)", fg: "var(--acc-amber)", n: String(s?.room_opens ?? 0), l: "Mở chi tiết phòng" },
    { ic: <Layers size={15} />, bg: "rgba(124,58,237,.12)", fg: "var(--acc-violet)", n: String(s?.impressions ?? 0), l: "Lượt hiển thị phòng" },
    { ic: <Phone size={15} />, bg: "rgba(31,157,87,.12)", fg: "var(--free)", n: String(s?.contact_clicks ?? 0), l: "Bấm liên hệ · gọi/Zalo" },
    { ic: <Heart size={15} />, bg: "rgba(71,85,105,.12)", fg: "var(--acc-slate)", n: String(s?.favorites ?? 0), l: "Phòng quan tâm (lưu)" },
  ];

  const funnelStages = [
    { label: "Xem trang", value: funnel.data?.sessions ?? 0, color: "var(--acc-blue)" },
    { label: "Hiển thị phòng", value: funnel.data?.sessions_impression ?? 0, color: "var(--acc-violet)" },
    { label: "Mở chi tiết", value: funnel.data?.sessions_opened_room ?? 0, color: "var(--acc-amber)" },
    { label: "Bấm liên hệ", value: funnel.data?.sessions_contacted ?? 0, color: "var(--free)" },
  ];
  const funnelTop = funnelStages[0].value || 1;

  return (
    <div style={{ padding: "14px 16px 28px" }}>
      <div className="sp-range">
        {RANGES.map((r) => (
          <button key={r.d} className={days === r.d ? "on" : ""} onClick={() => setDays(r.d)}>{r.l}</button>
        ))}
      </div>
      <div className="sp-scrolltabs">
        {TABS.map((t) => (
          <button key={t.k} className={tab === t.k ? "on" : ""} onClick={() => setTab(t.k)}>{t.l}</button>
        ))}
      </div>

      {tab === "overview" && (
        <>
          <div className="sp-kpis">
            {kpis.map((k, i) => (
              <div key={i} className="sp-kpi">
                <span className="kic" style={{ background: k.bg, color: k.fg }}>{k.ic}</span>
                <div className="kn">{k.n}</div>
                <div className="kl">{k.l}</div>
              </div>
            ))}
          </div>

          <div className="sp-chartcard">
            <div className="ct">Lưu lượng theo ngày</div>
            {tsData.length < 2 ? (
              <p className="sp-hint" style={{ margin: 0 }}>Chưa đủ dữ liệu trong kỳ.</p>
            ) : (
              <>
                <svg viewBox="0 0 320 110" preserveAspectRatio="none" style={{ width: "100%", height: 120, display: "block" }}>
                  <path d={paths.area} fill="rgba(31,122,82,.13)" />
                  <path d={paths.line} fill="none" stroke="var(--brand)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
                  {ticks.map((t, i) => <span key={i} style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 600, color: "var(--ink-3)" }}>{t}</span>)}
                </div>
              </>
            )}
          </div>

          <div className="sp-chartcard" style={{ marginBottom: 0 }}>
            <div className="ct">Phễu tương tác</div>
            <div className="sp-funnel">
              {funnelStages.map((st) => {
                const pct = Math.round((st.value / funnelTop) * 100);
                return (
                  <div key={st.label} className="sp-funnel-row">
                    <span className="fl">{st.label}</span>
                    <div className="ftrack">
                      <div className="ffill" style={{ width: `${pct}%`, background: st.color }} />
                      <span className="fv">{st.value} · {pct}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {tab === "rooms" && (
        <div className="sp-chartcard" style={{ marginBottom: 0 }}>
          <div className="ct">Top phòng theo lượt mở chi tiết</div>
          {rooms.length === 0 ? <p className="sp-hint" style={{ margin: 0 }}>Chưa có dữ liệu.</p> : (
            <div className="sp-bars">
              {rooms.map((r, i) => (
                <div key={r.room_id ?? i}>
                  <div className="sp-bar-h">
                    <span className="rk">{i + 1}</span>
                    <span className="nm">{roomName(r)}</span>
                    <span className="sub">· {r.building_name ?? ""}</span>
                    <span className="val" style={{ color: "var(--acc-amber)" }}>{r.open_count}</span>
                  </div>
                  <div className="sp-bartrack" style={{ marginLeft: 28 }}>
                    <div className="fill" style={{ width: `${(r.open_count / maxOpen) * 100}%`, background: "var(--acc-amber)" }} />
                  </div>
                  <div style={{ display: "flex", gap: 12, margin: "6px 0 0 28px", fontSize: 10.5, fontWeight: 600, color: "var(--ink-3)" }}>
                    <span>TG xem {fmtDuration(r.total_dwell_ms)}</span><span>Liên hệ {r.contact_clicks}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "hours" && (
        <div className="sp-chartcard" style={{ marginBottom: 0 }}>
          <div className="ct">Phân bố theo giờ trong ngày</div>
          <p className="sp-hint" style={{ margin: "0 0 14px" }}>Số lượt xem trang theo từng giờ (gộp cả kỳ).</p>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 130 }}>
            {byHour.map((v, h) => (
              <div key={h} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end" }}>
                <div style={{ width: "100%", height: `${(v / maxHour) * 100}%`, minHeight: 3, background: v === maxHour && v > 0 ? "var(--brand)" : "var(--brand-100)", borderRadius: "3px 3px 0 0" }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", marginTop: 6 }}>
            {byHour.map((_, h) => (
              <span key={h} style={{ flex: 1, textAlign: "center", fontFamily: "var(--mono)", fontSize: 9, fontWeight: 600, color: "var(--ink-3)" }}>{h % 6 === 0 ? `${h}h` : ""}</span>
            ))}
          </div>
        </div>
      )}

      {tab === "links" && (
        <div className="sp-chartcard" style={{ marginBottom: 0 }}>
          <div className="ct">Lượt xem theo link chia sẻ</div>
          {links.length === 0 ? <p className="sp-hint" style={{ margin: 0 }}>Chưa có dữ liệu.</p> : (
            <div className="sp-bars">
              {links.map((l, i) => (
                <div key={l.token}>
                  <div className="sp-bar-h">
                    <span className="nm" style={{ fontFamily: "var(--font)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{l.label || `(${l.token.slice(0, 6)})`}</span>
                    {l.revoked && <span className="pill rented" style={{ fontSize: 9.5, padding: "1px 6px" }}>thu hồi</span>}
                    <span className="val" style={{ color: "var(--acc-violet)" }}>{l.sessions}</span>
                  </div>
                  <div className="sp-bartrack">
                    <div className="fill" style={{ width: `${(l.sessions / maxLink) * 100}%`, background: linkColors[i % linkColors.length] }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "errors" && (
        <div className="sp-chartcard" style={{ marginBottom: 0 }}>
          <div className="ct">Nhóm lỗi trang công khai</div>
          <p className="sp-hint" style={{ margin: "0 0 10px" }}>
            {s?.error_groups ?? 0} lỗi ứng dụng ({s?.errors ?? 0} lượt phiên dính) ·{" "}
            {s?.error_groups_external ?? 0} lỗi ngoài app (script do trình duyệt in-app
            tiêm vào — không sửa được từ phía mình).
          </p>
          <div className="sp-range" style={{ marginBottom: 12 }}>
            {SOURCES.map((x) => (
              <button key={x.k} className={errSource === x.k ? "on" : ""} onClick={() => setErrSource(x.k)}>{x.l}</button>
            ))}
          </div>
          {errors.length === 0 ? (
            <p className="sp-hint" style={{ margin: 0 }}>Không có lỗi nào trong kỳ — tốt!</p>
          ) : (
            <div className="sp-bars">
              {errors.map((e) => (
                <div key={e.fingerprint}>
                  <div className="sp-bar-h">
                    <span className="nm" style={{ fontFamily: "var(--font)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                      {e.message ?? "(không có thông điệp)"}
                    </span>
                    <span className="val" style={{ color: e.source === "external" ? "var(--acc-amber)" : "var(--red)" }}>
                      {e.total_count}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 10.5, fontWeight: 600, color: "var(--ink-3)" }}>
                    <span>{e.kind ?? "—"}</span>
                    <span>{e.sessions} phiên</span>
                    <span>{parseUA(e.sample_user_agent)}</span>
                    <span>{fmtDay(e.last_seen)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
