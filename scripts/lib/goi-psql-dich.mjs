// Chạy psql lên một ĐÍCH diễn tập — psql cài sẵn trên máy, hoặc TRONG một
// container Docker qua PSQL_DOCKER=<tên container>.
//
// Tách ra từ dien-tap-khoi-phuc-baseline.mjs (13/08/2026) khi bài diễn tập mọc
// thêm hai bước dùng chung đường gọi này: replay forward lane và bộ kiểm bảo
// mật sau khôi phục. Ba script, một cách gọi — chép riêng từng nơi thì bài học
// stdin bên dưới sẽ phải học lại ba lần.
//
// VÌ SAO CÓ ĐƯỜNG DOCKER
//   Diễn tập đòi một PostgreSQL **dùng-một-lần đúng 17.6**. Máy dev thường
//   không có psql, và cài client 17 chỉ để diễn tập là rào cản đủ lớn để người
//   ta bỏ luôn việc diễn tập. Có Docker là đủ:
//
//     docker run -d --name pg-dientap -e POSTGRES_PASSWORD=… postgres:17.6
//     PSQL_DOCKER=pg-dientap node scripts/dien-tap-khoi-phuc-baseline.mjs \
//       --dich "postgresql://postgres:…@127.0.0.1:5432/postgres"
//
//   Chuỗi kết nối tính TỪ TRONG container, nên trỏ 127.0.0.1:5432 chứ không
//   phải cổng đã map ra máy.
//
// `-f <đường dẫn>` PHẢI đổi thành stdin khi đi qua Docker
//   File nằm trên máy chủ, container không thấy. Đọc trên máy rồi bơm qua stdin
//   với `-f -`. Không mount thư mục: baseline có thể nằm ngoài repo và mount
//   sai đường dẫn sẽ hỏng im lặng (psql báo "file rỗng" thay vì "không có file").

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const PSQL = ["C:/Program Files/PostgreSQL/17/bin/psql.exe", "psql"].find(
  (p) => p === "psql" || existsSync(p),
);

export const PSQL_DOCKER = process.env.PSQL_DOCKER || "";

/** Có đường chạy psql nào không — thiếu cả hai thì script phải dừng sớm. */
export function coPsql() {
  return Boolean(PSQL || PSQL_DOCKER);
}

