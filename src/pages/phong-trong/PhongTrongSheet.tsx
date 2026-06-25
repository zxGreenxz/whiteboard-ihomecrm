import React, { useEffect, useState, useRef, useLayoutEffect } from "react";
import { Icon, amenIcon } from "./icons";
import { STATUS_META, fmtPrice, MANAGER, genInfoLines, type Room, type Building } from "./sampleData";
import { useTrack } from "./useTracking";

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
          {/* Chỉ ảnh đầu tải ngay; còn lại lazy để không kéo 14 ảnh cùng lúc trên mobile. */}
          <img src={src} alt={"Anh " + (i + 1)} draggable={false}
               loading={i === 0 ? "eager" : "lazy"} decoding="async" />
        </div>
      ))}
    </div>
  );
}

function Lightbox({ images, index, onClose, onSaveAll }: {
  images: string[]; index: number | null; onClose: () => void;
  /** Lưu TOÀN BỘ ảnh của phòng về máy/Photos. */
  onSaveAll?: () => void;
}) {
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
      <div className="lb-count">{cur + 1}/{images.length}</div>
      <div className="lb-strip" ref={ref} onScroll={onScroll} onClick={(e) => e.stopPropagation()}>
        {/* Chỉ render ảnh KHI mở lightbox (opacity:0 vẫn tải) — tránh preload trùng cả bộ ảnh. */}
        {index != null && images.map((src, i) => (
          <div className="lb-slide" key={i}>
            <img src={src} alt={"Anh " + (i + 1)} loading={i === index ? "eager" : "lazy"} decoding="async" />
          </div>
        ))}
      </div>
      {onSaveAll && (
        <button className="lb-save" onClick={(e) => { e.stopPropagation(); onSaveAll(); }}>
          <Icon.Download />Lưu tất cả ảnh
        </button>
      )}
    </div>
  );
}

/** Rút gọn địa chỉ gửi khách: số nhà "102/30…"/"331/70/101G…" -> giữ phần trước "/" đầu ("102","331");
 *  bỏ đuôi tỉnh/thành "… Hồ Chí Minh" / "TP.HCM" / "HCM". */
function shortAddr(addr: string): string {
  const s = addr.replace(/^(\d+)\/\S*/, "$1");
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const isCity = (p: string) =>
    /^(thành phố\s+)?hồ chí minh$/i.test(p) || /^tp\.?\s*hcm$/i.test(p) || /^hcm$/i.test(p);
  while (parts.length && isCity(parts[parts.length - 1])) parts.pop();
  return parts.join(", ");
}
function buildShareText(r: Room, building?: Building): string {
  const isPass = r.status === "pass";
  return [
    `🏠 ${r.buildingName} — Phòng ${r.code}${r.type ? ` · ${r.type}` : ""}`,
    `• Giá: ${fmtPrice(r.price)} triệu/tháng`,
    isPass
      ? `• Tình trạng: Khách pass phòng${r.passContactPhone ? " — LH " + r.passContactPhone + (r.passContactName ? " (" + r.passContactName + ")" : "") : ""}`
      : `• Tình trạng: ${SM[r.status].label}${r.availDate ? " (trống từ " + r.availDate + ")" : ""}`,
    `• Nội thất: ${r.amenities.join(", ")}`,
    ...(isPass && r.passAvailDate ? [`• Dự kiến trống từ: ${r.passAvailDate}`] : []),
    ...(isPass && r.passSalePolicy ? [`• Chính sách sale: ${r.passSalePolicy}`] : []),
    ...(r.saleNote ? [`• Khuyến mãi: ${r.saleNote}`] : []),
    `• Địa chỉ: ${shortAddr(r.buildingAddr)}`,
    "",
    "📋 Thông tin chung:",
    ...genInfoLines(building).map((t) => `• ${t}`),
  ].join("\n");
}

// Web Share API level 2 (chia sẻ kèm File[]). iOS/Android hỗ trợ; desktop thường không.
type ShareNav = Navigator & {
  canShare?: (d: { files?: File[] }) => boolean;
  share?: (d: { title?: string; text?: string; files?: File[] }) => Promise<void>;
};

