// Test cho hai gate quản trị graph tri thức (PROJECT_CONTRACT §12).
//
// Vì sao cần test riêng thay vì chỉ chạy gate trên repo thật: gate chỉ chạy
// trên MỘT trạng thái (graph UA đang cũ, GitNexus đang mới). Mọi nhánh còn lại —
// graph tươi, artifact không nhất quán, chỉ mục sinh bởi công cụ chưa pin,
// policy bị nới quá trần — không bao giờ được thực thi, nên chúng có thể sai từ
// ngày đầu mà không ai biết. Đây đúng lớp lỗi đã cắn 19/20 gate của repo này.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  phanLoaiGitnexus,
  doiChieuNguon,
  timSubsystemThieu,
  danhGiaTuoi,
  verdictConHieuLuc,
} from "../check-graph-freshness.mjs";
import {
  phanLoaiCommit,
  doiChieuManifestVoiArtifact,
  kiemDongGhim,
  DONG_GHIM_CONTRACT,
} from "../check-graph-hygiene.mjs";

const POLICY = {
  hard: { maxCommitsBehind: 50, maxFilesDrifted: 150, maxMigrationsMissing: 10, maxMissingSubsystems: 0, requireToolVersion: true },
};
const TUOI = (p = {}) => ({
  commitsBehind: 0, filesDrifted: 0, migrationsMissing: 0, missingSubsystems: [], toolVersion: "2.9.4", ...p,
});

describe("phanLoaiGitnexus — ba trạng thái, gộp lại là hỏng luật", () => {
  const pinOk = { version: "1.6.9", status: "verified" };
  const pinChua = { version: "1.6.9", status: "blocked-until-version-is-verified" };

  it("chưa pin, chưa có chỉ mục ⇒ NOT_ADOPTED (không chặn ai bằng tool chưa tồn tại)", () => {
    assert.equal(phanLoaiGitnexus(pinChua, false), "NOT_ADOPTED");
    assert.equal(phanLoaiGitnexus(null, false), "NOT_ADOPTED");
  });

  it("đã pin verified, chưa có chỉ mục ⇒ MISSING (đã nhận thì phải sinh)", () => {
    assert.equal(phanLoaiGitnexus(pinOk, false), "MISSING");
  });

  it("có chỉ mục mà pin CHƯA verified ⇒ ADOPTED_KHONG_PIN", () => {
    // Nguy hiểm riêng: chỉ mục do một công cụ chưa ai kiểm sinh ra, nhưng nhìn
    // vào repo thì nó trông y hệt chỉ mục hợp lệ.
    assert.equal(phanLoaiGitnexus(pinChua, true), "ADOPTED_KHONG_PIN");
  });

  it("đủ cả hai ⇒ CO", () => {
    assert.equal(phanLoaiGitnexus(pinOk, true), "CO");
  });
});

describe("doiChieuNguon — ba nguồn baseCommit phải khớp", () => {
  const sha = "d0ffb0453e9336546d6d51579a4772c8d6e283f4";
  const ok = { gitCommitHash: sha };

  it("bốn nguồn khớp ⇒ không lỗi", () => {
    assert.equal(doiChieuNguon(ok, ok, ok, { baseCommit: sha }), null);
  });

  it("fingerprints lệch ⇒ báo lỗi", () => {
    // Sửa tay đúng một chỗ trong artifact là cách rẻ nhất để làm graph nói dối.
    assert.match(doiChieuNguon(ok, { gitCommitHash: "a".repeat(40) }, ok, { baseCommit: sha }), /lệch/);
  });

  it("manifest lệch artifact ⇒ báo lỗi", () => {
    assert.match(doiChieuNguon(ok, ok, ok, { baseCommit: "b".repeat(40) }), /lệch/);
  });

  it("thiếu baseCommit ở một nguồn ⇒ báo lỗi", () => {
    assert.match(doiChieuNguon(ok, ok, {}, { baseCommit: sha }), /thiếu/);
  });
});

