import React, { useEffect, useState, useRef, useLayoutEffect } from "react";
import { Icon, amenIcon } from "./icons";
import { STATUS_META, fmtPrice, MANAGER, type Room, type Building } from "./sampleData";

const SM = STATUS_META;
const stColor = (s: string) => `var(--st-${s})`;

function useDragScroll(ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let down = false, sx = 0, ss = 0, moved = false;
    const d = (e: MouseEvent) => { down = true; moved = false; sx = e.pageX; ss = el.scrollLeft; el.classList.add("dragging"); };
    const m = (e: MouseEvent) => { if (!down) return; const dx = e.pageX - sx; if (Math.abs(dx) > 4) moved = true; el.scrollLeft = ss - dx; };
    const u = () => { down = false; el.classList.remove("dragging"); };
    const c = (e: MouseEvent) => { if (moved) { e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener("mousedown", d);
    window.addEventListener("mousemove", m);
    window.addEventListener("mouseup", u);
    el.addEventListener("click", c, true);
    return () => {
      el.removeEventListener("mousedown", d);
      window.removeEventListener("mousemove", m);
      window.removeEventListener("mouseup", u);
      el.removeEventListener("click", c, true);
    };
  }, [ref]);
}

function Gallery({ images, onZoom }: { images: string[]; onZoom: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDragScroll(ref);
  return (
    <div className="gallery" ref={ref}>
      {images.map((src, i) => (
        <div className="gimg" key={i} onClick={() => onZoom(i)}>
          <img src={src} alt={"Anh " + (i + 1)} draggable={false} />
        </div>
      ))}
    </div>
  );
}

function Lightbox({ images, index, onClose }: { images: string[]; index: number | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDragScroll(ref);
  const [cur, setCur] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && index != null) { el.scrollLeft = index * el.clientWidth; setCur(index); }
  }, [index]);
  const onScroll = () => { const el = ref.current; if (el) setCur(Math.round(el.scrollLeft / el.clientWidth)); };
  return (
    <div className={"lightbox" + (index != null ? " show" : "")} onClick={onClose}>
      <button className="lb-close" onClick={onClose}><Icon.Close /></button>
      <div className="lb-strip" ref={ref} onScroll={onScroll} onClick={(e) => e.stopPropagation()}>
        {images.map((src, i) => (
          <div className="lb-slide" key={i}><img src={src} alt={"Anh " + (i + 1)} /></div>
        ))}
      </div>
      <div className="lb-count">{cur + 1}/{images.length}</div>
    </div>
  );
}

function buildShareText(r: Room): string {
  return [
    `🏠 ${r.buildingName} — Phòng ${r.code}`,
    `• Giá: ${fmtPrice(r.price)} triệu/tháng`,
    `• Diện tích: ${r.area}m²${r.type ? ` · ${r.type}` : ""} · Tầng ${r.floor}`,
    `• Tình trạng: ${SM[r.status].label}${r.availDate ? " (trống từ " + r.availDate + ")" : ""}`,
    `• Tiện ích: ${r.amenities.join(", ")}`,
    ...(r.saleNote ? [`• Khuyến mãi: ${r.saleNote}`] : []),
    `• Địa chỉ: ${r.buildingAddr}`,
  ].join("\n");
}

