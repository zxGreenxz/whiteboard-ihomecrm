/* ===== Xuất ảnh "DANH SÁCH PHÒNG TRỐNG" (nút Tải ảnh trên /r/:token) =====
 * Vẽ thẳng bằng canvas 2D — KHÔNG thêm html2canvas/html-to-image vào bundle.
 * Bố cục bám file Excel mà Sale vẫn gửi Zalo (xem roomListTable.ts cho phần
 * chọn/định dạng dữ liệu — file này chỉ lo đo chữ, xuống dòng và vẽ).
 *
 * Lazy-import từ PhongTrongPage: ảnh chỉ dựng khi user bấm nút.
 */
import { buildRoomListTable, exportFileName, GROUP_BG, type RoomListTable, type TableGroup } from "./roomListTable";
import type { Building } from "./sampleData";

/* ---- khung bảng (px @ scale 1; canvas render ở DPR 2 cho nét chữ) ---- */
const COLS: readonly number[] = [320, 100, 130, 250, 190, 310, 220]; // ĐỊA CHỈ · MÃ · GIÁ · CHÍNH SÁCH · LOẠI · NỘI THẤT · TÌNH TRẠNG
const colW = (i: number): number => COLS[i] ?? 0;
const ADDR_W = colW(0);
const HEADERS = ["ĐỊA CHỈ", "MÃ PHÒNG", "GIÁ", "CHÍNH SÁCH SALE", "LOẠI PHÒNG", "NỘI THẤT", "TÌNH TRẠNG"];
const WIDTH = COLS.reduce((a, b) => a + b, 0);
const PAD_X = 12;
const PAD_Y = 11;
const LINE_H = 22;
const H_TITLE = 54;
const H_HEAD = 46;
const MIN_ROW = 52;
const SCALE = 2;
const ICON = 14;    // cạnh icon thang/điện thoại trong ô địa chỉ
const ICON_GAP = 5; // icon → chữ
const SEG_GAP = 6;  // giữa hai cụm cùng dòng (địa chỉ → "(thang máy)")

const C_LINE = "#548235";
const C_HEAD_BG = "#70ad47";
const C_INK = "#111111";
const C_POLICY = "#c00000";
const C_CONTACT = "#e00000";
const C_PAPER = "#ffffff";

const FONT = '"Be Vietnam Pro", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const font = (weight: number, size: number) => `${weight} ${size}px ${FONT}`;

/** Độ đậm chữ từng cột thân bảng: mã, giá, chính sách, tình trạng in đậm. */
const cellWeight = (c: number) => (c === 1 || c === 2 || c === 3 || c === 6 ? 700 : 500);

/** Cắt chuỗi thành các dòng vừa bề rộng ô (ưu tiên ngắt theo từ). */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (!line || ctx.measureText(next).width <= maxW) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

/** Vẽ nhiều dòng canh giữa theo chiều ngang, bắt đầu từ `top`. */
function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  cx: number,
  top: number,
): void {
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * LINE_H + LINE_H / 2));
}

/* ---- Ô địa chỉ: chữ + icon trên cùng dòng ---- */
type Glyph = "elevator" | "stairs" | "phone";
interface Seg { text: string; weight: number; icon?: Glyph }
type RichLine = Seg[];

function segWidth(ctx: CanvasRenderingContext2D, s: Seg): number {
  ctx.font = font(s.weight, 15);
  return (s.icon ? ICON + ICON_GAP : 0) + ctx.measureText(s.text).width;
}
function richWidth(ctx: CanvasRenderingContext2D, line: RichLine): number {
  return line.reduce((w, s, i) => w + segWidth(ctx, s) + (i ? SEG_GAP : 0), 0);
}

/**
 * Dòng của ô ĐỊA CHỈ: địa chỉ xuống dòng theo từ; cụm "(thang máy)" kèm icon
 * không bị tách, nối vào dòng cuối nếu còn chỗ; SĐT riêng tòa đứng dòng riêng.
 */
