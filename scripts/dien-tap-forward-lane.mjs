#!/usr/bin/env node
// Replay FORWARD LANE (mọi migration > cutoff) lên đích diễn tập vừa khôi phục
// baseline, rồi đối chiếu với SỔ KỲ VỌNG — hai chiều, khớp cả thông điệp.
//
// VÌ SAO "APPLY SẠCH 100%" KHÔNG PHẢI TIÊU CHÍ
//   Baseline là SCHEMA-ONLY (manifest ghi containsData: false), còn nhiều
//   migration của repo này KHẲNG ĐỊNH TRÊN DỮ LIỆU THẬT trước khi dám chạy:
//   "Chỉ xoá được 0 dòng — quá ít so với 165.548", "Không có người dùng thường
//   nào để nghiệm thu. DỪNG." Trên database rỗng, DỪNG là chúng làm ĐÚNG việc;
//   ép chúng xanh là tự tạo một phép kiểm không bao giờ xanh, hoặc tệ hơn —
//   seed dữ liệu giả cho qua, tức làm mù chính chốt đo của migration.
//
//   Tiêu chí đúng (đo 13/08/2026, 39 file): SỐ LỖI SCHEMA THẬT = 0. File nào
//   dừng-vì-dữ-liệu hay chết-theo (cascade) thì khai trong
//   supabase/baseline/forward-lane-expectations.json kèm why + thông điệp.
//
// VÌ SAO ĐỐI CHIẾU HAI CHIỀU VÀ KHỚP THÔNG ĐIỆP
//   · File có entry mà CHẠY SẠCH → đỏ. Nghĩa là môi trường diễn tập vừa "dễ
//     hơn thực tế" (ai đó seed dữ liệu?) hoặc entry đã thối. Cả hai đáng biết.
//   · File dừng nhưng SAI thông điệp → đỏ. Một file dung-vi-du-lieu chết vì
//     lý do KHÁC (lỗi schema mới) mà chỉ so "có lỗi/không" thì lỗi mới được
//     entry cũ che mất — đúng lớp xanh-rỗng mà bài diễn tập sinh ra để chống.
//   · Entry mồ côi (không khớp file nào trên đĩa) → đỏ. Sổ đang nói về thứ
//     không tồn tại.
//
//   node scripts/dien-tap-forward-lane.mjs --dich "postgresql://…"
//   PSQL_DOCKER=<container> node scripts/dien-tap-forward-lane.mjs --dich "…"
//
// Chạy SAU dien-tap-khoi-phuc-baseline.mjs trên CÙNG đích. KHÔNG idempotent:
// replay lần hai trên cùng database sẽ khác kết quả (nhiều file đã có hiệu
// ứng) — muốn chạy lại thì khôi phục baseline lại từ đầu.
// Thoát: 0 = khớp sổ kỳ vọng · 1 = lệch · 3 = không kiểm được.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { giaiMoc, taoTruyVanRetirement } from "./check-forward-migration-idempotent.mjs";
import { chanProduction, coPsql, goiPsql } from "./lib/goi-psql-dich.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(repoRoot, "supabase", "migrations");
const POLICY = join(repoRoot, "supabase", "migration-policy.json");
const KY_VONG = join(repoRoot, "supabase", "baseline", "forward-lane-expectations.json");
const MANIFEST = join(repoRoot, "supabase", "baseline", "manifest.json");
const ACL_FIXTURE = join(repoRoot, "supabase", "baseline", "restore-settlement-acl-fixture.json");
const ACL_FIXTURE_SHA256 = "d2cf8ca8a71190720627e5804feb47c1e478b29d399a13a17e83ae1b36d89b41";
const RESTORE_GROUP = "restore-before-contract-settlement-2026-09-21";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const literal = (s) => s === null ? "NULL" : "'" + s.replaceAll("'", "''") + "'";

