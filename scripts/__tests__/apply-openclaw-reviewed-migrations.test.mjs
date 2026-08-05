import { describe, expect, it } from "vitest";

import {
  OPENCLAW_MIGRATION_PATTERN,
  OPENCLAW_REVIEWED_COUNT,
  assertNoDestructiveSql,
  buildManifest,
  planApply,
  readReviewedManifest,
  verifyReviewedTree,
} from "../apply-openclaw-reviewed-migrations.mjs";
import { OPENCLAW_MIGRATIONS } from "../test-openclaw-migrations.mjs";

/**
 * Hợp đồng của công cụ áp migration đã-được-duyệt lên production.
 *
 * Công cụ này KHÔNG được phép "thông minh". Nó áp đúng bộ đã duyệt, đúng thứ tự,
 * từng file một, dừng ngay ở lỗi đầu tiên. Mọi đường tắt — áp song song, tự sửa,
 * tự quay lui — đều là cách biến một sự cố nhỏ thành một schema không ai còn mô
 * tả được.
 *
 * Mọi phụ thuộc đều TIÊM VÀO: bộ test này không chạm git thật lẫn database thật.
 */

const REVIEWED = "0650187981ad9728d295fae34eff92b508e36bc8";

/** git giả, trả nội dung theo (sha, path). */
function fakeGit(names, bodyOf = (n) => `-- ${n}\n`) {
  return {
    show: (sha, path) => {
      const name = path.split("/").at(-1);
      if (sha !== REVIEWED || !names.includes(name)) throw new Error(`không có blob ${sha}:${path}`);
      return bodyOf(name);
    },
    listMigrations: (sha) => (sha === REVIEWED ? [...names] : []),
  };
}

const REAL = [...OPENCLAW_MIGRATIONS].sort();

describe("danh sách đã duyệt được DẪN XUẤT, không chép tay", () => {
  it("khớp đúng nguồn sự thật của harness", () => {
    // ĐÂY là bài đã bắt được lỗi thật: bản đầu tiên của module chép tay 12 tên
    // và sai ba cái, trong khi SỐ LƯỢNG vẫn đúng 12 nên không gì đỏ. Đếm thì
    // không đủ — phải đối chiếu TÊN với nguồn duy nhất.
    const derived = readReviewedManifest({ git: fakeGit(REAL), reviewedSha: REVIEWED });
    expect([...derived]).toEqual(REAL);
  });

  it("số file là hằng số, và mọi tên theo đúng khuôn", () => {
    expect(OPENCLAW_MIGRATIONS).toHaveLength(OPENCLAW_REVIEWED_COUNT);
    for (const name of REAL) {
      expect(name, `${name} sai khuôn`).toMatch(OPENCLAW_MIGRATION_PATTERN);
    }
  });

  it("từ chối cây THIẾU file", () => {
    const git = fakeGit(REAL.slice(0, REAL.length - 1));
    expect(() => readReviewedManifest({ git, reviewedSha: REVIEWED })).toThrow(/phải đúng 12/u);
  });

  it("từ chối cây có THÊM file openclaw chưa duyệt", () => {
    // Ca nguy hiểm và dễ bỏ sót nhất: schema vẫn chạy được, chỉ là có một
    // migration không ai đọc qua.
    const git = fakeGit([...REAL, "20260727999999_openclaw_len_lut.sql"]);
    expect(() => readReviewedManifest({ git, reviewedSha: REVIEWED })).toThrow(/phải đúng 12/u);
  });

  it("từ chối SHA sai khuôn", () => {
    for (const bad of ["", "HEAD", "main", REVIEWED.slice(0, 39), `${REVIEWED}x`]) {
      expect(
        () => readReviewedManifest({ git: fakeGit(REAL), reviewedSha: bad }),
        `SHA "${bad}" vẫn qua`,
      ).toThrow(/SHA/iu);
    }
  });
});

