// Đối chiếu kênh TM (khách đưa − thối lại) trong Excel của Nathan với sổ quỹ Hiệp Thu (TK000032).
// Quy tắc chung: docs/doi-chieu/so-quy-686tcb.md (mapping mục 1: TM ↔ Hiệp Thu).
// Dùng: node scripts/doi-chieu-tm-hiepthu.mjs [file.xlsx] [YYYY-MM-DD]
// Ghi chú riêng kênh TM:
//   - T6/T7: net = cột "khách đưa" − cột "thối lại" (phiếu web đã net tiền thối — xem memory).
//   - T5: cột "khách đưa TM" ĐÃ là số ròng → dùng thẳng, KHÔNG trừ thối lần nữa.
//   - Web Hiệp Thu có phiếu CHI (bàn giao tiền cho chủ) — Excel TM không theo dõi → chỉ liệt kê tham khảo.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

const REF = 'tryymsxyyckgbrmmvozx';
const HIEPTHU_ID = 'e564eb1e-e47c-4c8f-92a1-76873b5bfb0e'; // Hiệp Thu (TK000032)
const FIRST_MONTH = 5;

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const num = (v) => (typeof v === 'number' ? v : 0);

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch {}
}
if (!pat) { console.error('Không tìm thấy PAT'); process.exit(1); }

// ===== 1. Đọc Excel (copy ra temp — file hay bị Excel lock) =====
const src = process.argv[2] || new URL('../dataexcel/danh sách thu tiền v2.xlsx', import.meta.url);
const tmp = join(mkdtempSync(join(tmpdir(), 'doichieu-tm-')), 'wb.xlsx');
copyFileSync(src, tmp);
const wb = XLSX.readFile(tmp);

const monthSheets = wb.SheetNames
  .map((n) => ({ n, m: /^tháng (\d+)$/.exec(n)?.[1] }))
  .filter((x) => x.m && Number(x.m) >= FIRST_MONTH)
  .sort((a, b) => Number(a.m) - Number(b.m));
console.log('Sheets đối chiếu:', monthSheets.map((x) => x.n).join(', '));

const skipRow = (r) => {
  const j = r.join('|').toLowerCase();
  const cf = /còn lại của (?:tháng\s*)?t?\s*(\d+)/.exec(j);
  if (cf) return Number(cf[1]) >= FIRST_MONTH;
  return j.includes('tổng') || j.includes('tk tcb') || j.includes('số dư')
    || j.includes('tiền ihome') || j.includes('tiền hiệp');
};

const exIn = []; // thu TM {lab, amt, month}
const exOut = []; // dòng ÂM ở cột khách đưa = chi/bàn giao TM
const exByMonth = {}; // {m: {in, out}}
for (const { n, m } of monthSheets) {
  const d = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' });
  const head = d[0].map((c) => String(c));
  const kdIdx = head.findIndex((c) => c.toLowerCase().includes('khách đưa'));
  const tlIdx = head.findIndex((c) => c.toLowerCase().includes('thối lại'));
  if (kdIdx < 0) { console.error(`[${n}] không dò được cột "khách đưa": ${head.join(' | ')}`); process.exit(1); }
  const isNet = head[kdIdx].includes('TM'); // T5: "khách đưa TM" đã ròng
  let toa = '';
  for (let i = 1; i < d.length; i++) {
    const r = d[i];
    if (!r.some((c) => c !== '')) continue;
    if (r[0] !== '') toa = String(r[0]).trim();
    if (skipRow(r)) continue;
    // Dòng không có nhãn toà lẫn nhãn phòng = dòng tổng kết tay (runbook mục 2) —
    // vd cuối sheet: tổng cột khách đưa/thối lại + dòng net (thối ghi số âm) → đếm đôi nếu giữ.
    if (String(r[0]).trim() === '' && String(r[1]).trim() === '') continue;
    const gross = num(r[kdIdx]);
    const change = isNet ? 0 : (tlIdx >= 0 ? num(r[tlIdx]) : 0);
    const net = gross - change;
    if (net === 0) continue;
    const lab = `[${n}] ${(toa ? toa.split(' ')[0] + ' ' : '')}${String(r[1] || '').trim()}`;
    const bm = (exByMonth[m] = exByMonth[m] || { in: 0, out: 0 });
    if (net > 0) { exIn.push({ lab, amt: net, month: Number(m) }); bm.in += net; }
    else { exOut.push({ lab, amt: -net, month: Number(m) }); bm.out += -net; }
  }
}

// ===== 2. Kéo web Hiệp Thu =====
const cutoff = process.argv[3];
if (cutoff && !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) { console.error('Ngày chốt phải dạng YYYY-MM-DD'); process.exit(1); }
if (cutoff) console.log('Ngày chốt web:', cutoff);
const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `select voucher_date d, type, total_amount amt, name, approval_status st from income_expenses
            where account_id='${HIEPTHU_ID}' and deleted_at is null
            ${cutoff ? `and voucher_date <= '${cutoff}'` : ''}
            order by voucher_date;`,
  }),
});
if (!res.ok) { console.error('Query lỗi', res.status, (await res.text()).slice(0, 500)); process.exit(1); }
const all = await res.json();
const unapproved = all.filter((v) => v.st !== 'APPROVED');
const web = all.filter((v) => v.st === 'APPROVED');
const wIn = web.filter((v) => v.type === 'INCOME');
const wOut = web.filter((v) => v.type === 'EXPENSE');