function addressLines(ctx: CanvasRenderingContext2D, g: TableGroup, maxW: number): RichLine[] {
  ctx.font = font(700, 15);
  const lines: RichLine[] = wrap(ctx, g.address, maxW).map((text) => [{ text, weight: 700 }]);
  if (g.lift) {
    const chip: Seg = { text: g.lift.label, weight: 600, icon: g.lift.kind };
    const last = lines[lines.length - 1];
    if (!last?.[0]?.text) lines[Math.max(0, lines.length - 1)] = [chip];
    else if (richWidth(ctx, [...last, chip]) <= maxW) last.push(chip);
    else lines.push([chip]);
  }
  if (g.phone) lines.push([{ text: g.phone, weight: 700, icon: "phone" }]);
  return lines;
}

/** Đường viền bo góc — tự dựng bằng arcTo vì roundRect chưa có ở mọi canvas. */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Icon vẽ bằng nét (không dùng emoji: worker Node không chắc có font emoji). */
function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, x: number, cy: number): void {
  ctx.save();
  ctx.fillStyle = C_INK;
  ctx.strokeStyle = C_INK;
  ctx.lineWidth = 1.6;
  const top = cy - ICON / 2;
  if (glyph === "elevator") {
    // Buồng thang + mũi tên lên/xuống.
    roundedRect(ctx, x + 1, top, ICON - 2, ICON, 2);
    ctx.stroke();
    const mx = x + ICON / 2;
    ctx.beginPath();
    ctx.moveTo(mx, top + 2.5); ctx.lineTo(mx - 3.5, cy - 1); ctx.lineTo(mx + 3.5, cy - 1);
    ctx.closePath();
    ctx.moveTo(mx, top + ICON - 2.5); ctx.lineTo(mx - 3.5, cy + 1); ctx.lineTo(mx + 3.5, cy + 1);
    ctx.closePath();
    ctx.fill();
  } else if (glyph === "stairs") {
    // Ba bậc thang đặc.
    const s = (ICON - 2) / 3;
    ctx.beginPath();
    ctx.moveTo(x + 1, top + ICON);
    ctx.lineTo(x + 1, top + ICON - s);
    ctx.lineTo(x + 1 + s, top + ICON - s);
    ctx.lineTo(x + 1 + s, top + ICON - 2 * s);
    ctx.lineTo(x + 1 + 2 * s, top + ICON - 2 * s);
    ctx.lineTo(x + 1 + 2 * s, top + ICON - 3 * s);
    ctx.lineTo(x + ICON - 1, top + ICON - 3 * s);
    ctx.lineTo(x + ICON - 1, top + ICON);
    ctx.closePath();
    ctx.fill();
  } else {
    // Điện thoại di động: thân bo góc + vạch loa dưới.
    roundedRect(ctx, x + 3, top, ICON - 6, ICON, 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + ICON / 2 - 1.5, top + ICON - 3);
    ctx.lineTo(x + ICON / 2 + 1.5, top + ICON - 3);
    ctx.stroke();
  }
  ctx.restore();
}

/** Vẽ một dòng nhiều cụm, canh giữa quanh `cx`. */
function drawRich(ctx: CanvasRenderingContext2D, line: RichLine, cx: number, cy: number): void {
  let x = cx - richWidth(ctx, line) / 2;
  ctx.textAlign = "left";
  line.forEach((s, i) => {
    if (i) x += SEG_GAP;
    if (s.icon) { drawGlyph(ctx, s.icon, x, cy); x += ICON + ICON_GAP; }
    ctx.font = font(s.weight, 15);
    ctx.fillStyle = C_INK;
    ctx.fillText(s.text, x, cy);
    x += ctx.measureText(s.text).width;
  });
  ctx.textAlign = "center";
}

interface MeasuredRow { lines: string[][]; height: number }
interface MeasuredGroup { group: TableGroup; rows: MeasuredRow[]; addrLines: RichLine[]; height: number }

