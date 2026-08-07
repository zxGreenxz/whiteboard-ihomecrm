#!/usr/bin/env node
// Sinh contracts/surfaces/realtime-surface.json — biên thứ ba mà hợp đồng là
// một chuỗi, và là biên IM LẶNG NHẤT trong ba.
//
// VÌ SAO IM LẶNG NHẤT
//   Gọi RPC sai tên → 404. Gọi Edge sai slug → 404. Nhưng subscribe một bảng
//   KHÔNG nằm trong publication `supabase_realtime` thì không có lỗi nào cả:
//   `subscribe()` vẫn trả SUBSCRIBED, không cảnh báo, không dòng log. Giao diện
//   chỉ lặng lẽ ngừng tự cập nhật, và người dùng bấm F5 rồi nghĩ mình nhớ nhầm.
//
//   Án lệ có thật: contract_terminations và contract_transfers từng vắng ở CẢ
//   publication lẫn danh sách hub, nên "mọi thay đổi thanh lý / chuyển phòng là
//   im lặng hoàn toàn" suốt một thời gian mà không ai biết.
//
// QUAN HỆ VỚI check-realtime-descriptors.mjs
//   Gate kia trả lời MỘT câu hỏi nhị phân: bảng hub nghe có được publish không.
//   File này ghi lại TOÀN CẢNH để diff được: bảng nào được publish, ai nghe,
//   bảng nào publish mà không hệ nào trong repo nghe (thừa băng thông và thừa bề
//   mặt lộ dữ liệu), REPLICA IDENTITY của từng bảng — thiếu FULL thì payload
//   DELETE/UPDATE chỉ có khoá chính, và code đọc cột khác sẽ nhận undefined.
//
//   node scripts/generate-realtime-surface.mjs
//   node scripts/generate-realtime-surface.mjs --in
//
// Cần SUPABASE_PAT. CHỈ ĐỌC.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hoiCatalog, pat } from "./generate-rpc-surface.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DUONG_DAN_RT = join("contracts", "surfaces", "realtime-surface.json");

export const SQL_REALTIME = `
  select
    t.tablename as name,
    case c.relreplident
      when 'd' then 'DEFAULT'  -- chỉ khoá chính trong payload cũ
      when 'f' then 'FULL'     -- đủ mọi cột
      when 'i' then 'INDEX'
      when 'n' then 'NOTHING'
    end as replica_identity,
    c.relrowsecurity as rls_enabled
  from pg_publication_tables t
  join pg_class c on c.relname = t.tablename
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = t.schemaname
  where t.pubname = 'supabase_realtime' and t.schemaname = 'public'
  order by 1
`;

/**
 * Đọc danh sách bảng hub qua vite-node — CHÍNH module nguồn, không chép tay.
 * Repo đã có bốn ca "test kiểm bản chép thay vì kiểm code thật".
 */