// libpq accepts routing overrides from URI query keys and PG* defaults, even
// when the URI authority says 127.0.0.1. Restore replay cannot rely on that
// authority alone. Keep this opt-in so unrelated remote read callers retain
// their existing connection behavior.
export function admitLocalPsqlTarget(dich, env = process.env) {
  if (typeof dich !== "string" || !/^postgres(?:ql)?:\/\/(?:[^/?#@]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/[^?#]+$/.test(dich)) {
    throw Error("local restore target requires a single loopback URI without query, fragment or host override");
  }
  let url;
  try { url = new URL(dich); } catch { throw Error("local restore target URI is invalid"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.port === "0") {
    throw Error("local restore target must resolve to loopback");
  }
  const routingDefaults = /^(?:PGHOST|PGHOSTADDR|PGPORT|PGDATABASE|PGUSER|PGSERVICE|PGSERVICEFILE|PGSYSCONFDIR|PGOPTIONS|PGTARGETSESSIONATTRS)$/i;
  if (Object.entries(env).some(([key, value]) => routingDefaults.test(key) && value !== undefined && value !== "")) {
    throw Error("local restore target refuses inherited libpq routing defaults");
  }
  return dich;
}

export function goiPsql(args, opts = {}) {
  const { localOnly = false, ...spawnOptions } = opts;
  let argsRa = args;
  if (localOnly) {
    const targets = args.flatMap((arg, i) => arg === "-d" ? [args[i + 1]] : []);
    if (targets.length !== 1 || args.some(arg => ["-h", "--host", "-p", "--port", "--dbname"].includes(arg) || /^--(?:host|port|dbname)=/.test(arg))) {
      throw Error("local restore target requires one -d URI and no CLI routing override");
    }
    admitLocalPsqlTarget(targets[0], spawnOptions.env ?? process.env);
    // A client running with inherited PG* values could route elsewhere; the
    // container has a separate environment, so erase it inside docker exec.
    spawnOptions.env = Object.fromEntries(Object.entries(spawnOptions.env ?? process.env).filter(([key]) => !/^PG/i.test(key)));
    argsRa = ["-X", ...args]; // no ~/.psqlrc \connect before the fixture
  }
  if (!PSQL_DOCKER) return spawnSync(PSQL, argsRa, spawnOptions);

  const i = argsRa.indexOf("-f");
  let input;
  if (i >= 0 && argsRa[i + 1] && argsRa[i + 1] !== "-") {
    input = readFileSync(argsRa[i + 1], "utf8");
    argsRa = [...argsRa.slice(0, i + 1), "-", ...argsRa.slice(i + 2)];
  }
  // PHẢI ép stdin thành "pipe" khi có input — dù input đến từ `-f <file>` hay do
  // người gọi truyền thẳng opts.input. Người gọi truyền `stdio: ["ignore", …]`,
  // mà "ignore" ở khe 0 làm Node VỨT luôn `input` — lệnh vẫn chạy, vẫn trả mã 0,
  // chỉ là không nhận được gì. Bản đầu quên chỗ này và diễn tập báo "0 lỗi" trên
  // một schema 439 bảng trong 0 giây: xanh rỗng hoàn hảo, đúng thứ bài diễn tập
  // sinh ra để chống.
  const inputThat = input ?? spawnOptions.input;
  const stdio =
    inputThat === undefined
      ? spawnOptions.stdio
      : Array.isArray(spawnOptions.stdio)
        ? ["pipe", ...spawnOptions.stdio.slice(1)]
        : "pipe";
  const dockerArgs = localOnly
    ? ["exec", "-i", PSQL_DOCKER, "env", "-i", "PATH=/usr/lib/postgresql/17/bin:/usr/local/bin:/usr/bin:/bin", "psql", ...argsRa]
    : ["exec", "-i", PSQL_DOCKER, "psql", ...argsRa];
  return spawnSync("docker", dockerArgs, {
    ...spawnOptions,
    stdio,
    input: inputThat,
  });
}

/**
 * Hỏi một câu SQL, trả mảng dòng (đã trim, bỏ rỗng). Câu hỏi hỏng phải NỔ RA,
 * không được trả mảng rỗng rồi để phép đếm phía trên đọc thành "không có gì".
 */
export function hoi(dich, sql) {
  const r = goiPsql(["-d", dich, "-t", "-A", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`psql lỗi (${r.status}): ${String(r.stderr || "").slice(0, 300)}`);
  }
  return String(r.stdout || "").trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Hỏi một câu SQL trả JSON (bọc json_agg) — cho phép kiểm đọc nhiều cột mà
 * không phải tự tách chuỗi. Truyền qua stdin để không vướng giới hạn escape
 * của tham số dòng lệnh với những câu dài có regex.
 */
export function hoiJson(dich, sql) {
  const r = goiPsql(["-d", dich, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    encoding: "utf8",
    input: `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}\n) t;`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`psql lỗi (${r.status}): ${String(r.stderr || "").slice(0, 300)}`);
  }
  return JSON.parse(String(r.stdout || "").trim() || "[]");
}

/**
 * CHẶN CỨNG: từ chối mọi chuỗi kết nối chứa project ref production ghi trong
 * baseline manifest. Diễn tập ghi đè schema — trỏ nhầm vào production là mất
 * tất cả. Trả về manifest để người gọi dùng tiếp.
 */
export function chanProduction(dich, duongDanManifest) {
  const manifest = JSON.parse(readFileSync(duongDanManifest, "utf8"));
  if (manifest.sourceProject && dich.includes(manifest.sourceProject)) {
    throw new Error(`Chuỗi kết nối chứa "${manifest.sourceProject}" — đây là PRODUCTION. Dừng.`);
  }
  return manifest;
}
