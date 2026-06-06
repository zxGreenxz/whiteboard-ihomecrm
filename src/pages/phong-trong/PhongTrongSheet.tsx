import React from "react";
import { Icon, amenIcon } from "./icons";
import { STATUS_META, fmtPrice, MANAGER, type Room } from "./sampleData";

const SM = STATUS_META;
const stColor = (s: string) => `var(--st-${s})`;

function buildShareText(r: Room): string {
  return [
    `🏠 ${r.buildingName} — Phòng ${r.code}`,
    `• Giá: ${fmtPrice(r.price)} triệu/tháng`,
    `• Diện tích: ${r.area}m² · ${r.type} · Tầng ${r.floor}`,
    `• Tình trạng: ${SM[r.status].label}${r.availDate ? " (trống từ " + r.availDate + ")" : ""}`,
    `• Tiện ích: ${r.amenities.join(", ")}`,
    `• Địa chỉ: ${r.buildingAddr}`,
  ].join("\n");
}

export function DetailSheet({
  room, show, onClose, onToast, saved, toggleSave,
}: {
  room: Room | null;
  show: boolean;
  onClose: () => void;
  onToast: (m: string) => void;
  saved: string[];
  toggleSave: (id: string) => void;
}) {
  if (!room) return null;
  const r = room;
  const isSaved = saved.includes(r.id);
  const phs = ["ph-a", "ph-b", "ph-c", "ph-d", "ph-a"];

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
          <div className="gallery">
            {phs.map((c, i) => (
              <div className={"gimg " + c} key={i}>
                <div className={"ph " + c}><span>{i === 0 ? "ẢNH CHÍNH · " + r.type : "ẢNH " + (i + 1)}</span></div>
              </div>
            ))}
          </div>

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
              <div className="spec"><div className="sp-lbl">Loại phòng</div><div className="sp-val">{r.type}</div></div>
              <div className="spec"><div className="sp-lbl">Vị trí</div><div className="sp-val">T{r.floor}</div></div>
            </div>

            {r.status === "soon" && r.availDate && (
              <div className="note-box">
                <Icon.Calendar />
                {`Phòng sắp trống — dự kiến bàn giao từ ${r.availDate}. Có thể nhận booking & đặt lịch dẫn khách xem sớm.`}
              </div>
            )}

            <p className="sh-section-lbl">Tiện ích</p>
            <div className="amen-grid">
              {r.amenities.map((a) => (<span className="amen-pill" key={a}>{amenIcon(a)}{a}</span>))}
            </div>

            <p className="sh-section-lbl">Địa chỉ</p>
            <div className="amen-grid">
              <span className="amen-pill"><Icon.Pin />{r.buildingAddr}</span>
            </div>
          </div>

          <div className="sh-actions2">
            <button className="act2" onClick={doCopy}><Icon.Copy />Copy gửi khách</button>
            <button className="act2" onClick={doRoute}><Icon.Route />Chỉ đường</button>
            <button className="act2" onClick={doShare}><Icon.Share />Chia sẻ</button>
          </div>
        </div>

        <div className="sh-actions">
          <button className="btn btn-primary" onClick={doCall}><Icon.Phone />Gọi giữ phòng</button>
          <button className="btn btn-ghost" onClick={doZalo} title="Nhắn Zalo" style={{ color: "#0068ff" }}>
            <Icon.Bell />
          </button>
          <button className="btn btn-ghost" onClick={() => { toggleSave(r.id); onToast(isSaved ? "Đã bỏ lưu" : "Đã lưu phòng quan tâm"); }}>
            {isSaved ? <Icon.HeartFill style={{ color: "var(--st-soon)" }} /> : <Icon.Heart />}
          </button>
        </div>
      </div>
    </>
  );
}

export function Toast({ msg, show }: { msg: string; show: boolean }) {
  return (<div className={"toast" + (show ? " show" : "")}><Icon.Check />{msg}</div>);
}
