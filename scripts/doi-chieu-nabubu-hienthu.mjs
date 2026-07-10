// Đối chiếu bảng chốt tiền mặt NABUBU của Hiển (Excel) với sổ quỹ Hiển Thu trên web.
// Quy tắc chi tiết: docs/doi-chieu-nabubu-hienthu.md
// Dùng: node scripts/doi-chieu-nabubu-hienthu.mjs [file.xlsx] [YYYY-MM-DD]
//   - file.xlsx : mặc định "dataexcel/NABUBU T7-1.xlsx"
//   - YYYY-MM-DD: ngày chốt — chỉ lấy phiếu web đến hết ngày này (mặc định: hôm nay)
// Kỳ đối chiếu tự xác định = sau lần "Bàn giao tiền mặt" gần nhất trong sổ Hiển Thu.
// PAT đọc từ env SUPABASE_PAT hoặc CLAUDE.local.md (không in ra console).
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';

const REF = 'tryymsxyyckgbrmmvozx';
const HIENTHU_ID = 'dc45114c-734f-45aa-9946-bed05e0c9051'; // sổ quỹ Hiển Thu (TK000031)

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
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
async function q(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) { console.error('Query lỗi', res.status, (await res.text()).slice(0, 500)); process.exit(1); }
  return res.json();
}

// ===== 1. Đọc Excel (copy ra temp trước — file hay bị Excel lock) =====
const src = process.argv[2] || new URL('../dataexcel/NABUBU T7-1.xlsx', import.meta.url);
const cutoff = process.argv[3] || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) { console.error('Ngày chốt phải dạng YYYY-MM-DD'); process.exit(1); }
const tmp = join(mkdtempSync(join(tmpdir(), 'nabubu-')), 'wb.xlsx');
copyFileSync(src, tmp);
const wb = XLSX.readFile(tmp);
const ws = wb.Sheets[wb.SheetNames[0]];
const d = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// Header: dòng chứa "TÒA NHÀ" + "PHÒNG". Cột phải (mệnh giá × số tờ = tiền) đọc riêng.
const headIdx = d.findIndex((r) => r.some((c) => String(c).toUpperCase().includes('TÒA NHÀ')));
if (headIdx < 0) { console.error('Không thấy header "TÒA NHÀ" trong sheet'); process.exit(1); }

const exRooms = []; // {bld, room, amt, thoi, note}
const exUng = [];   // {amt, note}
let denomTotal = null; // TỔNG của bảng đếm mệnh giá (cột phải)
let listTotal = null;  // dòng TỔNG cột trái
let toa = '';
let mode = 'rooms';
let pendingTotal = false;
for (let i = headIdx + 1; i < d.length; i++) {
  const r = d[i];
  const c0 = String(r[0] ?? '').trim();
  // Bảng mệnh giá bên phải: mệnh giá (số) | số tờ | thành tiền — hoặc dòng "TỔNG" | | thành tiền
  if (String(r[7] ?? '').toUpperCase() === 'TỔNG' && num(r[9]) > 0) denomTotal = num(r[9]);
  if (!r.slice(0, 5).some((c) => c !== '')) continue; // trái trống (chỉ có khối bên phải)
  // dòng TỔNG có khi bị tách 2 dòng sau khi chèn/xoá dòng: chữ ở trên, số rơi xuống dưới
  if (pendingTotal) {
    pendingTotal = false;
    if (!c0 && num(r[1]) > 0 && num(r[2]) === 0) { listTotal = num(r[1]); continue; }
  }
  if (c0.toUpperCase() === 'TỔNG') { listTotal = num(r[1]); pendingTotal = listTotal === 0; continue; }
  if (c0.toUpperCase().includes('ỨNG')) {
    mode = 'ung';
    // Chèn/xoá dòng hay làm nhãn cột A trôi 1 dòng: nếu dòng "ỨNG TIỀN" vẫn còn
    // PHÒNG|TIỀN MẶT thì đó thực chất là dòng phòng cuối của toà trước đó.
    const room0 = String(r[1] ?? '').trim().toUpperCase();
    if (room0 && num(r[2]) > 0) {
      console.log(`  ⚠ dòng ${i + 1}: nhãn ỨNG TIỀN đè lên dòng phòng ${room0} = ${fmt(num(r[2]))} → vẫn tính là phòng của ${toa}; nhãn toà cột A có thể đang trôi 1 dòng, sửa lại file!`);
      exRooms.push({ bld: toa, room: room0, amt: num(r[2]), thoi: num(r[3]), note: '' });
      continue;
    }
  }
  if (mode === 'ung') {
    const amt = num(r[1]);
    if (amt > 0) exUng.push({ amt, note: String(r[4] ?? '').trim() });
    continue;
  }
  if (c0 !== '') toa = c0.split(/\s+/)[0].toUpperCase();
  if (num(r[4]) >= 100000) console.log(`  ⚠ dòng ${i + 1}: có ${fmt(num(r[4]))} nằm ở cột GHI CHÚ — KHÔNG được cộng vào thu, kiểm tra lại file!`);
  const room = String(r[1] ?? '').trim().toUpperCase();
  const amt = num(r[2]);
  if (!room || amt <= 0) continue;
  exRooms.push({ bld: toa, room, amt, thoi: num(r[3]), note: String(r[4] ?? '').trim() });
}
const exThu = exRooms.reduce((s, e) => s + e.amt - e.thoi, 0);
const exUngSum = exUng.reduce((s, e) => s + e.amt, 0);
console.log(`EXCEL: ${exRooms.length} dòng phòng = ${fmt(exThu)} | ứng ${exUng.length} khoản = ${fmt(exUngSum)} | còn lại = ${fmt(exThu - exUngSum)}`);
if (listTotal != null && Math.abs(listTotal - (exThu - exUngSum)) > 0.5)
  console.log(`  ⚠ dòng TỔNG trên Excel = ${fmt(listTotal)} ≠ thu − ứng = ${fmt(exThu - exUngSum)} (Excel tự cộng sai?)`);