describe("timSubsystemThieu — phép đo bắt graph MÙ, không chỉ graph CŨ", () => {
  it("thư mục có code mà graph không biết ⇒ liệt kê ra", () => {
    const tren = new Set(["src/lib", "services/openclaw-zalo-cell", "infra/network-center-worker"]);
    const trong = new Set(["src/lib"]);
    assert.deepEqual(timSubsystemThieu(tren, trong), ["infra/network-center-worker", "services/openclaw-zalo-cell"]);
  });

  it("graph phủ hết ⇒ rỗng", () => {
    const s = new Set(["src/lib", "src/hooks"]);
    assert.deepEqual(timSubsystemThieu(s, s), []);
  });
});

describe("danhGiaTuoi — từng ngưỡng phải cắn riêng", () => {
  it("mọi số trong ngưỡng + có toolVersion ⇒ đạt", () => {
    assert.equal(danhGiaTuoi(TUOI(), POLICY, true).dat, true);
  });

  it("vượt commit ⇒ không đạt", () => {
    assert.equal(danhGiaTuoi(TUOI({ commitsBehind: 51 }), POLICY, true).dat, false);
  });

  it("vượt file drift ⇒ không đạt", () => {
    assert.equal(danhGiaTuoi(TUOI({ filesDrifted: 151 }), POLICY, true).dat, false);
  });

  it("thiếu migration quá ngưỡng ⇒ không đạt", () => {
    assert.equal(danhGiaTuoi(TUOI({ migrationsMissing: 11 }), POLICY, true).dat, false);
  });

  it("MỘT tiểu hệ vắng mặt là đủ để trượt (ngưỡng 0)", () => {
    const r = danhGiaTuoi(TUOI({ missingSubsystems: ["services/x"] }), POLICY, true);
    assert.equal(r.dat, false);
    assert.match(r.loi.join(" "), /vắng mặt/);
  });

  it("toolVersion null ⇒ không đạt dù mọi số đều 0", () => {
    // Không biết công cụ nào sinh ra graph thì không kết luận được nó đúng.
    const r = danhGiaTuoi(TUOI({ toolVersion: null }), POLICY, true);
    assert.equal(r.dat, false);
    assert.match(r.loi.join(" "), /version công cụ/);
  });
});

describe("verdictConHieuLuc — ba điều kiện, thiếu một là chết", () => {
  const head = "c".repeat(40);
  const oid = "d".repeat(40);
  const now = Date.parse("2026-08-07T10:00:00.000Z");
  const v = { headCommit: head, policyDigest: oid, generatedAt: "2026-08-07T09:00:00.000Z" };

  it("đủ ba điều kiện ⇒ còn hiệu lực", () => {
    assert.equal(verdictConHieuLuc(v, head, now, oid, 240), true);
  });

  it("HEAD đã đổi ⇒ chết ngay, dù còn rất mới", () => {
    assert.equal(verdictConHieuLuc(v, "e".repeat(40), now, oid, 240), false);
  });

  it("quá TTL ⇒ chết", () => {
    assert.equal(verdictConHieuLuc(v, head, now, oid, 30), false);
  });

  it("policy đã đổi ⇒ chết (verdict phán theo luật cũ)", () => {
    assert.equal(verdictConHieuLuc(v, head, now, "f".repeat(40), 240), false);
  });

  it("không có verdict ⇒ chết", () => {
    assert.equal(verdictConHieuLuc(null, head, now, oid, 240), false);
  });
});

