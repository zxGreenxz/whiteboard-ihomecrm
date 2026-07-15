// Đối chiếu sổ tay Excel 686-TCB (Nathan) với sổ quỹ TKHIEP trên web.
// Quy tắc chi tiết: docs/doi-chieu-so-quy-686tcb.md
// Dùng: node scripts/doi-chieu-thu-tien.mjs [file.xlsx] [YYYY-MM-DD]
//   - file.xlsx : mặc định "dataexcel/danh sách thu tiền v2.xlsx"
//   - YYYY-MM-DD: ngày chốt — chỉ lấy phiếu web đến hết ngày này (Excel thường nhập trễ hơn web)
// PAT đọc từ env SUPABASE_PAT hoặc CLAUDE.local.md (không in ra console).
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

// ===== Cấu hình =====
const REF = 'tryymsxyyckgbrmmvozx';
const TKHIEP_ID = 'df6b5925-845d-48da-8000-c367d55d6c04'; // sổ quỹ TKHIEP (TK000046)
const FIRST_MONTH = 5; // web bắt đầu có dữ liệu từ tháng 5/2026 — sheet tháng < 5 bỏ qua
// 4 khoản chi Nathan ghi ở góc sheet tháng 5 (ngoài cột CHI) — cố định, đừng sửa
const CORNER_DEDUCTIONS = [
  { lab: 'lương T4 (góc T5)', amt: 17705000 },
  { lab: '162NVK T4 (góc T5)', amt: 4017800 },
  { lab: '162NVK T5 (góc T5)', amt: 4464800 },
  { lab: 'sổ quỹ Hiệp chi (góc T5)', amt: 7708515 },
];

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const num = (v) => (typeof v === 'number' ? v : 0);

// ===== PAT =====
let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch {}
}
if (!pat) { console.error('Không tìm thấy PAT (env SUPABASE_PAT hoặc CLAUDE.local.md)'); process.exit(1); }

// ===== 1. Đọc Excel (copy ra temp trước — file hay bị Excel lock) =====
const src = process.argv[2] || new URL('../dataexcel/danh sách thu tiền v2.xlsx', import.meta.url);
const tmp = join(mkdtempSync(join(tmpdir(), 'doichieu-')), 'wb.xlsx');
copyFileSync(src, tmp);
const wb = XLSX.readFile(tmp);

const monthSheets = wb.SheetNames
  .map((n) => ({ n, m: /^tháng (\d+)$/.exec(n)?.[1] }))
  .filter((x) => x.m && Number(x.m) >= FIRST_MONTH)
  .sort((a, b) => Number(a.m) - Number(b.m));
if (!monthSheets.length) { console.error('Không thấy sheet "tháng N" nào >= tháng ' + FIRST_MONTH); process.exit(1); }
console.log('Sheets đối chiếu:', monthSheets.map((x) => x.n).join(', '));

// Dòng tổng kết / carryover — KHÔNG cộng vào thu chi.
// Riêng "tiền còn lại của tháng X": nếu X nằm TRONG các tháng đang cộng (>= FIRST_MONTH)
// thì là carryover nội bộ giữa 2 sheet → skip kẻo đếm đôi; nếu X < FIRST_MONTH (vd tháng 4)
// thì là tiền thật mang vào đầu kỳ (web cũng có phiếu) → GIỮ LẠI.
const skipRow = (r) => {
  // Dòng số liệu nhưng KHÔNG có nhãn toà (cột 0) lẫn nhãn phòng (cột 1) = dòng tổng kết
  // tay không tên (án lệ: R185 sheet T7 mang "tiền Ihome" 20.799.001 tràn vào cột CKH).
  if (r[0] === '' && String(r[1]).trim() === '') return true;
  const j = r.join('|').toLowerCase();
  const cf = /còn lại của (?:tháng\s*)?t?\s*(\d+)/.exec(j);
  if (cf) return Number(cf[1]) >= FIRST_MONTH;
  return j.includes('tổng') || j.includes('tk tcb') || j.includes('số dư')
    || j.includes('tiền ihome') || j.includes('tiền hiệp');
};

