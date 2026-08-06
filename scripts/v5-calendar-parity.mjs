// Parity check: SQL public.vn_workdays ≡ TS workdaysInMonth trên 24 tháng liên tiếp
// (DoD S1 — chạy sau mỗi lần sửa calendar ở 1 trong 2 phía).
// Dùng: node scripts/v5-calendar-parity.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

const pad = (n) => String(n).padStart(2, "0");
const toIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * Gọi HÀM TS THẬT trong src/lib/v5Calendar.ts, không chép lại nó.
 *
 * Trước đây file này mang một "TS mirror — copy thuần từ src/lib/v5Calendar.ts,
 * giữ đồng bộ tay". Header thì ghi "Parity check: SQL ≡ TS workdaysInMonth",
 * nhưng thứ nó thật sự so là SQL ≡ BẢN CHÉP. Nếu ai sửa v5Calendar.ts, gate vẫn
 * in "PARITY PASS" — tức nó không còn canh đúng thứ tên nó nói.
 *
 * Một gate parity mà một vế là bản chép tay thì không phải gate parity; nó chỉ
 * chứng minh SQL khớp với thứ người viết gate NGHĨ là TS.
 *
 * vite-node để chạy được TS + alias của dự án (cùng cách check-permission-catalog
 * đã dùng). Truyền đường dẫn TƯƠNG ĐỐI: với shell:true, Node không quote đối số
 * nên đường dẫn tuyệt đối chứa dấu cách bị cắt đôi.
 */
function workdaysTs(y, m, holidays) {
  const rel = "node_modules/.cache/__v5-parity.ts";
  const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    [
      `import { workdaysInMonth } from '../../src/lib/v5Calendar';`,
      `console.log(JSON.stringify(workdaysInMonth(${y}, ${m}, ${JSON.stringify(holidays)})));`,
    ].join("\n"),
    "utf8",
  );
  try {
    const r = spawnSync("npx", ["vite-node", rel], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      shell: true,
    });
    const found = r.stdout?.match(/\[.*\]/);
    if (r.status !== 0 || !found) {
      console.error("Không chạy được src/lib/v5Calendar.ts qua vite-node:");
      console.error((r.stderr || r.stdout || "").slice(0, 600));
      process.exit(2);
    }
    return JSON.parse(found[0]);
  } finally {
    rmSync(abs, { force: true });
  }
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
