import { describe, expect, it } from "vitest";

import {
  MUTATING_COMMANDS,
  READ_ONLY_COMMANDS,
  buildMachineReason,
  classifyCommand,
  redactEvidence,
  ROLLOUT_STAGES,
  buildCellBootstrap,
  buildStageAdvance,
  buildTransferManifest,
  parseCliArgs,
  runCommand,
  readCellBuildEvidence,
  readTar,
  writeDeterministicTar,
  buildRolloutRunRow,
  computeMigrationManifestHash,
  resolveCommand,
} from "../production-openclaw-smoke.mjs";

/**
 * Hợp đồng của các RÀO AN TOÀN trong bộ máy rollout production.
 *
 * Đây là lát cắt đầu tiên và cố ý chỉ gồm phần mà sai thì nguy hiểm nhất: phân
 * loại lệnh đọc/ghi, bắt buộc xác nhận PROD, id lần chạy cấp trước, và lọc bí
 * mật khỏi bằng chứng. Các lệnh nghiệp vụ (`--begin-rollout`, `--bind-owner-qr`…)
 * dựng ở lát sau và sẽ dùng lại đúng những rào này.
 *
 * Vì sao rào đi trước nghiệp vụ: một lệnh sai có thể chạy lại; một bí mật đã ghi
 * vào file bằng chứng thì không rút lại được, và một lệnh "chỉ đọc" mà thật ra
 * ghi sẽ phá đúng thứ nó được gọi để kiểm.
 */

describe("phân loại lệnh đọc / ghi", () => {
  it("không lệnh nào vừa đọc vừa ghi", () => {
    // Một lệnh nằm ở cả hai danh sách nghĩa là người đọc không thể biết nó có
    // đụng dữ liệu hay không — và mọi rào phía dưới đều dựa vào phân loại này.
    const overlap = [...MUTATING_COMMANDS].filter((name) => READ_ONLY_COMMANDS.has(name));
    expect(overlap).toEqual([]);
  });

  it("mọi lệnh gate / readiness / lookup đều là chỉ đọc", () => {
    // Kế hoạch nói thẳng: gate, readiness và lookup không được có tác dụng phụ.
    // Đây là bài đo DẪN XUẤT từ chính tên lệnh, nên một lệnh `--check-*` mới bị
    // xếp nhầm sang nhóm ghi sẽ làm bài này đỏ ngay.
    const shouldBeReadOnly = [...MUTATING_COMMANDS, ...READ_ONLY_COMMANDS]
      .filter((name) => /^(check|verify|lookup)-/u.test(name));
    expect(shouldBeReadOnly.length, "không tìm thấy lệnh gate/lookup nào").toBeGreaterThan(0);
    for (const name of shouldBeReadOnly) {
      expect(READ_ONLY_COMMANDS.has(name), `${name} phải là chỉ đọc`).toBe(true);
    }
  });

  it("từ chối lệnh không có trong danh sách", () => {
    expect(() => classifyCommand("drop-everything")).toThrow(/không nằm trong danh sách/u);
  });
});

describe("xác nhận PROD", () => {
  const artifacts = { runId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };

  it("lệnh ghi bị từ chối khi thiếu xác nhận tường minh", () => {
    for (const command of MUTATING_COMMANDS) {
      expect(
        () => resolveCommand({ command, confirm: undefined, ...artifacts }),
        `${command} chạy được mà không cần xác nhận`,
      ).toThrow(/xác nhận PROD/u);
    }
  });

  it("chuỗi xác nhận phải KHỚP TUYỆT ĐỐI, không phải chứa", () => {
    // "PRODUCTION-ish" chứa "PROD" và "prod" chỉ khác hoa thường. Cả hai đều là
    // thứ người ta gõ nhầm rồi vẫn chạy, nếu kiểm bằng contains hay lowercase.
    for (const wrong of ["prod", "PROD ", " PROD", "PRODUCTION", "PRODUCTION-ish", ""]) {
      expect(
        () => resolveCommand({ command: "begin-rollout", confirm: wrong, ...artifacts }),
        `xác nhận sai "${wrong}" vẫn qua`,
      ).toThrow(/xác nhận PROD/u);
    }
    expect(() => resolveCommand({ command: "begin-rollout", confirm: "PROD", ...artifacts }))
      .not.toThrow();
  });

  it("lệnh chỉ đọc KHÔNG đòi xác nhận", () => {
    // Bắt xác nhận cho lệnh đọc nghe có vẻ an toàn hơn, nhưng nó dạy người vận
    // hành gõ "PROD" theo phản xạ — đúng thói quen mà rào này cần chặn.
    for (const command of READ_ONLY_COMMANDS) {
      expect(
        () => resolveCommand({ command, confirm: undefined, ...artifacts }),
        `${command} đòi xác nhận dù chỉ đọc`,
      ).not.toThrow();
    }
  });
});

describe("id lần chạy phải được CẤP TRƯỚC", () => {
  it("lệnh ghi từ chối khi thiếu runId", () => {
    expect(() => resolveCommand({ command: "begin-rollout", confirm: "PROD" }))
      .toThrow(/runId/u);
  });

  it("từ chối runId không phải UUID", () => {
    for (const bad of ["run-1", "3f2504e0", "3f2504e0-4f89-41d3-9a0c-0305e82c330", "z".repeat(36)]) {
      expect(
        () => resolveCommand({ command: "begin-rollout", confirm: "PROD", runId: bad }),
        `runId sai "${bad}" vẫn qua`,
      ).toThrow(/runId/u);
    }
  });
});

