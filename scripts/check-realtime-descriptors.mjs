#!/usr/bin/env node
// Gate: mọi bảng hub realtime lắng nghe PHẢI nằm trong publication
// `supabase_realtime` trên production.
//
// VÌ SAO CẦN
//   Lệch chiều này là im lặng TUYỆT ĐỐI. Subscribe một bảng không được publish
//   thì Supabase không đẩy sự kiện nào — không lỗi, không cảnh báo, không dòng
//   log. Giao diện chỉ đơn giản không tự cập nhật nữa, và người dùng bấm F5 rồi
//   nghĩ mình nhớ nhầm. Không test đơn vị nào bắt được: hub vẫn đăng ký thành
//   công, `subscribe()` vẫn trả SUBSCRIBED.
//
//   Án lệ nằm ngay trong file hub: `contract_terminations` và
//   `contract_transfers` từng không có mặt ở cả hai nơi, nên "mọi thay đổi thanh
//   lý / chuyển phòng là im lặng hoàn toàn" (ghi chú Đợt 1).
//
//   node scripts/check-realtime-descriptors.mjs
//
// Cần SUPABASE_PAT (hoặc CLAUDE.local.md khi chạy local). Chỉ ĐỌC catalog.
// Thoát 3 khi chưa đủ điều kiện chạy — "không kiểm được" khác "đã kiểm và đạt".

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Sàn chống rỗng-vô-nghĩa.
 *
 * Nếu bộ đọc danh sách hỏng (đổi tên export, vite-node lỗi) thì `hub` thành
 * rỗng, vòng so chạy 0 lần, và gate in dấu tick. Hệ thống CHẮC CHẮN có hàng chục
 * bảng realtime — 0 nghĩa là phép đo hỏng, không phải "không có gì lệch".
 */
const TOI_THIEU_BANG = 10;

function pat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT;
  try {
    return readFileSync(join(repoRoot, "CLAUDE.local.md"), "utf8").match(/sbp_[a-f0-9]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Bảng hub lắng nghe mà publication KHÔNG có ⇒ subscribe câm. */
export function timBangCam(hub, publication) {
  return hub.filter((t) => !publication.has(t)).sort();
}

function docDanhSachHub() {
  // Đọc CHÍNH module nguồn qua vite-node, không chép tay danh sách sang đây —
  // repo này đã có bốn ca "test kiểm bản chép thay vì kiểm code thật", và một
  // bản chép trong gate là cách chắc chắn để gate xanh trong khi code đã đổi.
  const tmp = join(repoRoot, "node_modules", ".cache", "__realtime-tables.ts");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(
    tmp,
    [
      'import { REALTIME_SYNC_TABLES } from "../../src/lib/realtime/syncTables";',
      "console.log(JSON.stringify([...REALTIME_SYNC_TABLES]));",
    ].join("\n"),
    "utf8",
  );
  try {
    // Đường dẫn TƯƠNG ĐỐI + shell:true: npx trên Windows là npx.cmd (Node từ
    // chối spawn .cmd khi shell:false), mà shell:true lại không bọc nháy đối số
    // — đường dẫn tuyệt đối "C:\Users\Nguyen Tam\…" sẽ bị cắt ở dấu cách.
    // Cùng bẫy đã cắn check-permission-catalog.mjs.
    return spawnSync("npx", ["vite-node", "node_modules/.cache/__realtime-tables.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: true,
      timeout: 10 * 60 * 1000,
    });
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function main() {
  const token = pat();
  if (!token) {
    console.error("=== ⚠ KHÔNG KIỂM ĐƯỢC — KHÔNG PHẢI PASS ===");
    console.error("  Thiếu SUPABASE_PAT (env) hoặc CLAUDE.local.md.");
    console.error("  Thoát 3 = chưa đủ điều kiện chạy (khác 1 = LỆCH thật).");
    process.exit(3);
  }

  const dump = docDanhSachHub();
  const found = dump.stdout?.match(/\[".*"\]/);
  if (dump.status !== 0 || !found) {
    console.error("❌ Không đọc được REALTIME_SYNC_TABLES:", dump.error?.message ?? `exit ${dump.status}`);
    console.error((dump.stderr || dump.stdout || "").slice(0, 600));
    process.exit(3);
  }
  const hub = JSON.parse(found[0]);
  if (hub.length < TOI_THIEU_BANG) {
    console.error(`❌ Chỉ đọc được ${hub.length} bảng (sàn ${TOI_THIEU_BANG}) — phép đo hỏng, KHÔNG phải "không lệch".`);
    process.exit(3);
  }

  const ref = readFileSync(join(repoRoot, "supabase", "config.toml"), "utf8").match(/project_id\s*=\s*"([^"]+)"/)[1];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'",
    }),
  });
  if (!res.ok) {
    console.error(`❌ Không gọi được Management API: ${res.status} ${(await res.text()).slice(0, 200)}`);
    process.exit(3);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error("❌ Publication `supabase_realtime` trả 0 bảng — bất khả nếu realtime đang chạy.");
    console.error("   Truy vấn hoặc tên publication đã đổi. Không kết luận được.");
    process.exit(3);
  }
  const publication = new Set(rows.map((r) => r.tablename));

  const cam = timBangCam(hub, publication);
  console.log(`Realtime: hub lắng nghe ${hub.length} bảng · publication có ${publication.size} bảng`);

  if (cam.length > 0) {
    console.error(`\n❌ ${cam.length} bảng hub lắng nghe mà KHÔNG được publish — subscribe CÂM:`);
    for (const t of cam) console.error(`   - ${t}`);
    console.error("\n  Supabase sẽ không đẩy sự kiện nào cho những bảng này: không lỗi, không cảnh");
    console.error("  báo, giao diện chỉ lặng lẽ ngừng tự cập nhật.");
    console.error("  Vá: ALTER PUBLICATION supabase_realtime ADD TABLE public.<tên>;");
    process.exit(1);
  }

  // Chiều ngược lại chỉ CẢNH BÁO: publication rộng hơn hub là chuyện bình thường
  // (bảng dành cho hệ khác — Network Center, OpenClaw, notifications — có realtime
  // riêng, không đi qua hub này). Bắt đỏ ở đây sẽ là báo động giả triền miên.
  const ngoaiHub = [...publication].filter((t) => !hub.includes(t)).sort();
  console.log(`✅ Mọi bảng hub lắng nghe đều nằm trong publication.`);
  if (ngoaiHub.length > 0) {
    console.log(`   ℹ ${ngoaiHub.length} bảng được publish ngoài hub (hệ khác tự lắng nghe): ${ngoaiHub.slice(0, 6).join(", ")}${ngoaiHub.length > 6 ? "…" : ""}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("❌ Lỗi không lường trước:", e.message);
    process.exit(3);
  });
}
