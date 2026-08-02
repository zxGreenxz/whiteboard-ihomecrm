import React, { useLayoutEffect, useRef, useState } from "react";
import { Icon, amenIcon } from "./icons";
import {
  STATUS_META, fmtPrice, GENERAL_POLICY,
  type Room, type Building, type FloorPlan as FloorPlanData, type RoomStatus,
} from "./sampleData";
import { useRoomImpression } from "./useTracking";

const SM = STATUS_META;
const stColor = (s: RoomStatus | string) => `var(--st-${s})`;

/* ===== Summary strip ===== */
export function Summary({ rooms }: { rooms: Room[] }) {
  const c: Record<string, number> = { free: 0, soon: 0, rented: 0, pass: 0 };
  rooms.forEach((r) => { c[r.status]++; });
  const items: [RoomStatus, string][] = [["free", "Trống sẵn"], ["soon", "Sắp trống"], ["pass", "Khách pass"], ["rented", "Đã thuê"]];
  return (
    <div className="summary">
      {items.map(([k, lbl]) => (
        <div className="sm-item" key={k}>
          <i className="sm-swatch" style={{ background: stColor(k) }} />
          <span className="sm-num">{c[k]}</span>
          <span className="sm-lbl">{lbl}</span>
        </div>
      ))}
    </div>
  );
}

/* ===== Filter bar ===== */
/** Dải giá (đơn vị: triệu/tháng — Room.price). Biên: đúng 4tr và 5tr thuộc dải giữa. */
export const PRICE_BANDS: { id: string; label: string; test: (p: number) => boolean }[] = [
  { id: "all", label: "Mọi giá", test: () => true },
  { id: "lt4", label: "< 4tr",   test: (p: number) => p < 4 },
  { id: "4-5", label: "4–5tr",   test: (p: number) => p >= 4 && p <= 5 },
  { id: "gt5", label: "> 5tr",   test: (p: number) => p > 5 },
];

export function FilterBar({ showRented, setShowRented, band, setBand }: {
  showRented?: boolean; setShowRented?: (v: boolean) => void;
  band: string; setBand: (v: string) => void;
}) {
  return (
    <div className="filters">
      {PRICE_BANDS.map((b) => (
        <button key={b.id} className={"fchip" + (band === b.id ? " on" : "")} onClick={() => setBand(b.id)}>
          {band === b.id && b.id !== "all" ? <Icon.Money /> : null}{b.label}
        </button>
      ))}
      {setShowRented && (
        <button className={"fchip" + (showRented ? " on" : "")} onClick={() => setShowRented(!showRented)}>
          {showRented ? <Icon.Check /> : <Icon.Dot />} Hiện phòng đã thuê
        </button>
      )}
    </div>
  );
}

/* ===== List view ===== */
export function RoomCard({ r, onOpen }: { r: Room; onOpen: (r: Room) => void }) {
  const impRef = useRoomImpression<HTMLDivElement>(r);
  return (
    <div className="room-card" ref={impRef} onClick={() => onOpen(r)}>
      <div className="rc-photo">
        <img className="rc-img" src={(r.images && r.images[0]) || `https://picsum.photos/seed/${r.code}/600/440`} alt={r.type} loading="lazy" decoding="async" />
        <span className="rc-badge">
          <i className="bd" style={{ background: stColor(r.status) }} />{SM[r.status].label}
        </span>
        <span className="rc-code">{r.code}</span>
        <span className="rc-imgcount"><Icon.Photo />{r.imgCount}</span>
      </div>
      <div className="rc-body">
        <div className="rc-top">
          <span className="rc-price">{fmtPrice(r.price)}<small> tr/th</small></span>
          <span className="rc-loc"><Icon.Pin />Tầng {r.floor}{r.type ? ` · ${r.type}` : ""} · {r.area}m²</span>
        </div>
        <div className="rc-amen">
          {r.amenities.slice(0, 4).map((a) => (<span className="amen" key={a}>{amenIcon(a)}{a}</span>))}
          {r.amenities.length > 4 && <span className="amen">+{r.amenities.length - 4}</span>}
        </div>
        {r.status === "soon" && r.availDate && (
          <div className="rc-avail"><Icon.Calendar />Sắp trống · dự kiến từ {r.availDate}</div>
        )}
      </div>
    </div>
  );
}

export function ListView({ rooms, onOpen }: { rooms: Room[]; onOpen: (r: Room) => void }) {
  if (!rooms.length) {
    return (
      <div className="empty">
        <div className="e-ic">🔍</div>
        <p>Không có phòng nào khớp bộ lọc.<br />Thử bỏ bớt điều kiện lọc nhé.</p>
      </div>
    );
  }
  return (
    <div className="list-wrap">
      {rooms.map((r) => <RoomCard key={r.id} r={r} onOpen={onOpen} />)}
    </div>
  );
}

