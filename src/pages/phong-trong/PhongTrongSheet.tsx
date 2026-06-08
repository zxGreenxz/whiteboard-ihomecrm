import React, { useEffect, useState, useRef, useLayoutEffect } from "react";
import { Icon, amenIcon } from "./icons";
import { STATUS_META, fmtPrice, MANAGER, genInfoLines, type Room, type Building } from "./sampleData";

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
        {/* Chỉ render ảnh KHI mở lightbox (opacity:0 vẫn tải) — tránh preload trùng cả bộ ảnh. */}
        {index != null && images.map((src, i) => (
          <div className="lb-slide" key={i}>
            <img src={src} alt={"Anh " + (i + 1)} loading={i === index ? "eager" : "lazy"} decoding="async" />
          </div>
        ))}
      </div>
      <div className="lb-count">{cur + 1}/{images.length}</div>
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
  return [
    `🏠 ${r.buildingName} — Phòng ${r.code}${r.type ? ` · ${r.type}` : ""}`,
    `• Giá: ${fmtPrice(r.price)} triệu/tháng`,
    `• Tình trạng: ${SM[r.status].label}${r.availDate ? " (trống từ " + r.availDate + ")" : ""}`,
    `• Nội thất: ${r.amenities.join(", ")}`,
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

// Nén ảnh TRƯỚC khi chia sẻ/tải: thu nhỏ cạnh dài ≤ 1600px, mã hoá lại JPEG ~0.82.
// Vì sao: ảnh upload full-res HD (tới ~5MB/tấm) → 10 tấm ~25-40MB nhồi vào share sheet
// iOS khiến Zalo "Có lỗi xảy ra" / rớt bớt ảnh (vượt ngân sách bộ nhớ extension ~120MB).
// Nén xuống ~200-300KB/tấm → tổng ~2-4MB, gửi ổn định. Xử lý TUẦN TỰ + nhả canvas mỗi
// ảnh để không sập bộ nhớ canvas của Safari mobile (~224-384MB toàn tiến trình).
const SHARE_MAX_DIM = 1600;   // cạnh dài tối đa (chuẩn chat/Zalo)
const SHARE_JPEG_Q = 0.82;    // chất lượng JPEG (0.78-0.85 là điểm ngọt)

/** Nén 1 blob ảnh dùng chung 1 canvas. Mọi nhánh lỗi/biên đều TRẢ VỀ blob gốc
 *  (không bao giờ ném/trả null) để không làm rớt ảnh khỏi bộ chia sẻ. */
async function compressBlob(blob: Blob, canvas: HTMLCanvasElement): Promise<Blob> {
  let bmp: ImageBitmap | null = null;
  try {
    // 'from-image' = áp EXIF orientation (Safari 16+ mặc định) → ảnh không bị xoay.
    // Giải mã từ BLOB (không phải URL từ xa) nên canvas không bị "taint".
    try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
    catch { bmp = await createImageBitmap(blob); }
    const { width: w, height: h } = bmp;
    const longest = Math.max(w, h);
    // Ảnh đã nhỏ sẵn & đã là JPEG → giữ gốc (tránh tái nén mất nét, phình ngược).
    if (longest <= SHARE_MAX_DIM && /jpe?g/i.test(blob.type)) return blob;
    const scale = Math.min(1, SHARE_MAX_DIM / longest);
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    // Nền trắng trước khi vẽ: PNG/WebP trong suốt mã hoá JPEG sẽ không bị nền đen.
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(bmp, 0, 0, tw, th);
    const out = await new Promise<Blob | null>((res) => {
      try { canvas.toBlob((b) => res(b), "image/jpeg", SHARE_JPEG_Q); }
      catch { res(null); }
    });
    // toBlob null (iOS cũ) hoặc nén ra TO hơn gốc → giữ gốc.
    if (!out || out.size >= blob.size) return blob;
    return out;
  } catch {
    return blob;
  } finally {
    bmp?.close?.();
  }
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

  // Liên hệ riêng từng tòa (đã map ở supabaseData); chưa có -> hotline/owner chung.
  const contactName = building?.manager || MANAGER.name;
  const contactPhone = building?.phone || MANAGER.phone;
  const contactDigits = contactPhone.replace(/\D/g, "") || MANAGER.zalo;

  const doCall = () => {
    onToast("Đang gọi " + contactName + " để giữ phòng…");
    window.location.href = "tel:" + contactDigits;
  };
  const doZalo = () => {
    window.open("https://zalo.me/" + contactDigits, "_blank");
  };
  const doRoute = () => {
    // Link Chỉ đường riêng từng tòa nếu đã set; chưa có -> tìm theo địa chỉ.
    const url = building?.mapUrl
      || "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(r.buildingAddr);
    window.open(url, "_blank");
  };
  // Tải TOÀN BỘ ảnh phòng thành File[] (tên theo Tòa-Phòng-STT) để chia sẻ / tải về.
  // TUẦN TỰ (không Promise.all): vừa né sập bộ nhớ khi giải mã nhiều ảnh HD cùng lúc
  // trên Safari mobile, vừa để 1 ảnh lỗi (404/CORS) chỉ bị BỎ QUA thay vì rớt cả batch.
  // compress=true → nén từng tấm (chia sẻ/gửi Zalo); dùng lại 1 canvas, nhả ở cuối.
  const fetchImageFiles = async (compress: boolean): Promise<File[]> => {
    const out: File[] = [];
    const canvas = compress ? document.createElement("canvas") : null;
    for (const src of images) {
      try {
        const res = await fetch(src);
        let blob = await res.blob();
        if (canvas) blob = await compressBlob(blob, canvas);
        const isJpeg = !blob.type || /jpe?g/i.test(blob.type);
        const ext = isJpeg ? "jpg" : (blob.type.split("/")[1] || "jpg").split("+")[0];
        const name = `${r.buildingName}-${r.code}-${String(out.length + 1).padStart(2, "0")}.${ext}`;
        out.push(new File([blob], name, { type: blob.type || "image/jpeg" }));
      } catch { /* 1 ảnh hỏng → bỏ qua, không làm rớt cả bộ */ }
    }
    if (canvas) { canvas.width = 1; canvas.height = 1; } // nhả backing store (Safari giữ bộ nhớ canvas)
    return out;
  };

  // Gửi khách: chia sẻ CHỈ ẢNH (files-only) — đáng tin nhất trên iOS/Zalo, KHÔNG bị rớt
  // ảnh. Lý do: kiện "vừa-chữ-vừa-nhiều-ảnh" hay bị bộ nhận của Zalo lấy thiếu ảnh. Phần
  // mô tả được chép sẵn vào clipboard để dán kèm. Máy không hỗ trợ share file -> share text.
  const shareRoom = async (copyFallbackMsg: string) => {
    const text = buildShareText(r, building);
    const nav = navigator as ShareNav;
    // Chép mô tả NGAY (còn trong user-gesture) để dán vào ô chat khi gửi ảnh.
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* */ }
    onToast(copied ? "Đã chép mô tả — mở ảnh để gửi, nhớ dán mô tả vào Zalo" : "Đang chuẩn bị ảnh…");

    let files: File[] = [];
    try { files = await fetchImageFiles(true); } catch { /* nén/tải lỗi -> rơi xuống share text */ }

    // canShare phải kiểm trên ĐÚNG bộ file (đã nén) sẽ gửi.
    if (files.length && nav.share && nav.canShare && nav.canShare({ files })) {
      try {
        await nav.share({ files });   // CHỈ ảnh, không kèm text/title
        return;
      } catch (e) {
        if ((e as DOMException)?.name === "AbortError") { onToast("Đã huỷ chia sẻ"); return; }
        /* lỗi khác -> thử share text / clipboard bên dưới */
      }
    }
    // Không share được file (desktop / máy cũ) -> share text, rồi mới đến clipboard.
    if (nav.share) {
      try { await nav.share({ text }); return; }
      catch (e) { if ((e as DOMException)?.name === "AbortError") { onToast("Đã huỷ chia sẻ"); return; } }
    }
    if (!copied) { try { await navigator.clipboard.writeText(text); } catch { /* */ } }
    onToast(copyFallbackMsg);
  };
  const doShare = () => shareRoom("Đã copy thông tin phòng — ảnh vui lòng gửi kèm thủ công");

  // "Tải ảnh": gom TOÀN BỘ ảnh rồi mở share sheet 1 lần → trên iOS/Android chọn
  // "Lưu N ảnh" để lưu thẳng vào Thư viện ảnh (không còn tải đè từng tấm vào Files).
  // Desktop / máy không hỗ trợ share file → tải từng ảnh bằng <a download>.
  const doDownload = async () => {
    const nav = navigator as ShareNav;
    onToast("Đang nén ảnh…");
    let files: File[] = [];
    try { files = await fetchImageFiles(true); } catch { /* */ }
    if (!files.length) { onToast("Không tải được ảnh"); return; }

    if (nav.share && nav.canShare && nav.canShare({ files })) {
      try {
        await nav.share({ files }); // chỉ ảnh → share sheet nổi bật "Lưu N ảnh" vào Ảnh
        return;
      } catch (e) {
        // Người dùng bấm Huỷ trên share sheet → dừng, không tải đè hàng loạt.
        if ((e as DOMException)?.name === "AbortError") { onToast("Đã huỷ tải ảnh"); return; }
        // Lỗi khác → rơi xuống tải <a download> bên dưới.
      }
    }

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

            {r.saleBonus && (
              <div className="note-box" style={{ background: "var(--st-soon-bg)", borderColor: "var(--st-soon-line)", color: "var(--st-soon)" }}>
                <Icon.Tag />
                <span><b>Thưởng sale:</b> {r.saleBonus}</span>
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
          <button className="btn btn-primary btn-half" onClick={doCall}><Icon.Phone />Gọi Quản Lý</button>
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
      <Lightbox images={images} index={lb} onClose={() => setLb(null)} />
    </>
  );
}

export function Toast({ msg, show }: { msg: string; show: boolean }) {
  return (<div className={"toast" + (show ? " show" : "")}><Icon.Check />{msg}</div>);
}