// Baseline explicitly discarded ACL. Reconstruct ONLY the measured missing
// privileges, before the feature's original SQL; never replace function bodies.
// Both ends are catalog assertions, so a different raw baseline fails closed.
export function taoFixtureAcl(text, digest, group) {
  // JSON checkout may use CRLF on Windows; pin its canonical LF text.
  if (sha256(text.replaceAll("\r\n", "\n")) !== digest) throw Error("drill ACL fixture digest mismatch");
  const fixture = JSON.parse(text);
  if (!group || fixture.groupId !== group.id || fixture.firstMigration !== group.migrations[0].file
    || fixture.functions?.length !== 22 || new Set(fixture.functions.map(f => f.signature)).size !== 22) throw Error("drill ACL fixture shape mismatch");
  const roleList = (acl, owner) => {
    if (acl === null) return ["PUBLIC", owner];
    if (!/^\{[a-z_=X/,]+\}$/.test(acl)) throw Error("drill ACL fixture invalid ACL");
    return acl.slice(1, -1).split(",").map(item => {
      const [role, privilege] = item.split("=");
      if (privilege !== `X/${owner}` || (role && !/^[a-z_]+$/.test(role))) throw Error("drill ACL fixture invalid grant");
      return role || "PUBLIC";
    });
  };
  for (const f of fixture.functions) {
    if (!/^(public|app_private)\.[a-z_0-9]+\([a-z_0-9,\[\]]*\)$/.test(f.signature)
      || !/^[a-f0-9]{32}$/.test(f.before?.md5) || f.before.md5 !== f.after?.md5
      || f.before.owner !== "postgres" || f.after.owner !== "postgres") throw Error("drill ACL fixture changes definition/owner");
    roleList(f.before.acl, f.before.owner); roleList(f.after.acl, f.after.owner);
    const target = group.witness.functions.find(t => t.signature === f.signature);
    if (target && ["md5", "owner", "acl"].some(k => f.after[k] !== target.after[k])) throw Error("drill ACL fixture disagrees with retirement witness");
  }
  if (!group.witness.functions.every(f => fixture.functions.some(t => t.signature === f.signature))) throw Error("drill ACL fixture missing restored target");
  const guard = (state) => `DO $drill_acl$ DECLARE f record; p record; BEGIN
 FOR f IN SELECT * FROM (VALUES ${fixture.functions.map(f => `(${[f.signature, f[state].md5, f[state].owner, f[state].acl].map(literal).join(",")})`).join(",\n")}) e(signature,md5,owner,acl) LOOP
 SELECT md5(pg_get_functiondef(oid)) AS md5,proowner::regrole::text AS owner,proacl::text AS acl INTO p FROM pg_proc WHERE oid=to_regprocedure(f.signature);
 IF NOT FOUND OR p.md5 IS DISTINCT FROM f.md5 OR p.owner IS DISTINCT FROM f.owner OR p.acl IS DISTINCT FROM f.acl THEN RAISE EXCEPTION 'drill ACL ${state} drift: %',f.signature; END IF;
 END LOOP; END $drill_acl$;`;
  const changes = fixture.functions.filter(f => f.before.acl !== f.after.acl).map(f => {
    if (f.after.acl === null) throw Error("drill ACL fixture cannot reconstruct NULL ACL");
    return `REVOKE ALL ON FUNCTION ${f.signature} FROM ${roleList(f.before.acl, f.before.owner).join(",")};\n` +
      roleList(f.after.acl, f.after.owner).map(role => `GRANT EXECUTE ON FUNCTION ${f.signature} TO ${role};`).join("\n");
  });
  return `BEGIN;\nSET LOCAL search_path=public,pg_catalog;\nDO $role$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(group.witness.role)}) THEN RAISE EXCEPTION 'drill ACL reader role exists before feature'; END IF; END $role$;\n${guard("before")}\n${changes.join("\n")}\n${guard("after")}\nCOMMIT;`;
}

export function kiemCatalogPhucHoi(group, catalog, restored) {
  const w = group.witness;
  if (!catalog || catalog.functions?.length !== 44 || catalog.triggers?.length !== 5 || catalog.rolePresent !== !restored) throw Error("drill restore catalog size/role drift");
  const fn = new Map(catalog.functions.map(f => [f.signature, f]));
  const tr = new Map(catalog.triggers.map(t => [`${t.relation}:${t.name}`, t]));
  if (fn.size !== 44 || tr.size !== 5 || w.functions.length !== 14 || w.removedFunctions.length !== 30 || w.removedTriggers.length !== 3 || w.retainedTriggers.length !== 2) throw Error("drill restore catalog duplicates/manifest drift");
  for (const f of [...w.functions.map(f => ({ signature: f.signature, ...f[restored ? "after" : "before"] })), ...w.removedFunctions.map(f => restored ? { signature: f.signature, md5: null, owner: null, acl: null } : f)]) {
    if (!fn.has(f.signature) || ["md5", "owner", "acl"].some(k => fn.get(f.signature)[k] !== f[k])) throw Error(`drill restore catalog function drift: ${f.signature}`);
  }
  for (const t of [...w.removedTriggers.map(t => restored ? { ...t, md5: null, enabled: null } : t), ...w.retainedTriggers]) {
    const actual = tr.get(`${t.relation}:${t.name}`);
    if (!actual || ["md5", "enabled"].some(k => actual[k] !== t[k])) throw Error(`drill restore catalog trigger drift: ${t.name}`);
  }
}