const exIn = [], exOut = [];
for (const { n } of monthSheets) {
  const ws = wb.Sheets[n];
  const d = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  // tự dò cột theo header (T5 lệch 1 cột so với T6+)
  const head = d[0].map((c) => String(c));
  const col = {
    ckh: head.findIndex((c) => c.includes('CKH')),
    chi: head.findIndex((c) => c.includes('CHI')),
    bvb: head.findIndex((c) => c.includes('BVB')),
  };
  if (col.ckh < 0 || col.chi < 0) { console.error(`[${n}] không dò được cột CKH/CHI trong header: ${head.join(' | ')}`); process.exit(1); }
  let toa = '';
  for (let i = 1; i < d.length; i++) {
    const r = d[i];
    if (!r.some((c) => c !== '')) continue;
    if (r[0] !== '') toa = String(r[0]).trim();
    if (skipRow(r)) continue;
    const lab = `[${n}] ${(toa ? toa.split(' ')[0] + ' ' : '')}${String(r[1] || '').trim()}`;
    const ck = num(r[col.ckh]);
    if (ck > 0) exIn.push({ lab, amt: ck });
    const ch = num(r[col.chi]);
    if (ch > 0) exOut.push({ lab, amt: ch });
    if (col.bvb >= 0) {
      const b = num(r[col.bvb]);
      if (b > 0) exIn.push({ lab: lab + ' [BVB]', amt: b });
      else if (b < 0) exOut.push({ lab: lab + ' [BVB]', amt: -b });
    }
  }
}
CORNER_DEDUCTIONS.forEach((x) => exOut.push({ lab: x.lab, amt: x.amt }));

// ===== 2. Kéo web TKHIEP (CHỈ đã duyệt + chưa xoá; tuỳ chọn chốt đến ngày) =====
const cutoff = process.argv[3];
if (cutoff && !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) { console.error('Ngày chốt phải dạng YYYY-MM-DD'); process.exit(1); }
if (cutoff) console.log('Ngày chốt web:', cutoff, '(Excel nhập sau ngày này sẽ hiện là EXCEL-only — tự bỏ qua)');
const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `select voucher_date d, type, total_amount amt, name from income_expenses
            where account_id='${TKHIEP_ID}' and deleted_at is null and approval_status='APPROVED'
            ${cutoff ? `and voucher_date <= '${cutoff}'` : ''}
            order by voucher_date;`,
  }),
});
if (!res.ok) { console.error('Query lỗi', res.status, (await res.text()).slice(0, 500)); process.exit(1); }
const web = await res.json();

// ===== 3. Tổng hợp =====
const exThu = exIn.reduce((s, e) => s + e.amt, 0);
const exChi = exOut.reduce((s, e) => s + e.amt, 0);
const wThu = web.filter((v) => v.type === 'INCOME').reduce((s, v) => s + Number(v.amt), 0);
const wChi = web.filter((v) => v.type === 'EXPENSE').reduce((s, v) => s + Number(v.amt), 0);
console.log('\n=== TỔNG HỢP ===');
console.log(`  EXCEL : thu ${fmt(exThu).padStart(13)} | chi ${fmt(exChi).padStart(13)} | dư ${fmt(exThu - exChi).padStart(13)}`);
console.log(`  WEB   : thu ${fmt(wThu).padStart(13)} | chi ${fmt(wChi).padStart(13)} | dư ${fmt(wThu - wChi).padStart(13)}`);
console.log(`  CHÊNH (Web−Excel): thu ${fmt(wThu - exThu)} | chi ${fmt(wChi - exChi)} | dư ${fmt((wThu - wChi) - (exThu - exChi))}`);