// ===== 3. Tổng hợp =====
const exThu = exIn.reduce((s, e) => s + e.amt, 0);
const exChi = exOut.reduce((s, e) => s + e.amt, 0);
const wThu = wIn.reduce((s, v) => s + Number(v.amt), 0);
const wChi = wOut.reduce((s, v) => s + Number(v.amt), 0);
console.log('\n=== TỔNG HỢP TM ===');
console.log(`  EXCEL : thu ${fmt(exThu).padStart(14)} | chi ${fmt(exChi).padStart(14)} | dư ${fmt(exThu - exChi).padStart(14)}`);
console.log(`  WEB   : thu ${fmt(wThu).padStart(14)} | chi ${fmt(wChi).padStart(14)} | dư ${fmt(wThu - wChi).padStart(14)}`);
console.log(`  CHÊNH (Web−Excel): thu ${fmt(wThu - exThu)} | chi ${fmt(wChi - exChi)} | dư ${fmt((wThu - wChi) - (exThu - exChi))}`);

console.log('\n=== THEO THÁNG (Web − Excel) ===');
const wByMonth = {};
web.forEach((v) => {
  const m = Number(v.d.slice(5, 7));
  const bm = (wByMonth[m] = wByMonth[m] || { in: 0, out: 0 });
  if (v.type === 'INCOME') bm.in += Number(v.amt); else bm.out += Number(v.amt);
});
const months = [...new Set([...Object.keys(exByMonth), ...Object.keys(wByMonth)].map(Number))].sort((a, b) => a - b);
months.forEach((m) => {
  const e = exByMonth[m] || { in: 0, out: 0 }, w = wByMonth[m] || { in: 0, out: 0 };
  console.log(`  T${m}: THU Excel ${fmt(e.in).padStart(12)} | Web ${fmt(w.in).padStart(12)} | chênh ${fmt(w.in - e.in).padStart(11)}   ||  CHI Excel ${fmt(e.out).padStart(12)} | Web ${fmt(w.out).padStart(12)} | chênh ${fmt(w.out - e.out).padStart(11)}`);
});

if (unapproved.length) {
  console.log(`\n⚠ Phiếu Hiệp Thu CHƯA DUYỆT (${unapproved.length} — không tính vào web):`);
  unapproved.forEach((v) => console.log(`  ${fmt(v.amt).padStart(12)}  ${v.d}  [${v.type}] ${(v.name || '').slice(0, 60)}`));
}

// ===== 4. Khớp từng khoản =====
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
  let exUn = [];
  exArr.forEach((e) => {
    const i = wArr.findIndex((w, x) => !used[x] && Math.abs(w.amt - e.amt) < 1);
    if (i >= 0) used[i] = true; else exUn.push(e);
  });
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
  // Khớp lệch lẻ <1.000đ: Excel ghi ròng-nghìn (khách đưa − thối), web ghi đủ số hoá đơn
  // (phần lẻ vào sổ "Làm tròn tiền thiếu") → cặp lệch vài trăm đ là làm tròn, không phải sai.
  const exUn3 = exUn2.filter((_, i) => !exUsed[i]);
  const exUsed3 = new Array(exUn3.length).fill(false);
  const rounded = [];
  exUn3.forEach((e, ei) => {
    let best = -1, bd = 1000;
    wArr.forEach((w, x) => {
      if (used[x]) return;
      const d2 = Math.abs(w.amt - e.amt);
      if (d2 < bd) { bd = d2; best = x; }
    });
    if (best >= 0) { used[best] = true; exUsed3[ei] = true; rounded.push({ e, w: wArr[best], d: wArr[best].amt - e.amt }); }
  });
  const exFinal = exUn3.filter((_, i) => !exUsed3[i]);
  const wFinal = wArr.filter((_, i) => !used[i]);
  const a = exFinal.reduce((s, e) => s + e.amt, 0), b = wFinal.reduce((s, e) => s + e.amt, 0);
  console.log(`\n===== ${label} =====`);
  if (rounded.length) {
    const rd = rounded.reduce((s, x) => s + x.d, 0);
    console.log(`Khớp lệch lẻ <1.000đ (làm tròn): ${rounded.length} cặp, tổng lệch (Web−Excel) = ${fmt(rd)}`);
  }
  console.log(`EXCEL-only (Excel có, web Hiệp Thu KHÔNG có) — tổng ${fmt(a)}:`);
  exFinal.sort((x, y) => y.amt - x.amt).forEach((e) => console.log(`  ${fmt(e.amt).padStart(12)}  ${e.lab}`));
  console.log(`WEB-only (Hiệp Thu có, Excel KHÔNG có) — tổng ${fmt(b)}:`);
  wFinal.sort((x, y) => y.amt - x.amt).forEach((w) => console.log(`  ${fmt(w.amt).padStart(12)}  ${w.d}  ${(w.name || '').slice(0, 55)}${w.n > 1 ? `  (${w.n} phiếu)` : ''}`));
  console.log(`>>> Net (Excel-only − Web-only) = ${fmt(a - b)}`);
  return a - b;
}
const dThu = match(exIn, aggregate(wIn), 'THU TM');
const dChi = match(exOut, aggregate(wOut), 'CHI TM (dòng âm cột khách đưa = bàn giao/chi hộ)');
console.log('\n=== KIỂM CHỨNG ===');
console.log(`Chênh dư (Web − Excel) ≈ NetCHI − NetTHU = ${fmt(dChi - dThu)} (± tổng lệch làm tròn)`);
console.log('Lưu ý: cặp lệch đọc theo docs/doi-chieu/so-quy-686tcb.md mục "Bẫy thường gặp" (tiền có thể nằm ở sổ Tâm Thu/TK939/CỌC/Chung, hoặc phiếu tổng tách con).');