/** Sàn chống rỗng: forward lane hiện 39 file — quét ra dưới mức này nghĩa là
 *  cutoff/glob hỏng chứ không phải lane teo lại, và "0 lệch" khi đó vô nghĩa. */
export const TOI_THIEU_FILE = 10;

export function docCutoff() {
  const p = JSON.parse(readFileSync(POLICY, "utf8"));
  return String(p.provisionalCutoff?.version ?? "");
}

/** Chỉ file .sql có version 14 chữ số SAU cutoff, theo thứ tự apply. */
export function chonFileForwardLane(tenTrenDia, cutoff) {
  return tenTrenDia
    .filter((t) => {
      const m = t.match(/^(\d{14})_.+\.sql$/);
      return Boolean(m) && m[1] > cutoff;
    })
    .sort();
}

function dauLoi(stderr) {
  const dong = String(stderr || "").split(/\r?\n/).find((l) => /ERROR|FATAL/.test(l));
  return (dong || String(stderr || "").trim().split(/\r?\n/)[0] || "(không có stderr)").slice(0, 220);
}

/**
 * Đối chiếu kết quả chạy với sổ kỳ vọng. Thuần tuý, không I/O — test được.
 * ketQua: [{ ten, ok, stderr }] theo thứ tự chạy.
 *
 * `phamVi` (28/08/2026): Set tên file thuộc diff của push đang kiểm; `null` =
 * strict toàn bộ (hành vi cũ). Drill kích hoạt bởi paths supabase/migrations/**
 * nên migration của phiên A thiếu entry từng làm PR của phiên B đỏ. Replay vẫn
 * TUẦN TỰ TOÀN BỘ (tính đúng của lane phụ thuộc chuỗi), chỉ phần đối chiếu là
 * scoped: lệch ở file NGOÀI phạm vi hạ xuống `LECH-NGOAI-PHAM-VI` — in đầy đủ
 * chi tiết nhưng không đánh trượt; mọi chiều với file TRONG phạm vi giữ cứng.
 * Nợ cảnh báo tích tụ được quét bởi run cron strict hàng tuần (xem workflow).
 *
 * Trả { dat, dong: [{ ten, trangThai, chiTiet? }] } với trangThai:
 *   'chay-sach' | 'dung-dung-ky-vong' | 'LECH' | 'LECH-NGOAI-PHAM-VI'.
 */
export function doiChieuKyVong(ketQua, kyVong, phamVi = null) {
  const dong = [];
  const daCham = new Set();
  const nhanLech = (ten) => (phamVi && !phamVi.has(ten) ? "LECH-NGOAI-PHAM-VI" : "LECH");
  for (const k of ketQua) {
    daCham.add(k.ten);
    const e = kyVong[k.ten];
    if (!e) {
      if (k.ok) dong.push({ ten: k.ten, trangThai: "chay-sach" });
      else
        dong.push({
          ten: k.ten,
          trangThai: nhanLech(k.ten),
          chiTiet: `LỖI mà không có trong sổ kỳ vọng — lỗi schema thật, hoặc khẳng định dữ liệu mới chưa được phân loại: ${dauLoi(k.stderr)}`,
        });
    } else if (k.ok) {
      dong.push({
        ten: k.ten,
        trangThai: nhanLech(k.ten),
        chiTiet: `sổ kỳ vọng nói phải DỪNG (${e.kyVong}) mà lại chạy sạch — môi trường diễn tập "dễ hơn thực tế", hoặc entry đã thối`,
      });
    } else if (!String(k.stderr || "").includes(e.thongDiep)) {
      dong.push({
        ten: k.ten,
        trangThai: nhanLech(k.ten),
        chiTiet: `dừng nhưng SAI thông điệp — kỳ vọng chứa "${e.thongDiep}", nhận: ${dauLoi(k.stderr)}`,
      });
    } else {
      dong.push({ ten: k.ten, trangThai: "dung-dung-ky-vong" });
    }
  }
  for (const ten of Object.keys(kyVong)) {
    if (!daCham.has(ten)) {
      dong.push({
        ten,
        trangThai: nhanLech(ten),
        chiTiet: "entry trong sổ kỳ vọng không khớp file nào sau cutoff trên đĩa — file đã bị đổi tên/xoá, hoặc entry gõ sai tên",
      });
    }
  }
  return { dat: dong.every((d) => d.trangThai !== "LECH"), dong };
}