function roomImages(r: Room): string[] {
  return r.images && r.images.length
    ? r.images
    : Array.from({ length: r.imgCount }, (_, i) => `https://picsum.photos/seed/${r.code}-${i}/900/650`);
}

// Tải TOÀN BỘ ảnh phòng thành File[] (tên theo Tòa-Phòng-STT) để chia sẻ / tải về.
// allSettled: 1 ảnh lỗi không làm hỏng cả batch.
async function fetchImageFiles(r: Room): Promise<File[]> {
  const results = await Promise.allSettled(roomImages(r).map(async (src, i) => {
    const res = await fetch(src);
    const blob = await res.blob();
    const ext = (blob.type.split("/")[1] || "jpg").split("+")[0];
    const name = `${r.buildingName}-${r.code}-${String(i + 1).padStart(2, "0")}.${ext}`;
    return new File([blob], name, { type: blob.type || "image/jpeg" });
  }));
  return results.filter((s): s is PromiseFulfilledResult<File> => s.status === "fulfilled").map((s) => s.value);
}

type FilesCacheEntry = { key: string; promise: Promise<File[]>; done: boolean };

export function DetailSheet({
  room, show, onClose, onToast, saved, toggleSave, onGo, buildings, onQuickDeposit,
}: {
  room: Room | null;
  show: boolean;
  onClose: () => void;
  onToast: (m: string) => void;
  saved: string[];
  toggleSave: (id: string) => void;
  onGo: (r: Room) => void;
  buildings: Building[];
  /** Có quyền tạo cọc nhanh → hiện nút "Tạo cọc giữ phòng" (phòng chưa thuê). */
  onQuickDeposit?: (r: Room) => void;
}) {
  const track = useTrack();
  const [lb, setLb] = useState<number | null>(null);
  const rid = room ? room.id : null;
  useEffect(() => { setLb(null); }, [rid]);
  // Cache File[] ảnh theo phòng: Android/iOS đòi navigator.share chạy TRONG user
  // gesture (~5s); tải 10+ ảnh xong mới share là quá hạn → share bị từ chối.
  // Lần bấm đầu lo tải + cache, bấm lại thì share ngay lập tức từ cache.
  const filesCache = useRef<FilesCacheEntry | null>(null);
  const ensureFiles = (rm: Room): FilesCacheEntry => {
    if (!filesCache.current || filesCache.current.key !== rm.id) {
      const entry: FilesCacheEntry = { key: rm.id, promise: Promise.resolve([]), done: false };
      entry.promise = fetchImageFiles(rm).then((fs) => {
        entry.done = true;
        if (!fs.length && filesCache.current === entry) filesCache.current = null; // lỗi hết -> cho phép thử lại
        return fs;
      });
      filesCache.current = entry;
    }
    return filesCache.current;
  };
  // Tải sẵn ảnh ngay khi mở sheet → cú chạm "Tải ảnh"/"Chia sẻ" đầu tiên thường đã có
  // ảnh trong cache, share/download chạy gọn trong cửa sổ user-gesture (~5s) nên không
  // bị Android/iOS từ chối. Mạng quá chậm chưa kịp -> fallback "bấm lại" bên dưới.
  useEffect(() => {
    if (show && room) ensureFiles(room);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, show]);
  if (!room) return null;
  const r = room;
  const isSaved = saved.includes(r.id);
  const images = roomImages(r);

  // Phong cung toa (con trong) de chuyen nhanh truoc/sau
  const building = buildings.find((b) => b.id === r.buildingId);
  const siblings = building
    ? building.rooms.filter((x) => x.status !== "rented").sort((a, b) => b.floor - a.floor || a.no - b.no)
    : [r];
  const idx = siblings.findIndex((x) => x.id === r.id);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;

  // Phòng "khách nhờ sale / pass": liên hệ là CỦA KHÁCH (không phải QL/hotline tòa).
  const isPass = r.status === "pass";
  const contactName = isPass
    ? (r.passContactName?.trim() || "khách")
    : (building?.manager || MANAGER.name);
  const contactPhone = isPass
    ? (r.passContactPhone?.trim() || building?.phone || MANAGER.phone)
    : (building?.phone || MANAGER.phone);
  const contactDigits = contactPhone.replace(/\D/g, "") || MANAGER.zalo;

  // Helper: ghi sự kiện gắn phòng hiện hành.
  const trackRoom = (type: Parameters<typeof track.track>[0], meta?: Record<string, unknown>) =>
    track.track(type, {
      room_id: r.id, room_code: r.code, room_name: String(r.no),
      building_id: r.buildingId, building_name: r.buildingName, metadata: meta,
    });

  const doCall = () => {
    trackRoom("contact_click", { channel: "call", is_pass: isPass });
    onToast("Đang gọi " + contactName + " để giữ phòng…");
    window.location.href = "tel:" + contactDigits;
  };
  const doZalo = () => {
    trackRoom("contact_click", { channel: "zalo", is_pass: isPass });
    window.open("https://zalo.me/" + contactDigits, "_blank");
  };
  const doRoute = () => {
    trackRoom("directions");
    // Link Chỉ đường riêng từng tòa nếu đã set; chưa có -> tìm theo địa chỉ.
    const url = building?.mapUrl
      || "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(r.buildingAddr);
    window.open(url, "_blank");
  };
  // Gửi khách: KÈM TOÀN BỘ ảnh + text (Web Share API level 2). Máy không hỗ trợ
  // -> copy text vào clipboard. Mạng chậm làm hết hạn gesture (NotAllowedError)
  // -> ảnh đã nằm trong cache, toast mời bấm lại; lần 2 share ngay không chờ.
  const shareRoom = async (copyFallbackMsg: string) => {
    const text = buildShareText(r, building);
    const title = r.buildingName + " · " + r.code;
    const nav = navigator as ShareNav;
    const entry = ensureFiles(r);
    if (!entry.done) onToast("Đang chuẩn bị ảnh + thông tin nhà…");
    const files = await entry.promise;
    if (files.length && nav.share && nav.canShare && nav.canShare({ files })) {
      try {
        await nav.share({ title, text, files });
        return;
      } catch (e) {
        const name = (e as DOMException)?.name;
        if (name === "AbortError") return; // user tự huỷ share sheet
        if (name === "NotAllowedError") { onToast("Ảnh đã sẵn sàng — bấm Chia sẻ lần nữa"); return; }
        // lỗi khác -> rơi xuống share text
      }
    }
    if (nav.share) {
      try { await nav.share({ title, text }); return; }
      catch (e) { if ((e as DOMException)?.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(text); onToast(copyFallbackMsg); return; } catch { /* */ }
    trackRoom("error", { where: "share", msg: "share+clipboard failed" });
    onToast("Không chia sẻ được — bấm thử lại");
  };
  const doShare = () => {
    trackRoom("share");
    return shareRoom("Đã copy thông tin phòng — ảnh vui lòng gửi kèm thủ công");
  };

  // "Tải ảnh": gom TOÀN BỘ ảnh rồi mở share sheet 1 lần → trên iOS/Android chọn
  // "Lưu N ảnh" để lưu thẳng vào Thư viện ảnh (không còn tải đè từng tấm vào Files).
  // Desktop / máy không hỗ trợ share file → tải từng ảnh bằng <a download>.
  const doDownload = async () => {
    trackRoom("download");
    const nav = navigator as ShareNav;
    const entry = ensureFiles(r);
    if (!entry.done) onToast("Đang chuẩn bị ảnh…");
    const files = await entry.promise;
    if (!files.length) { trackRoom("error", { where: "download", msg: "no images" }); onToast("Không tải được ảnh"); return; }

    if (nav.share && nav.canShare && nav.canShare({ files })) {
      try {
        await nav.share({ files }); // chỉ ảnh → share sheet nổi bật "Lưu N ảnh" vào Ảnh
        return;
      } catch (e) {
        const name = (e as DOMException)?.name;
        // Người dùng bấm Huỷ trên share sheet → dừng, không tải đè hàng loạt.
        if (name === "AbortError") { onToast("Đã huỷ tải ảnh"); return; }
        // Gesture hết hạn vì chờ tải ảnh → cache đã có, mời bấm lại (lần 2 mở ngay).
        if (name === "NotAllowedError") { onToast("Ảnh đã sẵn sàng — bấm Tải ảnh lần nữa"); return; }
        // Lỗi khác → rơi xuống tải <a download> bên dưới.
      }
    }

    // Desktop / không hỗ trợ share file: tải lần lượt bằng <a download>.
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      try {
        const url = URL.createObjectURL(files[i]);
        const a = document.createElement("a");
        a.href = url;
        a.download = files[i].name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        ok++;
        await new Promise((rs) => setTimeout(rs, 350)); // né trình duyệt chặn tải hàng loạt
      } catch { /* bỏ qua ảnh lỗi */ }
    }
    onToast(ok ? `Đã tải ${ok}/${files.length} ảnh về máy` : "Không tải được ảnh");
  };

  return (
    <>
      <div className={"sheet-scrim" + (show ? " show" : "")} onClick={onClose} />
      <div className={"sheet" + (show ? " show" : "")}>
        <button className="sheet-close" onClick={onClose} aria-label="Đóng" title="Đóng"><Icon.Close /></button>
        <div className="sheet-grab" onClick={onClose} />
        <div className="sheet-scroll">
          <Gallery images={images} onZoom={(i) => { trackRoom("image_view", { index: i }); setLb(i); }} />

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

            {onQuickDeposit && r.status !== "rented" && r.status !== "pass" && (
              <button className="qd-trigger" onClick={() => onQuickDeposit(r)}>
                <Icon.Money />Tạo cọc giữ phòng
              </button>
            )}

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

            {r.saleBonus && (
              <div className="note-box" style={{ background: "var(--st-soon-bg)", borderColor: "var(--st-soon-line)", color: "var(--st-soon)" }}>
                <Icon.Tag />
                <span><b>Thưởng sale:</b> {r.saleBonus}</span>
              </div>
            )}

            {isPass && (r.passContactPhone || r.passContactName || r.passSalePolicy || r.passAvailDate) && (
              <div className="note-box" style={{ background: "var(--st-pass-bg)", borderColor: "var(--st-pass-line)", color: "var(--st-pass)" }}>
                <Icon.Tag />
                <span>
                  <b>Khách pass phòng</b>
                  {(r.passContactPhone || r.passContactName) && (
                    <> — Liên hệ: {r.passContactPhone || "—"}{r.passContactName ? ` (${r.passContactName})` : ""}</>
                  )}
                  {r.passAvailDate && <><br />Dự kiến trống từ {r.passAvailDate}</>}
                  {r.passSalePolicy && <><br />{r.passSalePolicy}</>}
                </span>
              </div>
            )}

            <p className="sh-section-lbl">Nội thất</p>
            <div className="amen-grid">
              {r.amenities.map((a) => (<span className="amen-pill" key={a}>{amenIcon(a)}{a}</span>))}
            </div>

            <p className="sh-section-lbl">Mô tả</p>
            {/* Thông tin chung: điện + thang máy/bộ lấy theo TÒA; nước/PDV/tiện ích chung */}
            <div className="gen-info">
              {genInfoLines(building).map((t, i) => (
                <div className="gen-info-line" key={i}><i className="gi-dot" />{t}</div>
              ))}
            </div>

            <p className="sh-section-lbl">Địa chỉ</p>
            <div className="amen-grid">
              <span className="amen-pill"><Icon.Pin />{r.buildingAddr}</span>
            </div>
          </div>

          <div className="sh-actions2">
            <button className="act2" onClick={doDownload}><Icon.Download />Tải ảnh</button>
            <button className="act2" onClick={doRoute}><Icon.Route />Chỉ đường</button>
            <button className="act2" onClick={doShare}><Icon.Share />Chia sẻ</button>
          </div>
        </div>

        <div className="sh-actions">
          <button className="btn btn-primary btn-half" onClick={doCall}><Icon.Phone />{isPass ? "Gọi khách" : "Gọi Quản Lý"}</button>
          <button className="btn btn-zalo btn-half" onClick={doZalo}><Icon.Chat />Zalo</button>
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
      <Lightbox images={images} index={lb} onClose={() => setLb(null)} onSaveAll={doDownload} />
    </>
  );
}

export function Toast({ msg, show }: { msg: string; show: boolean }) {
  return (<div className={"toast" + (show ? " show" : "")}><Icon.Check />{msg}</div>);
}
