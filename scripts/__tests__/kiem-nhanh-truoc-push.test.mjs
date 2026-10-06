// Sổ cho phần STAGE + LOCK của kiem-nhanh-truoc-push (28/08/2026).
//
// Bản cũ stage theo delta `git status` toàn repo trước/sau Bước 1 ∪ mọi file
// bẩn dưới docs/generated/ — trên working tree chung nhiều phiên, nó vơ cả file
// phiên khác ghi trong cửa sổ 30-60s và file bẩn sẵn của họ vào staging của
// mình (vi phạm chính Contract §3/§11.3 mà nó phục vụ). Bản mới: allowlist SỞ
// HỮU tường minh theo từng generator, so với INDEX chứ không so trước/sau.
import { describe, expect, it } from "vitest";

import {
  GATE_NANG,
  GATE_NHANH,
  GATE_TAM_HOAN,
  TU_CHUA,
  chayGioiHan,
  danhGiaLock,
  danhSachChay,
  dungMigration,
  quyetDinhDoRoOrg,
  soLuongSongSong,
  thuocSoHuu,
  tinhTapStage,
} from "../kiem-nhanh-truoc-push.mjs";
import { isDeferredTest } from "../lib/deferred-modules.mjs";

describe("thuocSoHuu", () => {
  it("khớp file đích danh và tiền tố thư mục (kết thúc bằng /)", () => {
    expect(thuocSoHuu("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(thuocSoHuu("docs/generated/x.md", ["docs/generated/"])).toBe(true);
    expect(thuocSoHuu("docs/generated-khac/x.md", ["docs/generated/"])).toBe(false);
    expect(thuocSoHuu("src/a.ts.bak", ["src/a.ts"])).toBe(false);
  });
});

describe("tinhTapStage", () => {
  const muc = (over) => ({ ten: "t", kieu: "may", soHuu: [], thanhCong: true, daSua: [], ...over });

  it("may: chỉ stage file THUỘC soHuu đang khác index — file lạ của phiên khác không bị vơ", () => {
    const cacMuc = [muc({ soHuu: ["src/integrations/supabase/types.ts"] })];
    const dangKhac = new Set([
      "src/integrations/supabase/types.ts",
      "docs/generated/gia-lap-phien-khac.md", // bẩn dưới docs/generated nhưng KHÔNG ai sở hữu
      "src/copilot/wip-phien-khac.ts",
    ]);
    const { stage } = tinhTapStage(cacMuc, dangKhac, new Set());
    expect(stage).toEqual(["src/integrations/supabase/types.ts"]);
  });

  it("may nhưng generator HỎNG (offline) ⇒ không đụng soHuu của nó", () => {
    const cacMuc = [muc({ soHuu: ["contracts/surfaces/rpc-surface.json"], thanhCong: false })];
    const { stage } = tinhTapStage(cacMuc, new Set(["contracts/surfaces/rpc-surface.json"]), new Set());
    expect(stage).toEqual([]);
  });

  it("va-tay: stage file DA_SUA của lượt này, BỎ QUA file đã bẩn từ trước (có thể phiên khác)", () => {
    const cacMuc = [muc({ kieu: "va-tay", daSua: ["docs/CODEBASE_STRUCTURE.md", "supabase/README.md"] })];
    const banTruoc = new Set(["docs/CODEBASE_STRUCTURE.md"]);
    const { stage, boQua } = tinhTapStage(cacMuc, new Set(), banTruoc);
    expect(stage).toEqual(["supabase/README.md"]);
    expect(boQua.map((b) => b.file)).toEqual(["docs/CODEBASE_STRUCTURE.md"]);
  });

  it("chạy hai lần liên tiếp vẫn stage đủ — so với INDEX, không so trước/sau", () => {
    // Lượt 2 generator không sinh gì mới, nhưng artifact của lượt 1 chưa stage
    // vẫn đang khác index ⇒ vẫn vào tập stage. Đây là ca mà phép delta cũ hụt.
    const cacMuc = [muc({ soHuu: ["docs/generated/repository-inventory.json"] })];
    const { stage } = tinhTapStage(cacMuc, new Set(["docs/generated/repository-inventory.json"]), new Set());
    expect(stage).toEqual(["docs/generated/repository-inventory.json"]);
  });
});

describe("danhGiaLock", () => {
  const pidSong = () => true;
  const pidChet = () => false;

  it("pid còn sống trong hạn ⇒ song (phải chờ)", () => {
    expect(danhGiaLock({ pid: 123, batDauMs: 1000 }, pidSong, 1000 + 60_000)).toBe("song");
  });

  it("pid đã chết ⇒ stale (chiếm được)", () => {
    expect(danhGiaLock({ pid: 123, batDauMs: 1000 }, pidChet, 2000)).toBe("stale");
  });

  it("quá 20 phút ⇒ stale kể cả pid còn sống — gate không chạy lâu vậy, đó là xác treo", () => {
    expect(danhGiaLock({ pid: 123, batDauMs: 0 }, pidSong, 21 * 60 * 1000)).toBe("stale");
  });

  it("lock hỏng/không đọc được ⇒ stale", () => {
    expect(danhGiaLock(null, pidSong, 0)).toBe("stale");
    expect(danhGiaLock({ khong: "co-pid" }, pidSong, 0)).toBe("stale");
  });
});

// ── Bước 3: đo rò chéo tổ chức (15/09/2026) ─────────────────────────────────
//
// Vì sao có: `measure-org-leak` chỉ chạy trong job `security-gates` — tức CHỈ
// sau khi đã push lên main, và chỉ khi có PAT. Người ngồi máy không có cách nào
// biết trước. Nhưng nó cần mạng + credential, nên nó KHÔNG được phép giả xanh
// khi thiếu: thiếu credential là ⚠, trừ khi commit này đụng migration — lúc đó
// chính là lúc phép đo có giá trị nhất, nên thiếu là ❌.
describe("dungMigration", () => {
  it("chỉ tính file dưới supabase/migrations/", () => {
    expect(dungMigration(["supabase/migrations/20260915_x.sql"])).toBe(true);
    expect(dungMigration(["docs/a.md", "supabase/migrations/y.sql"])).toBe(true);
    expect(dungMigration(["supabase/functions/llm-proxy/index.ts"])).toBe(false);
    expect(dungMigration(["supabase/migrations-archive/z.sql"])).toBe(false);
    expect(dungMigration([])).toBe(false);
  });
});

describe("quyetDinhDoRoOrg", () => {
  it("tắt tường minh ⇒ bỏ qua", () => {
    expect(quyetDinhDoRoOrg({ bat: false, coCredential: true, dungMigration: false })).toBe("bo-qua");
  });

  it("có credential ⇒ chạy thật", () => {
    expect(quyetDinhDoRoOrg({ bat: true, coCredential: true, dungMigration: false })).toBe("chay");
  });

  it("thiếu credential, KHÔNG đụng migration ⇒ cảnh báo, không giả xanh", () => {
    expect(quyetDinhDoRoOrg({ bat: true, coCredential: false, dungMigration: false })).toBe("canh-bao");
  });

  it("thiếu credential mà ĐỤNG migration ⇒ đỏ — đúng lúc cần đo nhất thì không được bỏ", () => {
    expect(quyetDinhDoRoOrg({ bat: true, coCredential: false, dungMigration: true })).toBe("do");
  });
});

describe("danh sách gate", () => {
  it("hoãn gate và generator chuyên biệt nhưng vẫn kiểm tiền, quyền, migration", () => {
    expect(GATE_TAM_HOAN).toContain("check-copilot-tool-inventory");
    expect(GATE_TAM_HOAN).toContain("check-doc-freshness");
    expect(GATE_NHANH).not.toContain("check-copilot-tool-inventory");
    expect(GATE_NHANH).not.toContain("check-doc-freshness");
    expect(TU_CHUA.some(([, args]) => args[0] === "scripts/generate-copilot-guide-corpus.mjs")).toBe(false);
    for (const gate of ["check-money-table-dml", "check-route-permission-drift", "check-migration-provenance", "check-test-matrix"]) {
      expect(GATE_NHANH).toContain(gate);
    }
  });

  it("hoãn test chuyên biệt kể cả đường Windows, không mở rộng sang file kế bên", () => {
    for (const path of [
      "src/copilot/model.test.ts", "src/copilot/ui/chat.test.tsx",
      "src\\hooks\\chat-zalo\\__tests__\\chat.test.ts",
      "worker/__tests__/automation-runner.test.js",
      "scripts/__tests__/check-copilot-routes.test.mjs",
      ".e2e-fleet/specs/chat-zalo.spec.ts",
    ]) expect(isDeferredTest(path), path).toBe(true);
    for (const path of [
      "src/copilot-other/chat.test.ts", "src/hooks/chat-zalo-other/chat.test.ts",
      "src/hooks/__tests__/OrganizationContext.test.ts",
      "src/lib/__tests__/copilotAuthorizedScopeRevocationMigration.test.ts",
      "src/lib/__tests__/copilotMockOffFinalizeClampMigration.test.ts",
      "src/lib/quickEntry/__tests__/convert.test.ts",
      "supabase/functions/llm-proxy/index.test.ts",
      "supabase/functions/quick-entry/index.test.ts",
      "scripts/__tests__/check-csp-build-attestation.test.mjs",
      "worker/__tests__/room-list-table-parity.test.js",
      "worker/__tests__/lifecycle-sale.test.js",
    ]) expect(isDeferredTest(path), path).toBe(false);
  });

  it("lint ratchet nằm trong nhóm NẶNG — nó là gate CI hay đỏ sau push, nhưng chạy 3,5 phút", () => {
    expect(GATE_NANG).toContain("check-eslint-baseline");
    expect(GATE_NHANH).not.toContain("check-eslint-baseline");
  });

  it("không có gate nào khai hai lần", () => {
    const ten = [...GATE_NHANH, ...GATE_NANG].map((m) => (Array.isArray(m) ? m.join(" ") : m));
    expect(ten.length).toBe(new Set(ten).size);
  });
});

// ── Chạy song song (01/10/2026) ──────────────────────────────────────────────
//
// Đo 01/10: 41 cửa tĩnh chạy lần lượt 72 s, chạy 8 cửa cùng lúc 42 s; nhóm nặng
// (kiểm kiểu + đảo strict + lint) có cache thì mỗi cửa còn vài giây đến 16 s.
// Song song không được đổi KẾT LUẬN: kết quả in theo đúng thứ tự khai, và mỗi cửa
// vẫn chạy đủ một lần.
describe("soLuongSongSong", () => {
  it("chừa 2 luồng cho máy, tối thiểu 2, tối đa 8", () => {
    expect(soLuongSongSong(16)).toBe(8);
    expect(soLuongSongSong(6)).toBe(4);
    expect(soLuongSongSong(2)).toBe(2);
    expect(soLuongSongSong(1)).toBe(2);
  });
});

describe("chayGioiHan", () => {
  it("chạy đủ mọi việc, trả kết quả đúng thứ tự khai dù xong lệch nhau", async () => {
    const tre = [30, 5, 20, 1, 10];
    const kq = await chayGioiHan(
      tre.map((ms, i) => () => new Promise((r) => setTimeout(() => r(i), ms))),
      3,
    );
    expect(kq).toEqual([0, 1, 2, 3, 4]);
  });

  it("không bao giờ vượt giới hạn số việc chạy cùng lúc", async () => {
    let dangChay = 0;
    let caoNhat = 0;
    const viec = Array.from({ length: 9 }, () => async () => {
      dangChay += 1;
      caoNhat = Math.max(caoNhat, dangChay);
      await new Promise((r) => setTimeout(r, 5));
      dangChay -= 1;
      return true;
    });
    const kq = await chayGioiHan(viec, 3);
    expect(kq).toHaveLength(9);
    expect(caoNhat).toBe(3);
  });
});

describe("danhSachChay", () => {
  it("đủ bộ: nhóm nặng xếp TRƯỚC để việc dài khởi động sớm, rồi tới nhóm tĩnh", () => {
    const ds = danhSachChay({ boDaoStrict: false });
    expect(ds.slice(0, GATE_NANG.length)).toEqual(GATE_NANG);
    expect(ds.slice(GATE_NANG.length)).toEqual(GATE_NHANH);
  });

  it("--khong-dao-strict: chỉ nhóm tĩnh", () => {
    expect(danhSachChay({ boDaoStrict: true })).toEqual(GATE_NHANH);
  });

  it("kiểm kiểu (typecheck:baseline) nằm trong nhóm nặng — CI có chạy nó, gate máy phải có", () => {
    expect(GATE_NANG).toContain("check-ts-baseline");
    expect(GATE_NHANH).not.toContain("check-ts-baseline");
  });
});

describe("đảo strict trong gate", () => {
  it("mỗi đảo một cửa riêng (chạy song song), phủ đủ mọi đảo, không chạy gộp thêm lần nữa", async () => {
    const { DAO } = await import("../check-strict-islands.mjs");
    for (const d of DAO) expect(GATE_NANG).toContainEqual(["check-strict-islands", "--dao", d.ten]);
    expect(GATE_NANG).not.toContain("check-strict-islands");
  });
});
