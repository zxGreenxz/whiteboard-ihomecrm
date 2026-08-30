// =============================================================================
// room-list-image.js — BẢN PORT của `src/pages/phong-trong/exportRoomListImage.ts`
// sang Node bằng `@napi-rs/canvas` (canvas 2D chạy native, không cần trình duyệt).
//
// HAI BẢN PHẢI GIỮ KHỚP. Người xem trang /r/:token bấm "Tải ảnh" thì được bản
// TS vẽ; khách nhận Zalo thì được bản này vẽ. Cùng một bảng phải ra cùng một
// tấm ảnh — nên MỌI hằng số bố cục (COLS, PAD, LINE_H, màu…) và cả thuật toán
// đo–xuống dòng ở đây đều là bản sao đúng từng con số của file TS. Đổi bố cục
// một bên mà quên bên kia thì khách và Sale nhìn hai tấm ảnh khác nhau về cùng
// một danh sách phòng.
//
// Khác biệt CÓ CHỦ Ý so với bản trình duyệt (chỉ vì môi trường, không vì bố cục):
//   • `document.createElement('canvas')` → `createCanvas(w, h)`.
//   • `ensureFonts()` (FontFace API) → `napFont()` (GlobalFonts của napi-rs).
//   • Bỏ `toBlob`/`downloadRoomListImage`: worker không có Blob/URL/thẻ <a>,
//     nó cần Buffer PNG để đưa thẳng cho zca-js.
//
// Dữ liệu vào lấy từ `buildRoomListTable()` trong `room-list-table.js`.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { exportFileName } from './room-list-table.js';

/* ---- khung bảng (px @ scale 1; canvas render ở DPR 2 cho nét chữ) ---- */
const COLS = [300, 110, 150, 230, 340, 270]; // ĐỊA CHỈ · MÃ · GIÁ · LOẠI · NỘI THẤT · TÌNH TRẠNG
const HEADERS = ['ĐỊA CHỈ', 'MÃ PHÒNG', 'GIÁ', 'LOẠI PHÒNG', 'NỘI THẤT', 'TÌNH TRẠNG'];
const WIDTH = COLS.reduce((a, b) => a + b, 0);
const PAD_X = 12;
const PAD_Y = 11;
const LINE_H = 22;
const H_TITLE = 54;
const H_HEAD = 46;
const MIN_ROW = 52;
const SCALE = 2;

/* Bảng màu Excel quen thuộc của file cũ — mỗi tòa một nền. */
const GROUP_BG = [
  '#f4b183', '#a9d18e', '#9dc3e6', '#ffc000', '#ff7c80',
  '#f8cbad', '#ffd966', '#c6e0b4', '#bdd7ee', '#d9d9d9',
];
const C_LINE = '#548235';
const C_HEAD_BG = '#70ad47';
const C_INK = '#111111';
const C_ADDR = '#1f4e79';
const C_CONTACT = '#e00000';
const C_PAPER = '#ffffff';

/* ---- Font ----------------------------------------------------------------
 * Bản trình duyệt dùng '"Be Vietnam Pro", system-ui, …'. Trên Node KHÔNG có
 * font nào trong đó cho tới khi ta tự nạp: `napFont()` đăng ký mọi file font
 * tìm thấy trong `worker/fonts/` DƯỚI ĐÚNG TÊN HỌ "Be Vietnam Pro", nhờ vậy
 * chuỗi FONT dưới đây giữ nguyên được và khớp từng chữ với bản TS.
 *
 * Hai tên cuối ("Noto Sans", "DejaVu Sans") là phần THÊM so với bản web: trên
 * VPS Linux trần thì system-ui/Segoe UI/Roboto đều không tồn tại, còn hai font
 * này gần như luôn có và có đủ dấu tiếng Việt. Chúng chỉ được dùng khi các tên
 * đứng trước đều trượt, nên không đổi kết quả khi font chính đã nạp được.
 */
const FONT = '"Be Vietnam Pro", system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", sans-serif';
const font = (weight, size) => `${weight} ${size}px ${FONT}`;

const THU_MUC_FONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fonts');
const HO_FONT_CHINH = 'Be Vietnam Pro';
const DUOI_FONT = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);

/** Ghi nhớ kết quả lần nạp đầu — đăng ký lại mỗi lần vẽ là phí và ồn log. */
let ketQuaNapFont = null;