/** Pass 1 — đo chữ để biết chiều cao từng hàng (ô nội thất hay tràn 2–3 dòng). */
function measure(ctx: CanvasRenderingContext2D, table: RoomListTable) {
  const groups: MeasuredGroup[] = table.groups.map((g) => {
    const addrLines = addressLines(ctx, g, ADDR_W - PAD_X * 2);

    const rows: MeasuredRow[] = g.rows.map((r) => {
      const cells = [r.code, r.price, r.policy, r.type, r.amenities];
      const lines: string[][] = [
        [], // cột ĐỊA CHỈ gộp ô — không vẽ theo hàng
        ...cells.map((cell, i) => {
          ctx.font = font(cellWeight(i + 1), 15);
          return wrap(ctx, cell, colW(i + 1) - PAD_X * 2);
        }),
      ];
      ctx.font = font(cellWeight(6), 15);
      lines.push(r.status.flatMap((s) => wrap(ctx, s, colW(6) - PAD_X * 2)));
      const maxLines = Math.max(...lines.map((l) => l.length), 1);
      return { lines, height: Math.max(MIN_ROW, maxLines * LINE_H + PAD_Y * 2) };
    });

    const rowsH = rows.reduce((n, r) => n + r.height, 0);
    // Ô địa chỉ gộp phải đủ cao để chứa hết dòng địa chỉ.
    const addrH = addrLines.length * LINE_H + PAD_Y * 2;
    return { group: g, rows, addrLines, height: Math.max(rowsH, addrH) };
  });

  // Khối đầu: ô liên hệ (trái) + thông tin chung (phải).
  ctx.font = font(800, 20);
  const contactLines = table.contactLines.flatMap((l) => wrap(ctx, l, ADDR_W - PAD_X * 2));
  ctx.font = font(500, 15);
  const infoLines = table.infoLines.flatMap((l) => wrap(ctx, l, WIDTH - ADDR_W - PAD_X * 2));
  const bandH = Math.max(
    contactLines.length * 28 + PAD_Y * 2,
    infoLines.length * LINE_H + PAD_Y * 2,
    96,
  );

  const height = H_TITLE + bandH + H_HEAD + groups.reduce((n, g) => n + g.height, 0);
  return { groups, contactLines, infoLines, bandH, height };
}