if (denomTotal != null) {
  console.log(`  Tiền đếm theo mệnh giá = ${fmt(denomTotal)}${Math.abs(denomTotal - (exThu - exUngSum)) < 0.5 ? ' (khớp danh sách − ứng)' : ` ⚠ LỆCH ${fmt(denomTotal - (exThu - exUngSum))} so với danh sách − ứng`}`);
}

// ===== 2. Kỳ đối chiếu = sau lần Bàn giao gần nhất =====
const bg = await q(`
  select voucher_date d, total_amount amt, name from income_expenses
  where account_id='${HIENTHU_ID}' and deleted_at is null and approval_status='APPROVED'
    and type='EXPENSE' and (handover_transfer_id is not null or name like 'Bàn giao%')
    and voucher_date <= '${cutoff}'
  order by voucher_date desc limit 1;`);
const from = bg.length ? bg[0].d : '1900-01-01';
console.log(`\nKỳ web: sau bàn giao ${bg.length ? `${bg[0].d} (${fmt(bg[0].amt)})` : '(chưa từng bàn giao)'} → đến hết ${cutoff}`);

// ===== 3. Kéo phiếu web sổ Hiển Thu trong kỳ =====
const web = await q(`
  select ie.code, ie.voucher_date d, ie.type, ie.total_amount amt, ie.change_amount chg,
         b.name bld, r.name room, ie.name, ie.approval_status st
  from income_expenses ie
  left join buildings b on b.id = ie.building_id
  left join rooms r on r.id = ie.room_id
  where ie.account_id='${HIENTHU_ID}' and ie.deleted_at is null
    and ie.voucher_date > '${from}' and ie.voucher_date <= '${cutoff}'
  order by ie.voucher_date;`);
const unappr = web.filter((v) => v.st !== 'APPROVED' && v.st !== 'CANCELLED');
if (unappr.length) {
  console.log(`⚠ ${unappr.length} phiếu CHƯA DUYỆT trong kỳ (không tính vào tổng):`);
  unappr.forEach((v) => console.log(`   ${v.d} ${v.code} ${v.type} ${fmt(v.amt)} ${String(v.name).slice(0, 50)}`));
}
const ok = web.filter((v) => v.st === 'APPROVED');
const wThuList = ok.filter((v) => v.type === 'INCOME');
const wChiList = ok.filter((v) => v.type === 'EXPENSE');
const wThu = wThuList.reduce((s, v) => s + Number(v.amt), 0);
const wChi = wChiList.reduce((s, v) => s + Number(v.amt), 0);