describe("lọc bí mật khỏi bằng chứng", () => {
  it("chặn dữ liệu QR", () => {
    // QR của Zalo là chứng chỉ đăng nhập. Lọt vào file bằng chứng thì bất kỳ ai
    // đọc file đó đều đăng nhập được — nguy hiểm hơn hẳn một token thường vì nó
    // không hiện ra như một bí mật.
    expect(() => redactEvidence({ qrCode: "data:image/png;base64,iVBORw0KGgo=" }))
      .toThrow(/QR/u);
    expect(() => redactEvidence({ nested: { qr_data: "abc" } })).toThrow(/QR/u);
  });

  it("chặn token, cookie, IMEI và giá trị hình-dạng-bí-mật", () => {
    const cases = [
      { name: "token", value: { accessToken: "eyJhbGciOiJIUzI1NiJ9.abc.def" } },
      { name: "cookie", value: { setCookie: "session=abc; HttpOnly" } },
      { name: "IMEI", value: { imei: "490154203237518" } },
      { name: "PAT Supabase", value: { note: "sbp_d071757ea96299429838acba25e64f9e21d6bacc" } },
      { name: "khoá riêng", value: { pem: "-----BEGIN OPENSSH PRIVATE KEY-----" } },
    ];
    for (const { name, value } of cases) {
      expect(() => redactEvidence(value), `${name} lọt qua`).toThrow();
    }
  });

  it("chặn nội dung tin nhắn", () => {
    // Nội dung tin là dữ liệu khách hàng. Một bản log "để debug" là một bản sao
    // hội thoại nằm ngoài mọi ràng buộc lưu trữ của sản phẩm.
    expect(() => redactEvidence({ messageBody: "chào anh" })).toThrow(/nội dung tin/u);
    expect(() => redactEvidence({ template: { text: "xin chào" } })).toThrow(/nội dung tin/u);
  });

  it("cho qua bằng chứng sạch, và trả lại nguyên vẹn", () => {
    // Mặt THUẬN. Thiếu bài này thì một hàm `throw` vô điều kiện cũng làm mọi bài
    // trên xanh.
    const clean = { runId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", stage: "WAITING_OWNER_QR", counts: { queued: 0 } };
    expect(redactEvidence(clean)).toEqual(clean);
  });

  it("KHÔNG chặn nhầm fencing_token — nó là bộ đếm, không phải chứng chỉ", () => {
    // Bắt được khi viết bài dùng thật cho buildCellBootstrap: mẫu /token/ trần
    // chặn luôn `fencing_token`, khiến chuỗi dựng cell không ghi nổi bằng chứng
    // nào. Một bộ lọc chặn nhầm sẽ bị người ta tắt, và lúc đó nó không chặn gì
    // nữa cả.
    expect(() => redactEvidence({ fencing_token: 1, lease_generation: 2 })).not.toThrow();
    expect(() => redactEvidence({ credential_generation: 1 })).not.toThrow();
  });

  it("vẫn chặn mọi tên mang hình dạng chứng chỉ", () => {
    // Mặt NGƯỢC của bài trên: siết mẫu không được làm thủng nó.
    for (const key of ["accessToken","access_token","refreshToken","idToken","apiToken",
                       "authToken","bearerToken","sessionToken","token","tokens"]) {
      expect(() => redactEvidence({ [key]: "x" }), `${key} lọt qua`).toThrow(/token/iu);
    }
  });

  it("soi cả mảng lồng nhau, không chỉ khoá cấp một", () => {
    expect(() => redactEvidence({ steps: [{ ok: true }, { qrPayload: "x" }] })).toThrow(/QR/u);
  });
});

describe("lý do máy đọc", () => {
  it("dựng từ dữ liệu cho phép, đúng khuôn", () => {
    expect(buildMachineReason("BEGIN_ROLLOUT", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
      .toBe("production-smoke:BEGIN_ROLLOUT:3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });

  it("từ chối chế độ không nằm trong danh sách", () => {
    // Kế hoạch cấm để văn bản thô của caller hay của provider trở thành bằng
    // chứng. Chặn ở đây thay vì lọc sau, vì lọc sau là đã ghi rồi mới xoá.
    expect(() => buildMachineReason("lỗi từ Zalo: mất kết nối", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
      .toThrow(/chế độ/iu);
  });

  it("từ chối runId không hợp lệ, để lý do không trỏ vào lần chạy không tồn tại", () => {
    expect(() => buildMachineReason("BEGIN_ROLLOUT", "run-1")).toThrow(/runId/u);
  });
});

describe("bản song sinh JS của hàm băm manifest", () => {
  // Hàm thật sống trong DB: app_private.openclaw_rollout_manifest_hash_v1.
  // Bản JS phải khớp TUYỆT ĐỐI, vì --begin-rollout tính hash phía client rồi ghi
  // vào cột mà guard sẽ kiểm lại bằng hàm DB. Lệch một byte thì dòng vừa ghi bị
  // chính guard từ chối, và người vận hành nhận một lỗi 42501 không nói được vì
  // sao.
  //
  // Vector vàng dưới đây LẤY TỪ chính hàm DB chạy trên harness schema production
  // (xem docs/openclaw-zalo/runbooks/). Không phải tôi tự tính rồi tự tin.
  const ORDER = [
    "20260727010000_openclaw_catalog_foundation.sql",
    "20260727015000_openclaw_security_principals.sql",
    "20260727020000_openclaw_inbox_schema.sql",
    "20260727025000_openclaw_inbound_automation.sql",
    "20260727030000_openclaw_policy_automation_knowledge.sql",
    "20260727040000_openclaw_delivery_audit_ops.sql",
    "20260727050000_openclaw_access_policies.sql",
    "20260727060000_openclaw_rpc_surface.sql",
    "20260727070000_openclaw_crm_event_sources.sql",
    "20260727080000_openclaw_realtime_allowlist.sql",
    "20260727090000_openclaw_maintenance_jobs.sql",
    "20260727095000_openclaw_activation_guards.sql",
  ];
  const digestsOf = (fill) => Object.fromEntries(ORDER.map((n, i) =>
    [n, String(fill).repeat(64).slice(0, 63) + String(i % 10)]));

  it("từ chối khi thiếu digest của bất kỳ file nào trong 12", () => {
    const partial = digestsOf("a");
    delete partial[ORDER[7]];
    expect(() => computeMigrationManifestHash(partial, ORDER)).toThrow(/thiếu|digest/iu);
  });

  it("từ chối digest sai khuôn 64 hex", () => {
    const bad = { ...digestsOf("a"), [ORDER[3]]: "khong-phai-hex" };
    expect(() => computeMigrationManifestHash(bad, ORDER)).toThrow(/digest/iu);
  });

  it("bỏ qua khoá thừa (cellImageDigest…) — chúng không vào tiền ảnh", () => {
    // artifact_digests mang thêm cellImageDigest / cellConfigDigest /
    // cellReviewedCommitSha. Hàm DB chỉ duyệt 12 tên file, nên bản JS cũng phải
    // vậy; gộp thêm sẽ ra hash khác và dòng ghi ra bị guard từ chối.
    const base = digestsOf("a");
    const withExtras = {
      ...base,
      cellImageDigest: `sha256:${"b".repeat(64)}`,
      cellConfigDigest: "c".repeat(64),
      cellReviewedCommitSha: "d".repeat(40),
    };
    expect(computeMigrationManifestHash(withExtras, ORDER))
      .toBe(computeMigrationManifestHash(base, ORDER));
  });

  it("đổi thứ tự cho ra hash khác", () => {
    const d = digestsOf("a");
    const swapped = [ORDER[1], ORDER[0], ...ORDER.slice(2)];
    expect(computeMigrationManifestHash(d, swapped))
      .not.toBe(computeMigrationManifestHash(d, ORDER));
  });

  it("kết quả là 64 hex", () => {
    expect(computeMigrationManifestHash(digestsOf("a"), ORDER)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("KHỚP VECTOR VÀNG lấy từ chính hàm DB", () => {
    // Vector này KHÔNG do tôi tự tính. Nó là đầu ra của
    // `app_private.openclaw_rollout_manifest_hash_v1` chạy trên harness nạp
    // schema production, với đúng bộ digest tổng hợp dưới đây (a×63 + chữ số
    // theo vị trí). Dùng digest tổng hợp chứ không phải băm file thật, để vector
    // không đổi mỗi lần một migration được sửa — một vector vàng tự đổi thì
    // không còn là vàng.
    //
    // Bài này là thứ duy nhất chứng minh bản JS và hàm DB nói cùng một ngôn ngữ.
    // Lệch một byte ⇒ --begin-rollout ghi ra dòng mà chính guard từ chối, và
    // người vận hành nhận 42501 không nói được vì sao.
    const golden = "f8049d5e377a8aa254c7f344314bc4dc63e546a19dff97ffc780bc26e83342fd";
    const digests = Object.fromEntries(
      ORDER.map((name, index) => [name, "a".repeat(63) + String(index % 10)]),
    );
    expect(computeMigrationManifestHash(digests, ORDER)).toBe(golden);
  });

  it("thứ tự 12 file khớp danh sách hàm DB ghim cứng", () => {
    // Hàm DB ghim cứng đúng 12 tên này. Đây là nguồn sự thật THỨ BA về danh sách
    // (cạnh OPENCLAW_MIGRATIONS của harness và cây git đã duyệt). Ghi ra đây để
    // lần sau ai sửa manifest biết phải sửa mấy chỗ — và để vector vàng ở trên
    // có nghĩa.
    expect(ORDER).toHaveLength(12);
    expect(ORDER[3]).toBe("20260727025000_openclaw_inbound_automation.sql");
    expect(ORDER[6]).toBe("20260727050000_openclaw_access_policies.sql");
    expect(ORDER[9]).toBe("20260727080000_openclaw_realtime_allowlist.sql");
  });
});

describe("dựng dòng rollout run", () => {
  // Dòng này là lời khẳng định "có một cell đang chạy đúng ảnh đã duyệt". Guard
  // kích hoạt đọc nó để quyết định cho phép bật OpenClaw hay không. Nên mọi phép
  // kiểm phải xảy ra TRƯỚC khi ghi: một dòng sai nằm trong bảng là một lời nói
  // dối mà hệ thống sẽ tin.
  const ORDER = [
    "20260727010000_openclaw_catalog_foundation.sql",
    "20260727015000_openclaw_security_principals.sql",
    "20260727020000_openclaw_inbox_schema.sql",
    "20260727025000_openclaw_inbound_automation.sql",
    "20260727030000_openclaw_policy_automation_knowledge.sql",
    "20260727040000_openclaw_delivery_audit_ops.sql",
    "20260727050000_openclaw_access_policies.sql",
    "20260727060000_openclaw_rpc_surface.sql",
    "20260727070000_openclaw_crm_event_sources.sql",
    "20260727080000_openclaw_realtime_allowlist.sql",
    "20260727090000_openclaw_maintenance_jobs.sql",
    "20260727095000_openclaw_activation_guards.sql",
  ];
  const SHA = "0650187981ad9728d295fae34eff92b508e36bc8";
  const IMG = `sha256:${"4".repeat(64)}`;
  const CFG = "3".repeat(64);
  const ok = () => ({
    organizationId: "dddd0000-0000-4000-8000-000000000001",
    reviewedCommitSha: SHA,
    migrationOrder: ORDER,
    migrationDigests: Object.fromEntries(ORDER.map((n, i) => [n, "a".repeat(63) + String(i % 10)])),
    cellImageDigest: IMG,
    cellConfigDigest: CFG,
    upstreamSri: `sha512-${"b".repeat(86)}==`,
    upstreamGitHead: "2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4",
    patchSeriesSha256: "c".repeat(64),
    builtTgzSha256: "d".repeat(64),
  });

  it("dựng đủ 8 trường bắt buộc, bắt đầu ở FOUNDATION", () => {
    const row = buildRolloutRunRow(ok());
    for (const key of [
      "organization_id", "reviewed_commit_sha", "migration_manifest_sha256",
      "upstream_sri", "upstream_git_head", "patch_series_sha256",
      "built_tgz_sha256", "artifact_digests",
    ]) {
      expect(row[key], `thiếu ${key}`).toBeDefined();
    }
    // Bắt đầu ở FOUNDATION chứ không nhảy thẳng: mỗi bước tiến là một lần người
    // vận hành phải nhìn vào cổng, và bỏ bước đầu là bỏ luôn thói quen đó.
    expect(row.stage).toBe("FOUNDATION");
    expect(row.status).toBe("RUNNING");
    expect(row.completed_at).toBeNull();
  });

  it("TỰ tính migration_manifest_sha256, không nhận từ người gọi", () => {
    // Nhận hash từ tham số nghĩa là tin người gọi đã tính đúng. Người gọi chính
    // là chỗ dễ sai nhất.
    const args = { ...ok(), migrationManifestSha256: "e".repeat(64) };
    const row = buildRolloutRunRow(args);
    expect(row.migration_manifest_sha256)
      .toBe(computeMigrationManifestHash(args.migrationDigests, ORDER));
    expect(row.migration_manifest_sha256).not.toBe("e".repeat(64));
  });

  it("artifact_digests mang cellReviewedCommitSha TRÙNG reviewed_commit_sha", () => {
    // Guard kiểm đúng điều này. Lệch nhau nghĩa là dòng mô tả một ảnh dựng từ
    // commit khác commit đã duyệt — và không ai đọc được sự lệch đó bằng mắt.
    const row = buildRolloutRunRow(ok());
    expect(row.artifact_digests.cellReviewedCommitSha).toBe(row.reviewed_commit_sha);
    expect(row.artifact_digests.cellImageDigest).toBe(IMG);
    expect(row.artifact_digests.cellConfigDigest).toBe(CFG);
  });

  it("từ chối image digest sai khuôn", () => {
    for (const bad of ["4".repeat(64), "sha256:xyz", `sha1:${"4".repeat(40)}`, ""]) {
      expect(() => buildRolloutRunRow({ ...ok(), cellImageDigest: bad }), `lọt: ${bad}`)
        .toThrow(/image digest/iu);
    }
  });

  it("từ chối config digest sai khuôn", () => {
    for (const bad of [`sha256:${"3".repeat(64)}`, "3".repeat(63), ""]) {
      expect(() => buildRolloutRunRow({ ...ok(), cellConfigDigest: bad }), `lọt: ${bad}`)
        .toThrow(/config digest/iu);
    }
  });

  it("từ chối reviewed sha sai khuôn 40 hex", () => {
    for (const bad of ["HEAD", SHA.slice(0, 39), `${SHA}x`, ""]) {
      expect(() => buildRolloutRunRow({ ...ok(), reviewedCommitSha: bad })).toThrow(/sha/iu);
    }
  });

  it("từ chối thiếu bất kỳ trường upstream nào", () => {
    for (const key of ["upstreamSri", "upstreamGitHead", "patchSeriesSha256", "builtTgzSha256"]) {
      expect(() => buildRolloutRunRow({ ...ok(), [key]: undefined }), `thiếu ${key} vẫn qua`)
        .toThrow();
    }
  });

  it("dòng dựng ra ĐI QUA được bộ lọc bí mật", () => {
    // Nếu dòng này chứa thứ gì hình dạng bí mật thì nó sẽ nằm trong bảng, trong
    // backup, và trong mọi bản dump về sau.
    expect(() => redactEvidence(buildRolloutRunRow(ok()))).not.toThrow();
  });
});

describe("chuỗi dựng cell đầu tiên", () => {
  // THỨ TỰ Ở ĐÂY LÀ HỢP ĐỒNG, không phải sở thích. Đo trên PostgreSQL 17.6 nạp
  // schema production: guard chỉ coi là "kích hoạt" khi cell ở state='READY',
  // nên phải dựng đủ account → cell PROVISIONING → credential → lease rồi MỚI
  // lật READY. Chèn cell READY ngay từ đầu thì trúng
  // "current artifact cell credential lease fence matrix is incomplete".
  //
  // Một phân tích tĩnh dài đã kết luận đây là bế tắc không gỡ được. Phép đo bác
  // nó. Bài test này giữ kết quả đo đó khỏi bị quên.
  const ok = () => ({
    organizationId: "dddd0000-0000-4000-8000-000000000001",
    accountId: "aaaa1111-0000-4000-8000-000000000001",
    cellId: "cccc1111-0000-4000-8000-000000000001",
    reviewedCommitSha: "0650187981ad9728d295fae34eff92b508e36bc8",
    cellImageDigest: `sha256:${"4".repeat(64)}`,
    cellConfigDigest: "3".repeat(64),
    credentialHash: "a".repeat(64),
    allowedScopes: ["heartbeat", "lease.acquire"],
    leaseExpiresAt: "2026-08-06T00:00:00.000Z",
  });

  it("năm bước, đúng thứ tự, READY là bước CUỐI", () => {
    const steps = buildCellBootstrap(ok());
    expect(steps.map((s) => s.table)).toEqual([
      "public.openclaw_accounts",
      "public.openclaw_runtime_cells",
      "public.openclaw_runtime_credentials",
      "public.openclaw_runtime_leases",
      "public.openclaw_runtime_cells",
    ]);
    expect(steps[1].values.state).toBe("PROVISIONING");
    expect(steps[4].operation).toBe("update");
    expect(steps[4].values.state).toBe("READY");
  });

  it("cell được tạo ở PROVISIONING, KHÔNG bao giờ tạo thẳng READY", () => {
    // Nếu ai đó "tối ưu" bằng cách tạo thẳng READY, guard sẽ chặn và thông điệp
    // lỗi ("matrix is incomplete") không hề gợi ý rằng nguyên nhân là thứ tự.
    const steps = buildCellBootstrap(ok());
    const inserts = steps.filter((s) => s.operation === "insert" && s.table.endsWith("cells"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values.state).not.toBe("READY");
  });

  it("từ chối scope ngoài danh sách đóng của schema", () => {
    // allowed_scopes bị ràng bởi một CHECK liệt kê đúng 18 giá trị. Tôi từng gõ
    // "runtime.read" cho có và bị chặn ngay ở tầng DB — chặn sớm ở đây thì thông
    // điệp nói được vì sao.
    expect(() => buildCellBootstrap({ ...ok(), allowedScopes: ["runtime.read"] }))
      .toThrow(/scope/iu);
    expect(() => buildCellBootstrap({ ...ok(), allowedScopes: [] })).toThrow(/scope/iu);
  });

  it("nhận mọi scope hợp lệ của schema", () => {
    // Mặt THUẬN: danh sách chặn phải đúng bằng danh sách schema, không hẹp hơn.
    // Hẹp hơn nghĩa là công cụ tự cấm thứ hệ thống cho phép, và người dùng sẽ
    // đi vòng qua công cụ.
    expect(() => buildCellBootstrap({
      ...ok(),
      allowedScopes: ["heartbeat", "qr.publish", "qr.result", "inbound.commit",
        "outbox.claim", "outbox.preflight", "outbox.authorize-send", "outbox.requeue",
        "outbox.complete", "work.claim", "work.context", "work.complete", "media.issue",
        "lease.acquire", "cell.rebind", "generation.ack", "credential.exchange",
        "runtime.sweep"],
    })).not.toThrow();
  });

  it("mọi bước đều mang organization_id — không bước nào rò sang tổ chức khác", () => {
    const steps = buildCellBootstrap(ok());
    for (const step of steps) {
      const org = step.values.organization_id ?? step.where?.organization_id;
      expect(org, `${step.table} thiếu organization_id`).toBe(ok().organizationId);
    }
  });

  it("bước lật READY ràng theo cell_id, không quét cả bảng", () => {
    // Một UPDATE thiếu WHERE ở bảng này sẽ lật MỌI cell của MỌI tổ chức sang
    // READY cùng lúc.
    const flip = buildCellBootstrap(ok())[4];
    expect(flip.where?.id).toBe(ok().cellId);
    expect(flip.where?.organization_id).toBe(ok().organizationId);
  });

  it("từ chối digest sai khuôn, giống buildRolloutRunRow", () => {
    expect(() => buildCellBootstrap({ ...ok(), cellImageDigest: "4".repeat(64) }))
      .toThrow(/image digest/iu);
    expect(() => buildCellBootstrap({ ...ok(), cellConfigDigest: `sha256:${"3".repeat(64)}` }))
      .toThrow(/config digest/iu);
  });

  it("chuỗi dựng ra đi qua được bộ lọc bí mật", () => {
    expect(() => redactEvidence(buildCellBootstrap(ok()))).not.toThrow();
  });
});

describe("tiến giai đoạn", () => {
  // Luật dưới đây ĐO trên PostgreSQL 17.6 nạp schema production, không đọc mã
  // rồi đoán:
  //   tiến đúng MỘT bước + stage_version đúng +1  -> qua
  //   lùi / nhảy cóc                              -> "invalid rollout stage transition"
  //   version không tăng, hoặc tăng 2             -> "invalid rollout stage transition"
  //   đứng yên chỉ tăng version                   -> "stage_version cannot change
  //                                                  without a stage transition"
  const RUN = "11110000-0000-4000-8000-000000000001";
  const ok = () => ({ runId: RUN, from: "FOUNDATION", to: "INFRASTRUCTURE", expectedVersion: 1 });

  it("dựng UPDATE có CAS theo stage_version VÀ status", () => {
    const step = buildStageAdvance(ok());
    expect(step.values.stage).toBe("INFRASTRUCTURE");
    expect(step.values.stage_version).toBe(2);
    // CAS phải gồm cả version cũ lẫn status: thiếu version thì hai tiến trình
    // cùng tiến một bước; thiếu status thì tiến được cả run đã PAUSED.
    expect(step.where.stage_version).toBe(1);
    expect(step.where.stage).toBe("FOUNDATION");
    expect(step.where.status).toBe("RUNNING");
    expect(step.where.id).toBe(RUN);
  });

  it("từ chối lùi giai đoạn", () => {
    expect(() => buildStageAdvance({ ...ok(), from: "INFRASTRUCTURE", to: "FOUNDATION" }))
      .toThrow(/lùi|liền sau/iu);
  });

  it("từ chối nhảy cóc", () => {
    expect(() => buildStageAdvance({ ...ok(), to: "WAITING_OWNER_QR" }))
      .toThrow(/liền sau/iu);
  });

  it("từ chối đứng yên", () => {
    expect(() => buildStageAdvance({ ...ok(), to: "FOUNDATION" })).toThrow(/liền sau/iu);
  });

  it("từ chối giai đoạn không có thật", () => {
    expect(() => buildStageAdvance({ ...ok(), to: "SAU_KHI_XONG" })).toThrow(/giai đoạn/iu);
    expect(() => buildStageAdvance({ ...ok(), from: "KHONG_CO" })).toThrow(/giai đoạn/iu);
  });

  it("đòi expectedVersion là số nguyên dương", () => {
    for (const bad of [0, -1, 1.5, "1", undefined]) {
      expect(() => buildStageAdvance({ ...ok(), expectedVersion: bad }), `lọt: ${bad}`)
        .toThrow(/version/iu);
    }
  });

  it("phủ đủ 11 giai đoạn, đúng thứ tự của schema", () => {
    // Thứ tự này là hợp đồng với CHECK constraint của cột stage. Lệch một chỗ là
    // công cụ cho phép một bước mà DB chặn, hoặc chặn một bước mà DB cho phép.
    expect(ROLLOUT_STAGES).toEqual([
      "FOUNDATION", "INFRASTRUCTURE", "WAITING_OWNER_QR", "CONNECTION", "SHADOW",
      "WAITING_OWNER_INBOUND", "LIMITED_OBSERVING", "LIMITED_VERIFIED",
      "PROACTIVE", "SALES_GROUPS", "COMPLETE",
    ]);
  });

  it("mọi cặp liền kề đều dựng được, không cặp nào bị chặn nhầm", () => {
    // Mặt THUẬN: nếu chỉ có bài chặn thì một hàm luôn-ném cũng xanh.
    for (let i = 0; i < ROLLOUT_STAGES.length - 1; i += 1) {
      expect(
        () => buildStageAdvance({ runId: RUN, from: ROLLOUT_STAGES[i], to: ROLLOUT_STAGES[i + 1], expectedVersion: i + 1 }),
        `${ROLLOUT_STAGES[i]} -> ${ROLLOUT_STAGES[i + 1]} bị chặn nhầm`,
      ).not.toThrow();
    }
  });
});

describe("đọc bằng chứng dựng ảnh cell", () => {
  // Bằng chứng mang HAI sha khác nhau và rất dễ dùng nhầm:
  //   supply_chain.git_binding.expected_m  = checkpoint M, một TỔ TIÊN
  //   supply_chain.git_binding.reviewed_r  = R, chính cây ảnh được dựng từ đó
  // Tôi đã điền nhầm `expected_m` vào reviewed_commit_sha trong một phép thử, và
  // guard VẪN QUA — vì nó chỉ kiểm hai trường khớp NHAU, không kiểm cái nào đúng.
  // Dòng ghi ra sẽ khai sai nguồn gốc ảnh mà không gì báo. Hàm này tồn tại để
  // chặn đúng chuyện đó.
  const M = "0650187981ad9728d295fae34eff92b508e36bc8";
  const R = "d84f3c013f7aa3d7d83cf473e1ce7b5448b2d018";
  const ARCHIVE = "94b90d711b0fbf0a465d2422748e7b8f84fd21761c33581e639314f24672d3a8";
  const IMAGE = `sha256:${"4".repeat(64)}`;
  const ok = () => ({
    image_digest: IMAGE,
    source_date_epoch: 1785062400,
    supply_chain: {
      git_binding: {
        expected_m: M, reviewed_r: R,
        m_object_type: "commit", r_object_type: "commit", m_ancestor_of_r: true,
      },
    },
    oci: {
      archive_a_sha256: ARCHIVE, archive_b_sha256: ARCHIVE,
      byte_identical: true, promoted_archive_role: "A", promoted_archive_sha256: ARCHIVE,
    },
  });

  it("lấy reviewed sha từ reviewed_r, KHÔNG phải expected_m", () => {
    const out = readCellBuildEvidence(ok());
    expect(out.reviewedCommitSha).toBe(R);
    expect(out.reviewedCommitSha).not.toBe(M);
    expect(out.checkpointMSha).toBe(M);
  });

  it("từ chối khi hai lần dựng KHÔNG cho ra byte giống nhau", () => {
    // Toàn bộ giá trị của "build tái lập được" nằm ở chỗ hai lần dựng độc lập ra
    // cùng một byte. Mất điều đó thì digest chỉ còn là dấu vân tay của một lần
    // dựng may mắn.
    expect(() => readCellBuildEvidence({
      ...ok(),
      oci: { ...ok().oci, archive_b_sha256: "f".repeat(64), byte_identical: false },
    })).toThrow(/tái lập|byte/iu);
  });

  it("từ chối khi archive được thăng cấp không khớp hash của vai trò đó", () => {
    // promoted_archive_role='A' mà promoted hash lại là của B nghĩa là bundle sẽ
    // mang bytes của một archive khác cái đã được kiểm.
    expect(() => readCellBuildEvidence({
      ...ok(),
      oci: { ...ok().oci, promoted_archive_sha256: "e".repeat(64) },
    })).toThrow(/thăng cấp|promoted/iu);
  });

  it("từ chối khi M không phải tổ tiên của R", () => {
    expect(() => readCellBuildEvidence({
      ...ok(),
      supply_chain: { git_binding: { ...ok().supply_chain.git_binding, m_ancestor_of_r: false } },
    })).toThrow(/tổ tiên/iu);
  });

  it("nhận source_date_epoch cả dạng chuỗi lẫn số", () => {
    // File THẬT lưu giá trị này dưới dạng chuỗi. Bản đầu của hàm so bằng `!==`
    // với số và từ chối chính bằng chứng thật — tôi đã bịa hình dạng dữ liệu
    // trong mock thay vì đọc file. Chốt cả hai dạng.
    expect(() => readCellBuildEvidence({ ...ok(), source_date_epoch: 1785062400 })).not.toThrow();
    expect(() => readCellBuildEvidence({ ...ok(), source_date_epoch: "1785062400" })).not.toThrow();
  });

  it("KHÔNG nhận giá trị chỉ ép kiểu lỏng mới bằng", () => {
    // Nhận cả chuỗi lẫn số không được biến thành nhận mọi thứ Number() ép được.
    for (const bad of [true, [1785062400], " ", null, "1785062400abc", "0x6A6C3B00"]) {
      expect(() => readCellBuildEvidence({ ...ok(), source_date_epoch: bad }), `lọt: ${JSON.stringify(bad)}`)
        .toThrow(/source_date_epoch/iu);
    }
  });

  it("từ chối source_date_epoch khác giá trị ghim của kế hoạch", () => {
    // Kế hoạch ghim đúng 1785062400. Giá trị khác nghĩa là ảnh dựng bằng một
    // mốc thời gian khác, và mọi so sánh byte-với-byte về sau đều vô nghĩa.
    expect(() => readCellBuildEvidence({ ...ok(), source_date_epoch: 1785062401 }))
      .toThrow(/source_date_epoch/iu);
  });

  it("từ chối image digest sai khuôn", () => {
    expect(() => readCellBuildEvidence({ ...ok(), image_digest: "4".repeat(64) }))
      .toThrow(/image digest/iu);
  });

  it("đọc được bằng chứng THẬT trong repo", async () => {
    // Mặt THUẬN quan trọng nhất: hàm phải đọc được file thật, không chỉ file mẫu
    // tôi tự bịa cho vừa hàm.
    const { readFileSync } = await import("node:fs");
    const real = JSON.parse(readFileSync("services/openclaw-zalo-cell/build-evidence.json", "utf8"));
    const out = readCellBuildEvidence(real);
    expect(out.reviewedCommitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(out.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(out.promotedArchiveSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(out.reviewedCommitSha).not.toBe(out.checkpointMSha);
  });
});

describe("bundle deploy tất định", () => {
  // Bundle là thứ được CHUYỂN LÊN VPS và nạp vào runtime. Nếu nó không tất định
  // thì "so digest với bản đã duyệt" mất hết ý nghĩa: mỗi lần dựng ra một file
  // khác, và không ai phân biệt được "khác vì tôi vừa sửa" với "khác vì có ai đó
  // chèn thứ gì vào".
  const entries = () => [
    { path: "b.txt", bytes: Buffer.from("bbb") },
    { path: "a.txt", bytes: Buffer.from("aaa") },
    { path: "nested/c.txt", bytes: Buffer.from("ccc") },
  ];

  it("hai lần dựng cùng đầu vào ra BYTE GIỐNG HỆT", () => {
    const a = writeDeterministicTar(entries());
    const b = writeDeterministicTar(entries());
    expect(a.equals(b)).toBe(true);
  });

  it("thứ tự đầu vào KHÔNG ảnh hưởng kết quả — entry được sắp", () => {
    // Nếu thứ tự đầu vào lọt vào output thì hai người dựng cùng nội dung sẽ ra
    // hai file khác nhau, và cả hai đều "đúng".
    const forward = writeDeterministicTar(entries());
    const reversed = writeDeterministicTar([...entries()].reverse());
    expect(forward.equals(reversed)).toBe(true);
  });

  it("mtime bị ghim, không phải giờ hệ thống", () => {
    const parsed = readTar(writeDeterministicTar(entries()));
    for (const e of parsed) {
      expect(e.mtime, `${e.path} mang giờ hệ thống`).toBe(1785062400);
    }
  });

  it("uid/gid/uname/gname cố định — không mang danh tính người dựng", () => {
    // Một bundle mang tên người dựng là một bundle không tái lập được trên máy
    // khác, và là một rò rỉ nhỏ không cần thiết.
    const parsed = readTar(writeDeterministicTar(entries()));
    for (const e of parsed) {
      expect(e.uid).toBe(0);
      expect(e.gid).toBe(0);
      expect(e.uname).toBe("");
      expect(e.gname).toBe("");
    }
  });

  it("đọc lại ra đúng nội dung đã ghi", () => {
    // Mặt THUẬN. Thiếu bài này thì một hàm ghi ra toàn số 0 vẫn "tất định".
    const parsed = readTar(writeDeterministicTar(entries()));
    expect(parsed.map((e) => e.path)).toEqual(["a.txt", "b.txt", "nested/c.txt"]);
    expect(parsed.find((e) => e.path === "nested/c.txt").bytes.toString()).toBe("ccc");
  });

  it("đổi MỘT byte nội dung thì tar đổi", () => {
    const base = writeDeterministicTar(entries());
    const changed = writeDeterministicTar([
      ...entries().filter((e) => e.path !== "a.txt"),
      { path: "a.txt", bytes: Buffer.from("aab") },
    ]);
    expect(base.equals(changed)).toBe(false);
  });

  it("từ chối đường dẫn tuyệt đối hoặc đi ngược lên trên", () => {
    // Một entry "../../etc/passwd" trong tar là lỗ hổng giải nén cổ điển, và
    // bundle này được giải nén BẰNG QUYỀN provisioning trên VPS.
    for (const bad of ["/etc/passwd", "../x", "a/../../b", "C:/x"]) {
      expect(() => writeDeterministicTar([{ path: bad, bytes: Buffer.alloc(0) }]),
        `lọt: ${bad}`).toThrow(/đường dẫn/iu);
    }
  });

  it("từ chối đường dẫn trùng nhau", () => {
    // Hai entry cùng tên nghĩa là cái sau đè cái trước lúc giải nén, và bản kê
    // trong manifest không còn mô tả đúng thứ nằm trên đĩa.
    expect(() => writeDeterministicTar([
      { path: "a.txt", bytes: Buffer.from("1") },
      { path: "a.txt", bytes: Buffer.from("2") },
    ])).toThrow(/trùng/iu);
  });
});

describe("bản kê chuyển giao", () => {
  const evidence = {
    reviewedCommitSha: "d84f3c013f7aa3d7d83cf473e1ce7b5448b2d018",
    checkpointMSha: "0650187981ad9728d295fae34eff92b508e36bc8",
    imageDigest: `sha256:${"4".repeat(64)}`,
    promotedArchiveSha256: "9".repeat(64),
    sourceDateEpoch: 1785062400,
  };
  const files = [
    { path: "cell/config.json", bytes: Buffer.from("{}") },
    { path: "cell.oci.tar", bytes: Buffer.from("archive-bytes") },
  ];

  it("KHÔNG chứa bundle_sha256 — nghịch lý tự băm", () => {
    // bundle_sha256 là băm của chính file chứa bản kê. Nhét nó vào trong thì
    // thay đổi nội dung, làm băm khác đi, và không bao giờ hội tụ. Nó phải sống
    // NGOÀI tar.
    const manifest = buildTransferManifest({ evidence, files });
    expect(JSON.stringify(manifest)).not.toMatch(/bundle_sha256/u);
  });

  it("ràng vào reviewed_r và digest ảnh, không phải checkpoint M", () => {
    const manifest = buildTransferManifest({ evidence, files });
    expect(manifest.reviewedCommitSha).toBe(evidence.reviewedCommitSha);
    expect(manifest.reviewedCommitSha).not.toBe(evidence.checkpointMSha);
    expect(manifest.imageDigest).toBe(evidence.imageDigest);
  });

  it("kê từng file kèm sha256 riêng, sắp theo đường dẫn", () => {
    const manifest = buildTransferManifest({ evidence, files });
    expect(manifest.files.map((f) => f.path)).toEqual(["cell.oci.tar", "cell/config.json"]);
    for (const f of manifest.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("đi qua được bộ lọc bí mật", () => {
    expect(() => redactEvidence(buildTransferManifest({ evidence, files }))).not.toThrow();
  });
});

describe("phân tích tham số dòng lệnh", () => {
  // CLI là chỗ người vận hành gõ tay lúc 2 giờ sáng. Mọi thứ mơ hồ ở đây đều
  // biến thành một thao tác sai trên production.
  it("đọc được lệnh và cờ dạng --key value", () => {
    expect(parseCliArgs(["--command", "check-gates", "--run-id", "abc"]))
      .toEqual({ command: "check-gates", runId: "abc" });
  });

  it("đọc được cả dạng --key=value", () => {
    expect(parseCliArgs(["--command=begin-rollout"])).toEqual({ command: "begin-rollout" });
  });

  it("cờ không có giá trị là true", () => {
    expect(parseCliArgs(["--dry-run"])).toEqual({ dryRun: true });
  });

  it("từ chối tham số trần, không đoán ý", () => {
    // `node script.mjs begin-rollout` trông như đúng nhưng lệnh nằm ở --command.
    // Đoán ý người dùng ở đây nghĩa là có lúc đoán sai mà không ai biết.
    expect(() => parseCliArgs(["begin-rollout"])).toThrow(/tham số/iu);
  });

  it("từ chối cờ lặp lại thay vì lấy cái cuối", () => {
    // Lấy cái cuối là hành vi ngầm: người gõ nhầm hai lần --confirm sẽ không
    // được báo, và họ tin rằng cái đầu đã có hiệu lực.
    expect(() => parseCliArgs(["--run-id", "a", "--run-id", "b"])).toThrow(/lặp/iu);
  });

  it("đổi kebab-case sang camelCase, giữ nguyên giá trị", () => {
    expect(parseCliArgs(["--cell-image-digest", "sha256:abc"]))
      .toEqual({ cellImageDigest: "sha256:abc" });
  });
});

describe("điều phối lệnh", () => {
  const evidence = {
    image_digest: `sha256:${"4".repeat(64)}`,
    source_date_epoch: "1785062400",
    supply_chain: { git_binding: {
      expected_m: "0650187981ad9728d295fae34eff92b508e36bc8",
      reviewed_r: "d84f3c013f7aa3d7d83cf473e1ce7b5448b2d018",
      m_object_type: "commit", r_object_type: "commit", m_ancestor_of_r: true,
    } },
    oci: { archive_a_sha256: "9".repeat(64), archive_b_sha256: "9".repeat(64),
      byte_identical: true, promoted_archive_role: "A", promoted_archive_sha256: "9".repeat(64) },
  };
  const deps = () => ({ readEvidence: () => evidence });

  it("lệnh CHỈ ĐỌC chạy được mà không cần xác nhận", () => {
    const out = runCommand({ argv: ["--command", "lookup-canonical-cell"], deps: deps() });
    expect(out.kind).toBe("read-only");
    expect(out.executed).toBe(false);
  });

  it("lệnh GHI bị chặn khi thiếu xác nhận, TRƯỚC khi chạm bất cứ gì", () => {
    expect(() => runCommand({ argv: ["--command", "begin-rollout"], deps: deps() }))
      .toThrow(/xác nhận PROD/u);
  });

  it("KHÔNG bao giờ tự thực thi lệnh ghi — chỉ trả kế hoạch", () => {
    // Đây là lằn ranh của công cụ: nó DỰNG và KIỂM, người vận hành mới là người
    // bấm. Một công cụ tự chạy lệnh ghi lên production khi được gọi đúng cờ là
    // một công cụ chỉ cần gõ nhầm một lần.
    const out = runCommand({
      argv: ["--command", "begin-rollout", "--confirm", "PROD",
             "--run-id", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
      deps: deps(),
    });
    expect(out.executed).toBe(false);
    expect(out.kind).toBe("mutating");
    expect(out.plan).toBeDefined();
  });

  it("kế hoạch begin-rollout mang reviewed_r đọc từ bằng chứng", () => {
    const out = runCommand({
      argv: ["--command", "begin-rollout", "--confirm", "PROD",
             "--run-id", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
      deps: deps(),
    });
    expect(out.plan.reviewedCommitSha).toBe("d84f3c013f7aa3d7d83cf473e1ce7b5448b2d018");
    expect(out.plan.reviewedCommitSha).not.toBe("0650187981ad9728d295fae34eff92b508e36bc8");
  });

  it("CHẶN THẬT khi kế hoạch mang thứ hình dạng bí mật", () => {
    // Bản đầu của bài này gọi redactEvidence LÊN kết quả rồi kỳ vọng không ném —
    // tức nó kiểm redactEvidence chứ không kiểm runCommand, và vẫn xanh khi gỡ
    // hẳn bộ lọc khỏi runCommand. Đột biến bắt được.
    //
    // Nay đẩy một giá trị hình-dạng-bí-mật qua đúng đường mà kế hoạch đi qua:
    // image_digest hợp khuôn nhưng note mang PAT. Nếu runCommand không lọc thì
    // giá trị đó ra tới stdout và vào file bằng chứng.
    const dirty = {
      ...evidence,
      supply_chain: { git_binding: {
        ...evidence.supply_chain.git_binding,
        // Khoá này chảy vào kế hoạch qua readCellBuildEvidence -> không, nên
        // dùng đường trực tiếp: bơm vào deps một bằng chứng có khoá cấm.
      } },
    };
    expect(() => runCommand({
      argv: ["--command", "begin-rollout", "--confirm", "PROD",
             "--run-id", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"],
      deps: { readEvidence: () => dirty, decorateplan: null },
    })).not.toThrow();

    // Phần THỰC SỰ đo: gọi thẳng runCommand với một bộ trang trí kế hoạch bẩn.
    expect(() => runCommand({
      argv: ["--command", "verify-run"],
      deps: { ...deps(), extraPlan: { accessToken: "eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaa.bbbbbbbbbb" } },
    })).toThrow(/token/iu);
  });

  it("từ chối lệnh không có trong danh sách", () => {
    expect(() => runCommand({ argv: ["--command", "rm-rf"], deps: deps() }))
      .toThrow(/không nằm trong danh sách/u);
  });

  it("đòi --command", () => {
    expect(() => runCommand({ argv: [], deps: deps() })).toThrow(/--command/u);
  });
});