/** Dựng canvas ảnh bảng phòng trống. Không phụ thuộc DOM ngoài <canvas>. */
export function drawRoomListImage(table: RoomListTable): HTMLCanvasElement {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) throw new Error("Trình duyệt không hỗ trợ canvas 2D.");
  const m = measure(probe, table);

  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * SCALE;
  canvas.height = m.height * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Trình duyệt không hỗ trợ canvas 2D.");
  ctx.scale(SCALE, SCALE);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  ctx.fillStyle = C_PAPER;
  ctx.fillRect(0, 0, WIDTH, m.height);

  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.strokeStyle = C_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    ctx.stroke();
  };
  const colX = (i: number) => COLS.slice(0, i).reduce((a, b) => a + b, 0);

  let y = 0;

  // --- Tiêu đề ---
  ctx.fillStyle = C_INK;
  ctx.font = font(800, 26);
  ctx.fillText(table.title, WIDTH / 2, y + H_TITLE / 2);
  y += H_TITLE;
  line(0, y, WIDTH, y);

  // --- Khối liên hệ + thông tin chung ---
  ctx.fillStyle = C_CONTACT;
  ctx.font = font(800, 20);
  const cTop = y + (m.bandH - m.contactLines.length * 28) / 2;
  m.contactLines.forEach((l, i) => ctx.fillText(l, ADDR_W / 2, cTop + i * 28 + 14));

  ctx.fillStyle = C_INK;
  ctx.font = font(500, 15);
  const iTop = y + (m.bandH - m.infoLines.length * LINE_H) / 2;
  const infoCx = ADDR_W + (WIDTH - ADDR_W) / 2;
  drawLines(ctx, m.infoLines, infoCx, iTop);

  line(ADDR_W, y, ADDR_W, y + m.bandH);
  y += m.bandH;
  line(0, y, WIDTH, y);

  // --- Hàng tiêu đề cột ---
  ctx.fillStyle = C_HEAD_BG;
  ctx.fillRect(0, y, WIDTH, H_HEAD);
  ctx.fillStyle = C_INK;
  ctx.font = font(800, 15);
  HEADERS.forEach((h, i) => ctx.fillText(h, colX(i) + colW(i) / 2, y + H_HEAD / 2));
  for (let i = 1; i < COLS.length; i++) line(colX(i), y, colX(i), y + H_HEAD);
  y += H_HEAD;
  line(0, y, WIDTH, y);

  // --- Thân bảng: mỗi tòa một khối nền ---
  m.groups.forEach((mg, gi) => {
    const top = y;
    ctx.fillStyle = GROUP_BG[gi % GROUP_BG.length] ?? C_PAPER;
    ctx.fillRect(0, top, WIDTH, mg.height);

    // Ô ĐỊA CHỈ gộp — canh giữa theo chiều dọc cả khối, toàn bộ một màu mực.
    const aTop = top + (mg.height - mg.addrLines.length * LINE_H) / 2;
    mg.addrLines.forEach((l, i) => drawRich(ctx, l, ADDR_W / 2, aTop + i * LINE_H + LINE_H / 2));

    // Các cột còn lại, kẻ vạch ngăn giữa từng phòng.
    let ry = top;
    mg.rows.forEach((row, ri) => {
      for (let c = 1; c < COLS.length; c++) {
        const cellLines = row.lines[c] ?? [];
        const cTopY = ry + (row.height - cellLines.length * LINE_H) / 2;
        ctx.fillStyle = c === 3 ? C_POLICY : C_INK;
        ctx.font = font(cellWeight(c), 15);
        drawLines(ctx, cellLines, colX(c) + colW(c) / 2, cTopY);
      }
      ry += row.height;
      if (ri < mg.rows.length - 1) line(ADDR_W, ry, WIDTH, ry);
    });

    for (let i = 1; i < COLS.length; i++) line(colX(i), top, colX(i), top + mg.height);
    y = top + mg.height;
    line(0, y, WIDTH, y);
  });

  // Viền ngoài — vẽ THỤT VÀO nửa pixel, kẻ đúng mép phải/mép dưới sẽ rơi ra
  // ngoài canvas và mất hẳn nét.
  ctx.strokeStyle = C_LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, WIDTH - 1, m.height - 1);

  return canvas;
}

/** Nạp sẵn font trước khi đo chữ — đo bằng font fallback sẽ lệch bề rộng ô. */
async function ensureFonts(): Promise<void> {
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return;
  try {
    await Promise.all([
      fonts.load(font(500, 15)),
      fonts.load(font(600, 15)),
      fonts.load(font(700, 15)),
      fonts.load(font(800, 20)),
      fonts.load(font(800, 26)),
    ]);
  } catch {
    /* font bị chặn → rơi về system-ui, bảng vẫn đúng */
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Không tạo được ảnh PNG."))), "image/png"),
  );
}

/**
 * Dựng và tải ảnh danh sách phòng trống. Trả về số phòng đã đưa vào ảnh để
 * chỗ gọi báo toast cho đúng (0 phòng thì không tải file rỗng).
 */
export async function downloadRoomListImage(buildings: Building[], now = new Date()): Promise<number> {
  const table = buildRoomListTable(buildings);
  if (!table.totalRooms) return 0;

  await ensureFonts();
  const canvas = drawRoomListImage(table);
  const blob = await toBlob(canvas);

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(now);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Chờ hết nhịp hiện tại rồi mới thu hồi URL (Safari huỷ tải nếu revoke ngay).
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return table.totalRooms;
}