/* ===== Overview (bảng nhanh tất cả tòa) ===== */
function priceTr(p: number): string {
  const whole = Math.floor(p);
  const dec = Math.round((p - whole) * 10);
  return dec ? `${whole}tr${dec}` : `${whole}tr`;
}

export function OverviewView({
  buildings, showRented, bandTest, onOpen, onQuickDeposit,
}: {
  buildings: Building[];
  showRented: boolean;
  bandTest: (p: number) => boolean;
  onOpen: (r: Room) => void;
  /** Có quyền tạo cọc nhanh → click ô xanh (phòng trống) mở modal tạo cọc. */
  onQuickDeposit?: (r: Room) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const groups = buildings
    .map((b) => ({
      b,
      rooms: b.rooms
        .filter((r) => (r.status === "free" || r.status === "soon" || r.status === "pass" || (showRented && r.status === "rented")) && bandTest(r.price))
        .sort((a, z) => z.floor - a.floor || a.no - z.no),
    }))
    .filter((g) => g.rooms.length);
  const total = groups.reduce((n, g) => n + g.rooms.length, 0);

  const QUICK = 10;

  return (
    <div className="ov-wrap">
      <div className="ov-policy">
        <div className="ov-policy-lbl"><Icon.Info />Thông tin chung</div>
        {GENERAL_POLICY.items.map((t, i) => (<div className="ov-policy-item" key={i}><i />{t}</div>))}
      </div>

      {!total ? (
        <div className="empty"><div className="e-ic">🔍</div><p>Không có phòng nào khớp bộ lọc.</p></div>
      ) : groups.map(({ b, rooms }) => {
        const isOpen = !!open[b.id];
        return (
          <div className="ov-bld" key={b.id}>
            {b.images && b.images.length > 0 && (
              <img
                src={b.images[0]}
                alt={b.name}
                loading="lazy"
                style={{ width: "100%", height: 116, objectFit: "cover", display: "block" }}
              />
            )}
            <div className={"ov-bld-head" + (isOpen ? "" : " closed")} onClick={() => toggle(b.id)}>
              <div className="ovh-top">
                <span className="ovh-name">{b.name}</span>
                <span className="ovh-count">{rooms.filter((r) => r.status === "free" || r.status === "soon" || r.status === "pass").length} trống</span>
                <span className={"ovh-chev" + (isOpen ? " open" : "")}><Icon.Chevron /></span>
              </div>
              <div className="ovh-meta">
                <div className="ovh-line"><Icon.Pin />{b.address}</div>
                <div className="ovh-line ovh-contact">
                  <span className="ovh-ql">QL {b.manager}</span>
                  <a
                    className="ovh-zalo"
                    href={"https://zalo.me/" + b.phone.replace(/\D/g, "")}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon.Chat />Zalo
                  </a>
                  <a className="ovh-call" href={"tel:" + b.phone.replace(/\s/g, "")} onClick={(e) => e.stopPropagation()}>
                    <Icon.Phone /><span className="ovh-phone">{b.phone}</span>
                  </a>
                </div>
                {b.policy && <span className="ovh-policy"><Icon.Tag />{b.policy}</span>}
              </div>
              <div className="ov-quick">
                {rooms.slice(0, QUICK).map((r) => {
                  const depositable = !!onQuickDeposit && r.status === "free";
                  return (
                    <span
                      className={"ovq" + (depositable ? " ovq-dep" : "")}
                      key={r.id}
                      style={{ color: stColor(r.status), background: `var(--st-${r.status}-bg)`, borderColor: `var(--st-${r.status}-line)` }}
                      onClick={depositable ? (e) => { e.stopPropagation(); onQuickDeposit!(r); } : undefined}
                      title={depositable ? "Tạo cọc giữ phòng" : undefined}
                    >
                      {r.no}·{priceTr(r.price)}
                    </span>
                  );
                })}
                {rooms.length > QUICK && <span className="ovq more">+{rooms.length - QUICK}</span>}
              </div>
            </div>
            {isOpen && (
              <div className="ov-rows">
                {rooms.map((r) => (
                  <OvRow key={r.id} r={r} onOpen={onOpen} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 1 hàng phòng trong trang Tổng hợp — tách riêng để gắn impression observer. */
function OvRow({ r, onOpen }: { r: Room; onOpen: (r: Room) => void }) {
  const impRef = useRoomImpression<HTMLDivElement>(r);
  return (
                  <div className={"ov-row" + (r.status === "pass" ? " pass" : "")} ref={impRef} onClick={() => onOpen(r)}>
                    <span className="ovr-bar" style={{ background: stColor(r.status) }} />
                    <div className="ovr-body">
                      <div className="ovr-l1">
                        <span className="ovr-code">{r.code}</span>
                        <span className="ovr-type">{r.type ? `${r.type} · ` : ""}{r.area}m²</span>
                        <span className="ovr-price">{fmtPrice(r.price)}<small>tr</small></span>
                      </div>
                      <div className="ovr-l2">
                        <span className="ovr-amen">{r.amenities.join(", ")}</span>
                        <span className="ovr-status" style={{ color: stColor(r.status) }}>
                          <i style={{ background: stColor(r.status) }} />{SM[r.status].label}
                        </span>
                      </div>
                      {r.status === "pass" && (r.passContactManager || r.passContactPhone || r.passContactName || r.passSalePolicy || r.passAvailDate) && (
                        <div className="ovr-pass">
                          {r.passContactManager ? (
                            <span className="ovr-pass-contact">
                              <Icon.Phone />KHÁCH PASS PHÒNG — LIÊN HỆ QUẢN LÝ
                            </span>
                          ) : (r.passContactPhone || r.passContactName) && (
                            <span className="ovr-pass-contact">
                              <Icon.Phone />KHÁCH PASS PHÒNG — LIÊN HỆ: {r.passContactPhone || "—"}
                              {r.passContactName ? ` (${r.passContactName})` : ""}
                            </span>
                          )}
                          {r.passAvailDate && (
                            <span className="ovr-pass-avail"><Icon.Calendar />Dự kiến trống từ {r.passAvailDate}</span>
                          )}
                          {r.passSalePolicy && (
                            <span className="ovr-pass-policy"><Icon.Tag />{r.passSalePolicy}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <span className="ov-chevron"><Icon.Chevron /></span>
                  </div>
  );
}

/* ===== Floor plan (coordinate canvas, scale-to-fit) ===== */
function FloorCanvas({
  fp, visible, onOpen,
}: {
  fp: FloorPlanData;
  visible: (r: Room) => boolean;
  onOpen: (r: Room) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setScale(Math.min(1, el.clientWidth / fp.canvasW));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fp.canvasW]);

  return (
    <div className="fp-viewport" ref={wrapRef}>
      <div style={{ height: fp.canvasH * scale }}>
        <div className="fp-canvas" style={{ width: fp.canvasW, height: fp.canvasH, transform: `scale(${scale})` }}>
          <div className="fp-corridor" style={{ left: fp.corridor.x, top: fp.corridor.y, width: fp.corridor.w, height: fp.corridor.h }} />
          {fp.fixtures.map((fx) => (
            <div key={fx.id} className="fp-fixture" style={{ left: fx.x, top: fx.y, width: fx.w, height: fx.h }}>
              {fx.kind === "elevator" ? <Icon.Elevator /> : <Icon.Stairs />}
              <span className="fx-lbl">{fx.kind === "elevator" ? "Thang máy" : "Cầu thang"}</span>
            </div>
          ))}
          {fp.rooms.map((r) => {
            const vis = visible(r);
            const clickable = r.status !== "rented" && vis;
            return (
              <button
                key={r.id}
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onOpen(r)}
                title={r.code}
                style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                className={"fp-room " + r.status + (vis ? "" : " dim")}
              >
                <span className="fr-no">{r.no}</span>
                {r.status !== "rented" && <span className="fr-pr">{fmtPrice(r.price)}tr</span>}
                <span className="fr-ar">{r.area}m²{r.type ? ` · ${r.type}` : ""}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function FloorPlan({
  building, showRented, bandTest, onOpen,
}: {
  building: Building;
  showRented: boolean;
  bandTest: (p: number) => boolean;
  onOpen: (r: Room) => void;
}) {
  const visible = (r: Room) => (showRented || r.status !== "rented") && bandTest(r.price);
  return (
    <div className="map-wrap">
      <div className="bld-card">
        <div className="bld-head">
          <span className="bld-name">{building.name}</span>
          <span className="bld-addr">{building.area}</span>
          <span className="bld-stat">{building.freeCount} trống</span>
        </div>
        {building.floors.map((fp) => {
          const avail = fp.rooms.filter((r) => r.status === "free" || r.status === "soon" || r.status === "pass").length;
          return (
            <div className="fp-floor" key={fp.floor}>
              <div className="fp-head">
                <span className="fp-floor-lbl">Tầng {fp.floor}</span>
                <span className="fp-floor-meta">{avail} phòng trống</span>
              </div>
              <FloorCanvas fp={fp} visible={visible} onOpen={onOpen} />
            </div>
          );
        })}
      </div>
      <div className="legend">
        {(Object.keys(SM) as RoomStatus[]).map((k) => (
          <div className="lg-item" key={k}>
            <i className="lg-sw" style={{ background: stColor(k), borderColor: stColor(k) }} />
            {SM[k].label}
          </div>
        ))}
        <div className="lg-item">
          <i className="lg-sw" style={{ background: "var(--surface)", borderColor: "var(--line)" }} />
          Thang máy / Cầu thang
        </div>
      </div>
    </div>
  );
}
