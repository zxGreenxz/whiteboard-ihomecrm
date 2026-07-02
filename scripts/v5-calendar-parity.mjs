// Parity check: SQL public.vn_workdays ≡ TS workdaysInMonth trên 24 tháng liên tiếp
// (DoD S1 — chạy sau mỗi lần sửa calendar ở 1 trong 2 phía).
// Dùng: node scripts/v5-calendar-parity.mjs
import { readFileSync } from "node:fs";

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  const local = readFileSync(new URL("../CLAUDE.local.md", import.meta.url), "utf8");
  pat = local.match(/sbp_[a-f0-9]+/)?.[0];
}
const ref = "tryymsxyyckgbrmmvozx";

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// --- TS mirror (copy thuần từ src/lib/v5Calendar.ts — giữ đồng bộ tay, file TS là chuẩn) ---
const pad = (n) => String(n).padStart(2, "0");
const toIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dow = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
function workdaysTs(y, m, holidays) {
  const hol = new Set(holidays);
  const out = [];
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    const iso = toIso(y, m, d);
    if (dow(iso) !== 0 && !hol.has(iso)) out.push(iso);
  }
  return out;
}

// Lấy holidays của owner từ DB (đúng nguồn SQL dùng)
const holRows = await sql(
  `SELECT holiday_date::text AS d FROM salary_holidays WHERE user_id = (SELECT user_id FROM super_admins ORDER BY created_at LIMIT 1);`,
);
const holidays = holRows.map((r) => r.d);

let fail = 0;
const start = new Date(Date.UTC(2026, 0, 1)); // 24 tháng từ 2026-01
for (let i = 0; i < 24; i++) {
  const y = start.getUTCFullYear() + Math.floor((start.getUTCMonth() + i) / 12);
  const m = ((start.getUTCMonth() + i) % 12) + 1;
  const sqlRows = await sql(`SELECT d::text FROM vn_workdays('${toIso(y, m, 1)}') AS d ORDER BY 1;`);
  const sqlDays = sqlRows.map((r) => r.d);
  const tsDays = workdaysTs(y, m, holidays);
  const ok = JSON.stringify(sqlDays) === JSON.stringify(tsDays);
  if (!ok) {
    fail++;
    console.log(`MISMATCH ${y}-${pad(m)}: SQL=${sqlDays.length} TS=${tsDays.length}`);
    const sqlSet = new Set(sqlDays);
    const tsSet = new Set(tsDays);
    console.log("  chỉ SQL:", sqlDays.filter((d) => !tsSet.has(d)).join(","));
    console.log("  chỉ TS :", tsDays.filter((d) => !sqlSet.has(d)).join(","));
  } else {
    console.log(`OK ${y}-${pad(m)}: ${sqlDays.length} ngày-làm`);
  }
}
console.log(fail === 0 ? "\nPARITY PASS (24/24 tháng)" : `\nPARITY FAIL (${fail} tháng lệch)`);
process.exit(fail === 0 ? 0 : 1);