// ===== 4. Khớp từng khoản =====
// Gộp phiếu tổng của web theo (ngày + tên gốc trước " - " cuối) — vd "Điện Lạnh T5 cụm của Hiệp - vệ sinh" × 25
const rootOf = (s) => { s = (s || '').trim(); const i = s.lastIndexOf(' - '); return i > 8 ? s.slice(0, i) : s; };
const aggregate = (list) => {
  const map = {};
  list.forEach((v) => {
    const k = v.d + '||' + rootOf(v.name);
    (map[k] = map[k] || { d: v.d, name: rootOf(v.name), amt: 0, n: 0 });
    map[k].amt += Number(v.amt); map[k].n++;
  });
  return Object.values(map);
};

function match(exArr, wArr, label) {
  const used = new Array(wArr.length).fill(false);
  // 1 Excel = 1 web
  let exUn = [];
  exArr.forEach((e) => {
    const i = wArr.findIndex((w, x) => !used[x] && Math.abs(w.amt - e.amt) < 1);
    if (i >= 0) used[i] = true; else exUn.push(e);
  });
  // 1 Excel = 2 web
  const exUn2 = [];
  exUn.forEach((e) => {
    let ok = false;
    outer: for (let i = 0; i < wArr.length; i++) {
      if (used[i]) continue;
      for (let j = i + 1; j < wArr.length; j++) {
        if (used[j]) continue;
        if (Math.abs(wArr[i].amt + wArr[j].amt - e.amt) < 1) { used[i] = used[j] = true; ok = true; break outer; }
      }
    }
    if (!ok) exUn2.push(e);
  });
  // 2 Excel = 1 web
  const exUsed = new Array(exUn2.length).fill(false);
  wArr.forEach((w, wi) => {
    if (used[wi]) return;
    outer: for (let i = 0; i < exUn2.length; i++) {
      if (exUsed[i]) continue;
      for (let j = i + 1; j < exUn2.length; j++) {
        if (exUsed[j]) continue;
        if (Math.abs(exUn2[i].amt + exUn2[j].amt - w.amt) < 1) { exUsed[i] = exUsed[j] = true; used[wi] = true; break outer; }
      }
    }
  });
  const exFinal = exUn2.filter((_, i) => !exUsed[i]);
  const wFinal = wArr.filter((_, i) => !used[i]);
  const a = exFinal.reduce((s, e) => s + e.amt, 0), b = wFinal.reduce((s, e) => s + e.amt, 0);
  console.log(`\n===== ${label} =====`);
  console.log(`EXCEL-only (Excel có, web TKHIEP KHÔNG có) — tổng ${fmt(a)}:`);
  exFinal.sort((x, y) => y.amt - x.amt).forEach((e) => console.log(`  ${fmt(e.amt).padStart(12)}  ${e.lab}`));
  console.log(`WEB-only (TKHIEP có, Excel KHÔNG có) — tổng ${fmt(b)}:`);
  wFinal.sort((x, y) => y.amt - x.amt).forEach((w) => console.log(`  ${fmt(w.amt).padStart(12)}  ${w.d}  ${(w.name || '').slice(0, 55)}${w.n > 1 ? `  (${w.n} phiếu)` : ''}`));
  console.log(`>>> Net (Excel-only − Web-only) = ${fmt(a - b)}`);
  return a - b;
}
const dThu = match(exIn, aggregate(web.filter((v) => v.type === 'INCOME')), 'THU');
const dChi = match(exOut, aggregate(web.filter((v) => v.type === 'EXPENSE')), 'CHI');
console.log('\n=== KIỂM CHỨNG ===');
console.log(`Chênh số dư (Web − Excel) = NetCHI − NetTHU = ${fmt(dChi - dThu)} (phải khớp dòng CHÊNH dư ở trên)`);
console.log('Lưu ý: cặp lệch còn lại đọc theo docs/doi-chieu-so-quy-686tcb.md mục "Bẫy thường gặp".');