/**
 * Nạp font trước khi ĐO chữ. Đo bằng font khác thì bề rộng ô lệch → số dòng
 * xuống hàng lệch → chiều cao ảnh lệch. Vì thế hàm này phải chạy TRƯỚC
 * `measure()`, không phải trước lúc vẽ.
 *
 * TUYỆT ĐỐI KHÔNG NÉM LỖI. Thiếu font là chuyện thường trên máy mới dựng
 * (`worker/fonts/` chưa tồn tại, chưa ai chép file vào). Khi đó ảnh vẫn phải
 * ra — chỉ là chữ dùng font khác và bảng rộng/hẹp hơn bản web một chút. Ảnh
 * xấu hơn thì Sale gửi lại được; broadcast chết vì một exception thì không ai
 * biết cho tới lúc khách phàn nàn.
 *
 * @returns {{nguon: string, soTep: number, ghiChu: string}} để chỗ gọi log lại.
 */
export function napFont() {
  if (ketQuaNapFont) return ketQuaNapFont;
  const ra = { nguon: 'mac-dinh', soTep: 0, ghiChu: '' };

  try {
    const tepFont = fs
      .readdirSync(THU_MUC_FONT, { withFileTypes: true })
      .filter((d) => d.isFile() && DUOI_FONT.has(path.extname(d.name).toLowerCase()))
      .map((d) => path.join(THU_MUC_FONT, d.name))
      // Sắp xếp cho thứ tự đăng ký ổn định giữa các máy — cùng bộ file thì
      // cùng kết quả, không phụ thuộc thứ tự thư mục trả về.
      .sort();
    for (const tep of tepFont) {
      try {
        // Alias về cùng một họ: napi-rs đọc weight/style trong metadata file
        // nên Regular/Bold/ExtraBold nằm chung họ vẫn chọn đúng cân nặng.
        if (GlobalFonts.registerFromPath(tep, HO_FONT_CHINH)) ra.soTep += 1;
      } catch (e) {
        ra.ghiChu = `Bỏ qua font lỗi ${path.basename(tep)}: ${e?.message || e}`;
      }
    }
    if (ra.soTep) ra.nguon = 'thu-muc-fonts';
  } catch (e) {
    // Thư mục không tồn tại / không đọc được — đúng đường đi bình thường khi
    // chưa ai chép font vào, không phải sự cố.
    ra.ghiChu = `Không đọc được ${THU_MUC_FONT}: ${e?.message || e}`;
  }

  if (!ra.soTep) {
    try {
      // Rơi về font hệ thống. Trên Windows/macOS thường đủ dấu tiếng Việt;
      // trên container Linux trần có thể trắng trơn → napi-rs tự dùng font
      // dựng sẵn của nó. Vẫn không ném lỗi.
      GlobalFonts.loadSystemFonts();
      ra.nguon = 'font-he-thong';
    } catch (e) {
      ra.ghiChu = `${ra.ghiChu} · loadSystemFonts lỗi: ${e?.message || e}`.trim();
    }
  }

  ketQuaNapFont = ra;
  return ra;
}

/* ---- đo chữ & vẽ --------------------------------------------------------- */

/** Cắt chuỗi thành các dòng vừa bề rộng ô (ưu tiên ngắt theo từ). */
function wrap(ctx, text, maxW) {
  if (!text) return [''];
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const next = `${line} ${words[i]}`;
      if (ctx.measureText(next).width <= maxW) line = next;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  }
  return out;
}

/** Vẽ nhiều dòng canh giữa theo chiều ngang, bắt đầu từ `top`. */
function drawLines(ctx, lines, cx, top) {
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * LINE_H + LINE_H / 2));
}