describe("phanLoaiCommit — luật #6: refresh graph đi riêng", () => {
  const allow = [".ua/", ".gitnexus/", ".gitignore", "tooling/graph-manifests/", "docs/"];
  const graphs = [".ua/", ".gitnexus/"];

  it("commit đụng graph + code ⇒ vi phạm", () => {
    const r = phanLoaiCommit([".ua/knowledge-graph.json", "src/App.tsx"], allow, graphs);
    assert.equal(r.xet, true);
    assert.deepEqual(r.viPham, ["src/App.tsx"]);
  });

  it("commit đụng graph + manifest + docs ⇒ sạch", () => {
    const r = phanLoaiCommit([".ua/meta.json", "tooling/graph-manifests/ua.json", "docs/x.md"], allow, graphs);
    assert.deepEqual(r.viPham, []);
  });

  it("commit KHÔNG đụng graph ⇒ không xét (luật chỉ áp cho commit graph)", () => {
    const r = phanLoaiCommit(["src/App.tsx", "package.json"], allow, graphs);
    assert.equal(r.xet, false);
  });

  it(".gitignore được phép đi kèm — nó không giấu được thay đổi hành vi", () => {
    const r = phanLoaiCommit([".ua/config.json", ".gitignore"], allow, graphs);
    assert.deepEqual(r.viPham, []);
  });
});

describe("doiChieuManifestVoiArtifact — hộ chiếu phải khớp hàng", () => {
  const sha = "d0ffb0453e9336546d6d51579a4772c8d6e283f4";
  const m = {
    baseCommit: sha, analyzedAt: "2026-07-29T14:02:16.449Z", analyzedFiles: 2120,
    scope: { description: "x" }, toolVersion: "2.9.4",
    configDigest: { ".ua/config.json": "git:bf23efcb" },
  };
  const a = {
    metaCommit: sha, fingerprintsCommit: sha, graphCommit: sha,
    soFile: 2120, digest: { ".ua/config.json": "git:bf23efcb" },
  };

  it("khớp hết ⇒ không lỗi", () => {
    assert.deepEqual(doiChieuManifestVoiArtifact(m, a), []);
  });

  it("thiếu trường scope ⇒ lỗi", () => {
    const { scope, ...thieu } = m;
    assert.match(doiChieuManifestVoiArtifact(thieu, a).join(" "), /thiếu trường bắt buộc: scope/);
  });

  it("thiếu trường toolVersion ⇒ lỗi", () => {
    const { toolVersion, ...thieu } = m;
    assert.match(doiChieuManifestVoiArtifact(thieu, a).join(" "), /toolVersion/);
  });

  it("analyzedFiles lệch số entry fingerprints ⇒ lỗi", () => {
    assert.match(doiChieuManifestVoiArtifact(m, { ...a, soFile: 2119 }).join(" "), /analyzedFiles lệch/);
  });

  it("configDigest lệch một ký tự ⇒ lỗi", () => {
    const x = { ...a, digest: { ".ua/config.json": "git:bf23efcc" } };
    assert.match(doiChieuManifestVoiArtifact(m, x).join(" "), /configDigest lệch/);
  });

  it("một trong ba nguồn baseCommit lệch ⇒ lỗi", () => {
    assert.match(doiChieuManifestVoiArtifact(m, { ...a, graphCommit: "z".repeat(40) }).join(" "), /baseCommit lệch/);
  });
});

describe("kiemDongGhim — luật #4/#5 chỉ kiểm được ở mức 'câu luật còn nằm đó'", () => {
  it("đủ ba dòng ⇒ không thiếu gì", () => {
    const text = DONG_GHIM_CONTRACT.join("\n---\n");
    assert.deepEqual(kiemDongGhim(text, DONG_GHIM_CONTRACT), []);
  });

  it("xoá dòng ưu tiên manifest/harness ⇒ bị bắt", () => {
    const text = DONG_GHIM_CONTRACT.filter((d) => !d.includes("ưu tiên")).join("\n");
    assert.equal(kiemDongGhim(text, DONG_GHIM_CONTRACT).length, 1);
  });

  it("xoá dòng cấm nạp graph khi chưa có verdict ⇒ bị bắt", () => {
    const text = DONG_GHIM_CONTRACT.filter((d) => !d.includes("verdict")).join("\n");
    assert.equal(kiemDongGhim(text, DONG_GHIM_CONTRACT).length, 1);
  });
});