function main(argv) {
  const dich = argv[argv.indexOf("--dich") + 1];
  if (!dich || !/^postgres(ql)?:\/\//.test(dich)) {
    console.error('Dùng: node scripts/dien-tap-forward-lane.mjs --dich "postgresql://…"');
    return 3;
  }
  if (!coPsql()) {
    console.error("❌ Không tìm thấy psql. Cài PostgreSQL client 17+, HOẶC đặt PSQL_DOCKER=<container>.");
    return 3;
  }
  for (const p of [POLICY, KY_VONG, MANIFEST]) {
    if (!existsSync(p)) {
      console.error(`❌ Thiếu ${p.replace(repoRoot, ".")} — không đối chiếu được.`);
      return 3;
    }
  }
  try {
    chanProduction(dich, MANIFEST);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    return 3;
  }

  const cutoff = docCutoff();
  if (!/^\d{14}$/.test(cutoff)) {
    console.error(`❌ Cutoff đọc từ migration-policy.json không hợp lệ: "${cutoff}"`);
    return 3;
  }
  const files = chonFileForwardLane(readdirSync(MIGRATIONS), cutoff);
  if (files.length < TOI_THIEU_FILE) {
    console.error(`❌ Chỉ quét ra ${files.length} file sau cutoff ${cutoff} (sàn ${TOI_THIEU_FILE}) — glob/cutoff hỏng, "0 lệch" lúc này vô nghĩa.`);
    return 3;
  }

  const kyVong = JSON.parse(readFileSync(KY_VONG, "utf8")).expectations ?? {};
  let restoreGroup; let fixtureSql;
  try {
    const groups = JSON.parse(readFileSync(POLICY, "utf8")).idempotencyRetirements?.filter(g => g.id === RESTORE_GROUP);
    if (groups?.length !== 1) throw Error("drill restore retirement group missing/duplicate");
    restoreGroup = groups[0];
    // This fixture is for a disposable, local drill only, never a remote DB.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(dich).hostname)) throw Error("drill ACL fixture requires a local disposable database");
    fixtureSql = taoFixtureAcl(readFileSync(ACL_FIXTURE, "utf8"), ACL_FIXTURE_SHA256, restoreGroup);
    for (const f of [...restoreGroup.migrations, restoreGroup.compensation]) {
      if (!files.includes(f.file) || sha256(readFileSync(join(MIGRATIONS, f.file), "utf8")) !== f.sha256) throw Error(`drill immutable migration digest mismatch: ${f.file}`);
    }
  } catch (error) {
    console.error(`❌ Không dựng được scenario phục hồi: ${error.message}`);
    return 3;
  }

  // --moc <ref>: đối chiếu CỨNG chỉ cho file thuộc diff moc..HEAD (28/08/2026)
  // — xem chú thích doiChieuKyVong. Replay vẫn tuần tự đủ. Dùng diff ĐẦY ĐỦ
  // (không --diff-filter=A): file bị xoá/đổi tên trong push này cũng thuộc
  // trách nhiệm của nó, entry mồ côi tương ứng phải cứng.
  const iMoc = argv.indexOf("--moc");
  let phamVi = null;
  if (iMoc >= 0) {
    const coRef = (r) => {
      try {
        execFileSync("git", ["rev-parse", "--verify", "-q", `${r}^{commit}`], {
          cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        });
        return true;
      } catch { return false; }
    };
    const moc = giaiMoc(argv[iMoc + 1] ?? "", coRef);
    if (moc.kieu === "scoped") {
      phamVi = new Set(
        execFileSync("git", ["diff", "--name-only", `${moc.moc}..HEAD`, "--", "supabase/migrations"], {
          cwd: repoRoot, encoding: "utf8",
        }).split("\n").filter(Boolean).map((p) => p.replace(/\\/g, "/").split("/").pop()),
      );
      console.log(`Đối chiếu CỨNG cho ${phamVi.size} file thuộc diff ${moc.moc}..HEAD; lệch ở file ngoài diff chỉ cảnh báo.`);
    } else {
      console.log(`⚠ --moc: ${moc.lyDo} — đối chiếu STRICT toàn bộ (chiều an toàn).`);
    }
  }

  console.log(`Replay forward lane: ${files.length} file sau cutoff ${cutoff}`);
  console.log(`  đích: ${dich.replace(/:[^:@/]+@/, ":***@")}\n`);

  const t0 = Date.now();
  const ketQua = [];
  const psqlOptions = { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 };
  const checkCatalog = (restored) => {
    const r = goiPsql(["-d", dich, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", taoTruyVanRetirement(restoreGroup)], psqlOptions);
    if (r.status !== 0) throw Error(`drill catalog query failed: ${dauLoi(r.stderr)}`);
    kiemCatalogPhucHoi(restoreGroup, JSON.parse(String(r.stdout).trim()), restored);
  };
  for (const ten of files) {
    if (ten === restoreGroup.migrations[0].file) {
      console.log("→ RAW baseline --no-acl không giữ ACL production: fixture cục bộ kiểm 22 hash/owner/ACL, khôi phục đúng 15 ACL; không đổi body hay dữ liệu.");
      const r = goiPsql(["-d", dich, "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], { ...psqlOptions, input: fixtureSql });
      if (r.status !== 0) {
        console.error(`❌ Fixture ACL lệch trạng thái baseline đã đo: ${dauLoi(r.stderr)}`);
        return 1;
      }
    }
    if (ten === restoreGroup.compensation.file) {
      try {
        checkCatalog(false);
        for (let replay = 1; replay <= 2; replay++) {
          const r = goiPsql(["-d", dich, "-q", "-v", "ON_ERROR_STOP=1", "-f", join(MIGRATIONS, ten)], psqlOptions);
          if (r.status !== 0) throw Error(`compensation replay ${replay}: ${dauLoi(r.stderr)}`);
          checkCatalog(true);
        }
        console.log("→ Scenario phục hồi PASS: 15 SQL gốc dựng đủ witness 44 hàm/5 trigger/role; compensation nguyên digest chạy 2 lượt và witness sau mỗi lượt khớp.");
        ketQua.push({ ten, ok: true, stderr: "" });
      } catch (error) {
        // This gate is mandatory even outside --moc scope; no expected failure.
        console.error(`❌ Scenario phục hồi thất bại: ${error.message}`);
        return 1;
      }
      continue;
    }
    const r = goiPsql(["-d", dich, "-q", "-v", "ON_ERROR_STOP=1", "-f", join(MIGRATIONS, ten)], {
      encoding: "utf8",
      timeout: 5 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0 && restoreGroup.migrations.some(m => m.file === ten)) {
      console.error(`❌ Migration dựng đầu vào scenario phải chạy sạch, kể cả ngoài --moc: ${ten}: ${dauLoi(r.stderr)}`);
      return 1;
    }
    ketQua.push({ ten, ok: r.status === 0, stderr: String(r.stderr || "") });
  }

  const { dat, dong } = doiChieuKyVong(ketQua, kyVong, phamVi);
  const dem = { "chay-sach": 0, "dung-dung-ky-vong": 0, LECH: 0, "LECH-NGOAI-PHAM-VI": 0 };
  for (const d of dong) {
    dem[d.trangThai] += 1;
    if (d.trangThai === "LECH") console.error(`  ✗ ${d.ten}\n      ${d.chiTiet}`);
    // In ĐẦY ĐỦ chi tiết cho lệch ngoài phạm vi — hạ mức không có nghĩa là giấu.
    if (d.trangThai === "LECH-NGOAI-PHAM-VI") console.warn(`  ⚠ ${d.ten} (ngoài diff — không đánh trượt)\n      ${d.chiTiet}`);
  }
  console.log(
    `\n${Math.round((Date.now() - t0) / 1000)}s · ${dem["chay-sach"]} chạy sạch · ${dem["dung-dung-ky-vong"]} dừng đúng kỳ vọng · ${dem.LECH} LỆCH` +
      (phamVi ? ` · ${dem["LECH-NGOAI-PHAM-VI"]} lệch ngoài diff (cảnh báo — cron tuần sẽ quét strict)` : ""),
  );
  if (!dat) {
    console.error("\n❌ Forward lane LỆCH sổ kỳ vọng — xem từng dòng ✗ ở trên.");
    return 1;
  }
  console.log("✅ Forward lane khớp sổ kỳ vọng trên baseline có fixture ACL lịch sử; scenario phục hồi đã kiểm 2 lượt. Baseline RAW tự nó không bảo toàn ACL.");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