export function docHubTables() {
  const tmp = join(repoRoot, "node_modules", ".cache", "__rt-surface.ts");
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
    // Đường dẫn TƯƠNG ĐỐI + shell:true: npx trên Windows là npx.cmd (Node từ chối
    // spawn .cmd khi shell:false), mà shell:true không bọc nháy đối số — đường dẫn
    // repo có dấu cách. Cùng bẫy đã cắn ba gate khác.
    const r = spawnSync("npx", ["vite-node", "node_modules/.cache/__rt-surface.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: true,
      timeout: 10 * 60 * 1000,
    });
    const m = r.stdout?.match(/\[".*"\]/);
    if (r.status !== 0 || !m) return null;
    return JSON.parse(m[0]);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Hệ nào ngoài hub tự lắng nghe bảng nào.
 *
 * PHẢI PHỦ HAI DẠNG KHAI, và bản đầu chỉ phủ một:
 *   (a) chuỗi tại chỗ — `{ event: "*", schema: "public", table: "zalo_messages" }`
 *       (useZaloChat, useNotifications);
 *   (b) shorthand lặp qua HẰNG — `for (const table of NETWORK_CENTER_REALTIME_TABLES)`
 *       rồi `{ event: "*", schema: "public", table }` (Network Center, OpenClaw).
 *
 * Bản chỉ bắt (a) báo 12 bảng network_ và openclaw_ là "publish mà không ai nghe"
 * — sai hoàn toàn, vì đó là hai hệ realtime bận nhất. Một manifest khẳng định sai
 * như vậy tệ hơn không có manifest: nó sẽ được dùng làm căn cứ để GỠ bảng khỏi
 * publication, và hậu quả là im lặng tuyệt đối đúng như án lệ contract_transfers.
 *
 * Đây là lần thứ n của cùng một mẫu lỗi trong repo này: bộ lọc chỉ phủ MỘT biến
 * thể cú pháp.
 */
export function timNguoiNgheKhac(docFile, danhSachFile, hangDanhSach = {}) {
  const nghe = new Map();
  const them = (bang, f) => {
    if (!nghe.has(bang)) nghe.set(bang, new Set());
    nghe.get(bang).add(f.replace(/\\/g, "/"));
  };

  // Dạng (b): hằng đã được nạp sẵn qua vite-node, kèm file khai nó.
  for (const [file, bangs] of Object.entries(hangDanhSach)) {
    for (const b of bangs) them(b, file);
  }

  // Dạng (a): chuỗi tại chỗ.
  for (const f of danhSachFile) {
    const s = docFile(f);
    if (s === null) continue;
    if (!/postgres_changes|\.channel\s*\(/.test(s)) continue;
    const sach = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    for (const m of sach.matchAll(/table:\s*["'`]([a-zA-Z0-9_]+)["'`]/g)) them(m[1], f);
  }
  return nghe;
}

/**
 * Nạp mọi hằng danh sách bảng realtime khai trong repo, qua vite-node.
 *
 * Tìm bằng `export const <TÊN>` chứa cả REALTIME lẫn TABLES, thay vì liệt kê tay
 * hai cái đang biết — liệt kê tay thì hệ thứ ba ra đời sẽ vô hình.
 */
export function nạpHangDanhSach(docFile, danhSachFile) {
  const nguon = [];
  for (const f of danhSachFile) {
    const s = docFile(f);
    if (s === null) continue;
    for (const m of s.matchAll(/export const ([A-Z0-9_]*REALTIME[A-Z0-9_]*TABLES|[A-Z0-9_]*TABLES[A-Z0-9_]*REALTIME[A-Z0-9_]*)\s*=/g)) {
      nguon.push({ file: f.replace(/\\/g, "/"), ten: m[1] });
    }
  }
  if (nguon.length === 0) return { hang: {}, nguon };

  const tmp = join(repoRoot, "node_modules", ".cache", "__rt-consts.ts");
  mkdirSync(dirname(tmp), { recursive: true });
  const imports = nguon
    .map((n, i) => `import { ${n.ten} as c${i} } from "../../${n.file.replace(/\.tsx?$/, "")}";`)
    .join("\n");
  const body = `console.log(JSON.stringify({${nguon.map((n, i) => `${JSON.stringify(n.file)}: [...c${i}]`).join(",")}}));`;
  writeFileSync(tmp, `${imports}\n${body}\n`, "utf8");
  try {
    const r = spawnSync("npx", ["vite-node", "node_modules/.cache/__rt-consts.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: true,
      timeout: 10 * 60 * 1000,
    });
    const m = r.stdout?.match(/\{".*\}/);
    if (r.status !== 0 || !m) return { hang: null, nguon, loi: (r.stderr || r.stdout || "").slice(0, 400) };
    return { hang: JSON.parse(m[0]), nguon };
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function dungManifestRt(hangPub, hub, ngheKhac) {
  const pub = new Map(hangPub.map((r) => [r.name, r]));
  const moi = [...new Set([...pub.keys(), ...hub, ...ngheKhac.keys()])].sort();

  const tables = {};
  const hubKhongPublish = [];
  const publishKhongAiNghe = [];
  for (const t of moi) {
    const p = pub.get(t);
    const boiHub = hub.includes(t);
    // Bỏ chính file khai danh sách hub ra khỏi "người nghe khác" — nó đã được
    // biểu diễn bằng `listenedByHub`, để lại sẽ đọc như có hai hệ cùng nghe.
    const khac = [...(ngheKhac.get(t) ?? [])].filter((f) => f !== "src/lib/realtime/syncTables.ts").sort();
    tables[t] = {
      published: Boolean(p),
      replicaIdentity: p?.replica_identity ?? null,
      rlsEnabled: p?.rls_enabled ?? null,
      listenedByHub: boiHub,
      otherListeners: khac,
    };
    if (boiHub && !p) hubKhongPublish.push(t);
    if (p && !boiHub && khac.length === 0) publishKhongAiNghe.push(t);
  }
  return { tables, hubKhongPublish, publishKhongAiNghe };
}

export function lietKeFileRt() {
  return spawnSync("git", ["ls-files", "src/**/*.ts", "src/**/*.tsx", "services/**/*.ts", "infra/**/*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1e8,
  })
    .stdout.split(/\r?\n/)
    .filter(Boolean);
}

async function main() {
  if (!pat()) {
    console.error("=== ⚠ KHÔNG SINH ĐƯỢC — thiếu SUPABASE_PAT hoặc CLAUDE.local.md ===");
    process.exit(3);
  }
  const doc = (f) => {
    try {
      return readFileSync(join(repoRoot, f), "utf8");
    } catch {
      return null;
    }
  };
  const hub = docHubTables();
  if (!hub) {
    console.error("❌ Không đọc được REALTIME_SYNC_TABLES qua vite-node.");
    process.exit(3);
  }
  const hangPub = await hoiCatalog(SQL_REALTIME);
  const files = lietKeFileRt();
  const { hang, nguon, loi } = nạpHangDanhSach(doc, files);
  if (hang === null) {
    // KHÔNG rơi về "chỉ dò chuỗi tại chỗ": làm vậy sẽ sinh ra manifest khẳng định
    // 12 bảng không ai nghe, tức một lời nói dối trông như bằng chứng.
    console.error(`❌ Không nạp được ${nguon.length} hằng danh sách bảng qua vite-node.`);
    console.error(loi ?? "");
    process.exit(3);
  }
  const ngheKhac = timNguoiNgheKhac(doc, files, hang);
  const kq = dungManifestRt(hangPub, hub, ngheKhac);

  const manifest = {
    $comment:
      "BỀ MẶT REALTIME — biên im lặng nhất trong ba. Subscribe một bảng không được publish KHÔNG báo lỗi: subscribe() vẫn trả SUBSCRIBED, giao diện chỉ lặng lẽ ngừng tự cập nhật. Sinh từ HAI nguồn: pg_publication_tables (live) và call site trong mã nguồn (hub + hệ tự lắng nghe). Sinh bởi scripts/generate-realtime-surface.mjs; kiểm bởi scripts/check-realtime-descriptors.mjs (câu hỏi nhị phân) và scripts/check-realtime-surface.mjs (chống trôi).",
    counts: {
      published: hangPub.length,
      listenedByHub: hub.length,
      otherListenerTables: ngheKhac.size,
      // DEFAULT nghĩa là payload UPDATE/DELETE chỉ có khoá chính. Code đọc cột
      // khác từ payload đó sẽ nhận undefined mà không có lỗi nào.
      replicaIdentityDefault: hangPub.filter((r) => r.replica_identity === "DEFAULT").length,
    },
    hubWithoutPublication: kq.hubKhongPublish,
    publishedWithNoListener: kq.publishKhongAiNghe,
    tables: kq.tables,
  };

  if (process.argv.includes("--in")) {
    console.log(JSON.stringify({ ...manifest, tables: undefined }, null, 2));
    return;
  }
  mkdirSync(join(repoRoot, "contracts", "surfaces"), { recursive: true });
  writeFileSync(join(repoRoot, DUONG_DAN_RT), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `✅ ${DUONG_DAN_RT}: ${hangPub.length} bảng publish · ${hub.length} hub nghe · ` +
      `${kq.publishKhongAiNghe.length} publish mà không ai nghe`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(3);
  });
}