export function DetailSheet({
  room, show, onClose, onToast, saved, toggleSave, onGo, buildings,
}: {
  room: Room | null;
  show: boolean;
  onClose: () => void;
  onToast: (m: string) => void;
  saved: string[];
  toggleSave: (id: string) => void;
  onGo: (r: Room) => void;
  buildings: Building[];
}) {
  const [lb, setLb] = useState<number | null>(null);
  const rid = room ? room.id : null;
  useEffect(() => { setLb(null); }, [rid]);
  if (!room) return null;
  const r = room;
  const isSaved = saved.includes(r.id);
  const images = r.images && r.images.length
    ? r.images
    : Array.from({ length: r.imgCount }, (_, i) => `https://picsum.photos/seed/${r.code}-${i}/900/650`);

  // Phong cung toa (con trong) de chuyen nhanh truoc/sau
  const building = buildings.find((b) => b.id === r.buildingId);
  const siblings = building
    ? building.rooms.filter((x) => x.status !== "rented").sort((a, b) => b.floor - a.floor || a.no - b.no)
    : [r];
  const idx = siblings.findIndex((x) => x.id === r.id);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;

  const doCopy = async () => {
    try { await navigator.clipboard.writeText(buildShareText(r)); } catch { /* ignore */ }
    onToast("Đã copy thông tin — dán gửi khách ngay");
  };
  const doCall = () => {
    onToast("Đang gọi " + MANAGER.name + " để giữ phòng…");
    window.location.href = "tel:" + MANAGER.phone.replace(/\s/g, "");
  };
  const doZalo = () => {
    window.open("https://zalo.me/" + MANAGER.zalo.replace(/\s/g, ""), "_blank");
  };
  const doRoute = () => {
    window.open("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(r.buildingAddr), "_blank");
  };
  const doShare = async () => {
    const text = buildShareText(r);
    if (navigator.share) {
      try { await navigator.share({ title: r.buildingName + " · " + r.code, text }); return; } catch { /* */ }
    }
    try { await navigator.clipboard.writeText(text); } catch { /* */ }
    onToast("Đã copy link & thông tin phòng");
  };

  return (
    <>
      <div className={"sheet-scrim" + (show ? " show" : "")} onClick={onClose} />
      <div className={"sheet" + (show ? " show" : "")}>
        <div className="sheet-grab" />
        <div className="sheet-scroll">
          <Gallery images={images} onZoom={setLb} />

          <div className="sheet-body">
            <div className="sh-head">
              <div>
                <div className="sh-price">{fmtPrice(r.price)}<small> triệu/tháng</small></div>
                <div className="sh-sub">{r.buildingName} · Phòng {r.code}</div>
              </div>
              <span className="sh-statbadge" style={{
                background: `var(--st-${r.status}-bg)`, color: stColor(r.status),
                border: `1px solid var(--st-${r.status}-line)`,
              }}>
                <i className="bd" style={{ background: stColor(r.status) }} />{SM[r.status].label}
              </span>
            </div>

            <div className="specs">
              <div className="spec"><div className="sp-lbl">Diện tích</div><div className="sp-val">{r.area}<small>m²</small></div></div>
              <div className="spec"><div className="sp-lbl">Loại phòng</div><div className="sp-val">{r.type || "—"}</div></div>
              <div className="spec"><div className="sp-lbl">Vị trí</div><div className="sp-val">T{r.floor}</div></div>
            </div>

            {r.status === "soon" && r.availDate && (
              <div className="note-box">
                <Icon.Calendar />
                {`Phòng sắp trống — dự kiến bàn giao từ ${r.availDate}. Có thể nhận booking & đặt lịch dẫn khách xem sớm.`}
              </div>
            )}

            {r.saleNote && (
              <div className="note-box" style={{ background: "var(--st-free-bg)", borderColor: "var(--st-free-line)", color: "var(--st-free)" }}>
                <Icon.Money />
                <span><b>Khuyến mãi:</b> {r.saleNote}</span>
              </div>
            )}

            <p className="sh-section-lbl">Tiện ích</p>
            <div className="amen-grid">
              {r.amenities.map((a) => (<span className="amen-pill" key={a}>{amenIcon(a)}{a}</span>))}
            </div>

            {r.description && (
              <>
                <p className="sh-section-lbl">Mô tả</p>
                <p style={{ margin: "0 0 2px", color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>{r.description}</p>
              </>
            )}

            <p className="sh-section-lbl">Địa chỉ</p>
            <div className="amen-grid">
              <span className="amen-pill"><Icon.Pin />{r.buildingAddr}</span>
            </div>
          </div>

          <div className="sh-actions2">
            <button className="act2" onClick={doCopy}><Icon.Copy />Copy gửi khách</button>
            <button className="act2" onClick={doRoute}><Icon.Route />Chỉ đường</button>
            <button className="act2" onClick={doShare}><Icon.Share />Chia sẻ</button>
            <button className="act2" onClick={doZalo} style={{ color: "#0068ff" }}><Icon.Bell />Zalo</button>
          </div>
        </div>

        <div className="sh-actions">
          <button className="btn btn-primary" onClick={doCall}><Icon.Phone />Gọi giữ phòng</button>
          <button className="btn btn-nav prev" disabled={!prev} onClick={() => prev && onGo(prev)} title="Phòng trước">
            <Icon.Chevron />
          </button>
          <button className="btn btn-nav" disabled={!next} onClick={() => next && onGo(next)} title="Phòng sau">
            <Icon.Chevron />
          </button>
          <button className="btn btn-ghost" onClick={() => { toggleSave(r.id); onToast(isSaved ? "Đã bỏ lưu" : "Đã lưu phòng quan tâm"); }}>
            {isSaved ? <Icon.HeartFill style={{ color: "var(--st-soon)" }} /> : <Icon.Heart />}
          </button>
        </div>
      </div>
      <Lightbox images={images} index={lb} onClose={() => setLb(null)} />
    </>
  );
}

export function Toast({ msg, show }: { msg: string; show: boolean }) {
  return (<div className={"toast" + (show ? " show" : "")}><Icon.Check />{msg}</div>);
}