describe("băm manifest", () => {
  it("băm từng file và một băm tổng, tất cả 64 hex", () => {
    const manifest = buildManifest({ git: fakeGit(REAL), reviewedSha: REVIEWED });
    expect(Object.keys(manifest.files)).toEqual(REAL);
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(hash, `${name} băm sai khuôn`).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(manifest.aggregate).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("đổi MỘT byte trong MỘT file thì băm tổng phải đổi", () => {
    const a = buildManifest({ git: fakeGit(REAL), reviewedSha: REVIEWED });
    const b = buildManifest({
      git: fakeGit(REAL, (n) => (n === REAL[5] ? "-- doi\n" : `-- ${n}\n`)),
      reviewedSha: REVIEWED,
    });
    expect(b.aggregate).not.toBe(a.aggregate);
  });

  it("ĐỔI CHỖ hai file thì băm tổng phải đổi", () => {
    // Băm tổng phải ràng cả THỨ TỰ. Một phép băm chỉ cộng dồn nội dung sẽ cho
    // cùng kết quả khi đảo chỗ, mà thứ tự chính là thứ quyết định migration nào
    // nhìn thấy schema ở trạng thái nào.
    const straight = buildManifest({ git: fakeGit(REAL), reviewedSha: REVIEWED });
    const swapped = buildManifest({
      git: fakeGit(REAL),
      reviewedSha: REVIEWED,
      order: [REAL[1], REAL[0], ...REAL.slice(2)],
    });
    expect(swapped.aggregate).not.toBe(straight.aggregate);
  });
});

describe("đối chiếu cây với danh sách chờ đợi", () => {
  it("cùng SỐ LƯỢNG nhưng khác TÊN vẫn phải bị từ chối", () => {
    // Chính xác cái bẫy đã suýt lọt: 12 file, vẫn 12, nhưng là 12 file khác.
    const wrong = [...REAL.slice(0, 11), "20260727999999_openclaw_gia_mao.sql"].sort();
    expect(() => verifyReviewedTree({
      git: fakeGit(wrong), reviewedSha: REVIEWED, expected: REAL,
    })).toThrow(/không khớp/iu);
  });

  it("khớp thì trả về danh sách đọc từ cây", () => {
    const out = verifyReviewedTree({ git: fakeGit(REAL), reviewedSha: REVIEWED, expected: REAL });
    expect([...out.files]).toEqual(REAL);
  });
});

describe("chặn SQL phá huỷ", () => {
  it("từ chối drop / truncate / rollback", () => {
    // Công cụ này CHỈ áp thêm. Một `drop` lọt vào nghĩa là ai đó đang quay lui
    // bằng migration — thứ kế hoạch cấm: sửa sai phải bằng migration TIẾN TỚI.
    for (const sql of [
      "drop table public.openclaw_accounts;",
      "DROP FUNCTION app_private.x();",
      "truncate public.openclaw_outbox;",
      "alter table public.openclaw_accounts drop column display_name;",
      "rollback;",
    ]) {
      expect(() => assertNoDestructiveSql("x.sql", sql), `lọt: ${sql}`).toThrow();
    }
  });

  it("cho qua SQL thêm-mới thuần, kể cả khi chú thích có chữ drop", () => {
    // Mặt THUẬN, và nó gánh thật: chặn nhầm một chú thích sẽ dạy người ta tắt
    // cổng, và một cổng bị tắt thì tệ hơn cổng không có.
    expect(() => assertNoDestructiveSql("x.sql", `
      -- ghi chú: KHÔNG được drop bảng này về sau
      create table if not exists public.a (id uuid primary key);
      alter table public.a add column if not exists b text;
      create policy p on public.a for select to anon using (true);
    `)).not.toThrow();
  });
});

describe("kế hoạch áp", () => {
  const okArgs = {
    reviewedSha: REVIEWED,
    projectRef: "tryymsxyyckgbrmmvozx",
    confirmProdOrg: "aaaa0000-0000-4000-8000-000000000001",
    confirmDemoOrg: "dddd0000-0000-4000-8000-000000000001",
    cleanWorktree: true,
    appliedRemote: [],
    manifest: REAL,
  };

  it("áp TUẦN TỰ đúng thứ tự manifest, không song song, dừng ở lỗi đầu", () => {
    const plan = planApply(okArgs);
    expect(plan.parallel).toBe(false);
    expect(plan.stopOnFirstFailure).toBe(true);
    expect(plan.steps.map((s) => s.file)).toEqual(REAL);
  });

  it("từ chối khi không truyền manifest đọc từ cây", () => {
    expect(() => planApply({ ...okArgs, manifest: undefined })).toThrow(/manifest/iu);
    expect(() => planApply({ ...okArgs, manifest: REAL.slice(0, 5) })).toThrow(/manifest/iu);
  });

  it("từ chối cây làm việc bẩn", () => {
    expect(() => planApply({ ...okArgs, cleanWorktree: false })).toThrow(/cây làm việc/iu);
  });

  it("từ chối project ref khác production", () => {
    expect(() => planApply({ ...okArgs, projectRef: "abcdefghijklmnopqrst" })).toThrow(/project/iu);
  });

  it("đòi xác nhận CẢ HAI tổ chức", () => {
    expect(() => planApply({ ...okArgs, confirmProdOrg: undefined })).toThrow(/tổ chức/iu);
    expect(() => planApply({ ...okArgs, confirmDemoOrg: undefined })).toThrow(/tổ chức/iu);
  });

  it("bỏ qua file đã ghi sổ ở xa, giữ nguyên thứ tự phần còn lại", () => {
    const plan = planApply({ ...okArgs, appliedRemote: REAL.slice(0, 4) });
    expect(plan.steps.map((s) => s.file)).toEqual(REAL.slice(4));
  });

  it("trả kế hoạch RỖNG khi mọi file đã ghi sổ — đúng trạng thái production hôm nay", () => {
    // 12/12 đã nằm trên production từ 03/08. Một công cụ áp mà gặp trạng thái này
    // lại đi áp lại là cách hỏng schema nhanh nhất.
    const plan = planApply({ ...okArgs, appliedRemote: REAL });
    expect(plan.steps).toEqual([]);
  });

  it("từ chối khi sổ ở xa có file openclaw KHÔNG nằm trong manifest", () => {
    // "Schema đã đi trước theo cách không ai mô tả được" — dừng, không đoán.
    expect(() => planApply({
      ...okArgs,
      appliedRemote: [...REAL, "20260727999999_openclaw_la.sql"],
    })).toThrow(/không nằm trong|đi trước/iu);
  });

  it("kế hoạch KHÔNG chứa thao tác dữ liệu fixture", () => {
    expect(planApply(okArgs).fixtureWrites).toEqual([]);
  });
});