/** Pass 1 — đo chữ để biết chiều cao từng hàng (ô nội thất hay tràn 2–3 dòng). */
function measure(ctx, table) {
  const groups = table.groups.map((g) => {
    ctx.font = font(700, 15);
    const addrLines = g.addressLines.flatMap((l) => wrap(ctx, l, COLS[0] - PAD_X * 2));

    const rows = g.rows.map((r) => {
      ctx.font = font(500, 15);
      const cells = [r.code, r.price, r.type, r.amenities];
      const lines = [
        [], // cột ĐỊA CHỈ gộp ô — không vẽ theo hàng
        ...cells.map((c, i) => wrap(ctx, c, COLS[i + 1] - PAD_X * 2)),
        r.status.flatMap((s) => wrap(ctx, s, COLS[5] - PAD_X * 2)),
      ];
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
  const contactLines = table.contactLines.flatMap((l) => wrap(ctx, l, COLS[0] - PAD_X * 2));
  ctx.font = font(500, 15);
  const infoLines = table.infoLines.flatMap((l) => wrap(ctx, l, WIDTH - COLS[0] - PAD_X * 2));
  const bandH = Math.max(
    contactLines.length * 28 + PAD_Y * 2,
    infoLines.length * LINE_H + PAD_Y * 2,
    96,
  );

  const height = H_TITLE + bandH + H_HEAD + groups.reduce((n, g) => n + g.height, 0);
  return { groups, contactLines, infoLines, bandH, height };
}

/**
 * Dựng canvas ảnh bảng phòng trống (port của `drawRoomListImage`).
 * Trả về đối tượng Canvas của @napi-rs/canvas — chỗ gọi tự quyết xuất PNG,
 * JPEG hay vẽ chồng thêm.
 */
export function veBangRaCanvas(table) {
  // Nạp font TRƯỚC khi đo. Hàm idempotent nên gọi thoải mái.
  napFont();

  // Canvas 1×1 chỉ để đo chữ ở pass 1 — chưa biết chiều cao thật thì chưa cấp
  // được vùng nhớ đúng cỡ.
  const probe = createCanvas(1, 1).getContext('2d');
  const m = measure(probe, table);

  const canvas = createCanvas(WIDTH * SCALE, m.height * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = C_PAPER;
  ctx.fillRect(0, 0, WIDTH, m.height);

  const line = (x1, y1, x2, y2) => {
    ctx.strokeStyle = C_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
    ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
    ctx.stroke();
  };
  const colX = (i) => COLS.slice(0, i).reduce((a, b) => a + b, 0);

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
  m.contactLines.forEach((l, i) => ctx.fillText(l, COLS[0] / 2, cTop + i * 28 + 14));

  ctx.fillStyle = C_INK;
  ctx.font = font(500, 15);
  const iTop = y + (m.bandH - m.infoLines.length * LINE_H) / 2;
  const infoCx = COLS[0] + (WIDTH - COLS[0]) / 2;
  drawLines(ctx, m.infoLines, infoCx, iTop);

  line(COLS[0], y, COLS[0], y + m.bandH);
  y += m.bandH;
  line(0, y, WIDTH, y);

  // --- Hàng tiêu đề cột ---
  ctx.fillStyle = C_HEAD_BG;
  ctx.fillRect(0, y, WIDTH, H_HEAD);
  ctx.fillStyle = C_INK;
  ctx.font = font(800, 15);
  HEADERS.forEach((h, i) => ctx.fillText(h, colX(i) + COLS[i] / 2, y + H_HEAD / 2));
  for (let i = 1; i < COLS.length; i++) line(colX(i), y, colX(i), y + H_HEAD);
  y += H_HEAD;
  line(0, y, WIDTH, y);

  // --- Thân bảng: mỗi tòa một khối nền ---
  m.groups.forEach((mg, gi) => {
    const top = y;
    ctx.fillStyle = GROUP_BG[gi % GROUP_BG.length];
    ctx.fillRect(0, top, WIDTH, mg.height);

    // Ô ĐỊA CHỈ gộp — canh giữa theo chiều dọc cả khối.
    const aTop = top + (mg.height - mg.addrLines.length * LINE_H) / 2;
    mg.addrLines.forEach((l, i) => {
      const isAddr = i === 0;
      ctx.fillStyle = isAddr ? C_ADDR : C_INK;
      ctx.font = font(isAddr ? 700 : 600, isAddr ? 15 : 14);
      ctx.fillText(l, COLS[0] / 2, aTop + i * LINE_H + LINE_H / 2);
    });

    // Các cột còn lại, kẻ vạch ngăn giữa từng phòng.
    let ry = top;
    mg.rows.forEach((row, ri) => {
      for (let c = 1; c < COLS.length; c++) {
        const cellLines = row.lines[c];
        const cTopY = ry + (row.height - cellLines.length * LINE_H) / 2;
        ctx.fillStyle = C_INK;
        ctx.font = font(c === 1 || c === 2 || c === 5 ? 700 : 500, 15);
        drawLines(ctx, cellLines, colX(c) + COLS[c] / 2, cTopY);
      }
      ry += row.height;
      if (ri < mg.rows.length - 1) line(COLS[0], ry, WIDTH, ry);
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

/**
 * Vẽ bảng ra PNG. Đây là cửa vào duy nhất mà worker cần: đưa `table` từ
 * `buildRoomListTable()` vào, nhận Buffer PNG để nạp thẳng vào zca-js
 * (`{ data: buffer, filename, metadata }` — xem `media.js`).
 */
export function veAnhDanhSach(table) {
  return veBangRaCanvas(table).toBuffer('image/png');
}

/** Tên tệp ảnh: danh-sach-phong-trong-YYYYMMDD.png — dùng chung một bản thuật
 * toán với `room-list-table.js` để tên file gửi Zalo trùng tên file người dùng
 * tải từ web. */
export function tenTepAnh(now = new Date()) {
  return exportFileName(now);
}

/** Bề rộng ảnh @scale 1 — chỗ gọi cần khai `metadata.width/height` cho Zalo thì
 * lấy từ đây (bề rộng thật của PNG là `KHO_ANH * 2`, do SCALE). */
export const KHO_ANH = WIDTH;
export const TY_LE_ANH = SCALE;