console.log('\n=== TỔNG HỢP ===');
console.log(`  EXCEL : thu ${fmt(exThu).padStart(13)} | ứng/chi ${fmt(exUngSum).padStart(12)} | tồn quỹ ${fmt(exThu - exUngSum).padStart(13)}`);
console.log(`  WEB   : thu ${fmt(wThu).padStart(13)} | chi     ${fmt(wChi).padStart(12)} | số dư   ${fmt(wThu - wChi).padStart(13)}`);
console.log(`  CHÊNH (Web−Excel): thu ${fmt(wThu - exThu)} | chi ${fmt(wChi - exUngSum)} | dư ${fmt((wThu - wChi) - (exThu - exUngSum))}`);

// ===== 4. Khớp THU theo (toà, phòng) — multiset số tiền =====
const key = (b, r) => `${String(b || '—').toUpperCase()}|${String(r || '?').toUpperCase()}`;
const exMap = new Map(); // key -> [amt,...] (đã trừ thối tay nếu Hiển có ghi)
exRooms.forEach((e) => { const k = key(e.bld, e.room); (exMap.get(k) || exMap.set(k, []).get(k)).push(e.amt - e.thoi); });
const wMap = new Map();
wThuList.forEach((v) => { const k = key(v.bld, v.room); (wMap.get(k) || wMap.set(k, []).get(k)).push(Number(v.amt)); });

const diffs = [];
for (const k of new Set([...exMap.keys(), ...wMap.keys()])) {
  const ex = (exMap.get(k) || []).slice().sort((a, b) => a - b);
  const w = (wMap.get(k) || []).slice().sort((a, b) => a - b);
  // rút các cặp bằng nhau
  for (let i = ex.length - 1; i >= 0; i--) {
    const j = w.findIndex((x) => Math.abs(x - ex[i]) < 0.5);
    if (j >= 0) { ex.splice(i, 1); w.splice(j, 1); }
  }
  if (ex.length || w.length) diffs.push({ k, ex, w, net: ex.reduce((s, x) => s + x, 0) - w.reduce((s, x) => s + x, 0) });
}
console.log('\n===== LỆCH THU theo phòng (đã rút cặp khớp) =====');
if (!diffs.length) console.log('  (khớp 100%)');
diffs.sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).forEach(({ k, ex, w, net }) => {
  console.log(`  ${k.padEnd(15)} Excel=[${ex.map(fmt).join(', ')}] Web=[${w.map(fmt).join(', ')}]  → Excel−Web = ${fmt(net)}`);
});
const netThu = diffs.reduce((s, x) => s + x.net, 0);
console.log(`  >>> Net THU (Excel − Web) = ${fmt(netThu)}`);

// ===== 5. Khớp ỨNG/CHI theo số tiền =====
const chiLeft = wChiList.map((v) => ({ ...v, amt: Number(v.amt) }));
const ungLeft = [];
exUng.forEach((u) => {
  let remain = u.amt;
  // 1 khoản ứng có thể = nhiều phiếu chi (vd 6tr công an = 6 phiếu 1tr): rút dần các phiếu chưa dùng
  let guard = chiLeft.length + 1;
  while (remain > 0.5 && guard--) {
    const i = chiLeft.findIndex((c) => c.amt <= remain + 0.5);
    if (i < 0) break;
    remain -= chiLeft[i].amt; chiLeft.splice(i, 1);
  }
  if (remain > 0.5) ungLeft.push({ ...u, remain });
});
console.log('\n===== LỆCH ỨNG/CHI =====');
if (!ungLeft.length && !chiLeft.length) console.log('  (khớp 100%)');
ungLeft.forEach((u) => console.log(`  EXCEL-only: ứng ${fmt(u.remain)} / ${fmt(u.amt)} — ${u.note.slice(0, 60)}`));
chiLeft.forEach((c) => console.log(`  WEB-only  : ${c.d} ${c.code} ${fmt(c.amt)} ${String(c.name).replace(/\n/g, ' ').slice(0, 60)}`));

// ===== 6. Chốt =====
console.log('\n=== KIỂM CHỨNG ===');
console.log(`Tồn quỹ web ${fmt(wThu - wChi)} − tiền đếm ${fmt(denomTotal ?? exThu - exUngSum)} = ${fmt((wThu - wChi) - (denomTotal ?? exThu - exUngSum))} (phải = −Net THU ${fmt(-netThu)} nếu ứng/chi khớp)`);
console.log('Đọc cách xử lý từng loại lệch: docs/doi-chieu-nabubu-hienthu.md');
