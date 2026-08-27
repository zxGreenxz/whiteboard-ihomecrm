// Guard TĨNH cho bất biến của "chốt lợi nhuận theo TỪNG NHÀ".
//
// Quyết định nằm trong plpgsql nên vitest không chạy được logic thật — ta đọc
// định nghĩa SỐNG của hàm (lần CREATE cuối cùng trên toàn bộ thư mục migration)
// và chốt hình dạng của các guard. Đọc một file migration cố định là VÔ NGHĨA ở
// repo này: file cũ bị đóng băng bởi provenance sha256, còn hành vi thì dời sang
// forward-fix mới — test sẽ xanh vĩnh viễn. Xem
// `scripts/check-migration-test-liveness.mjs`.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  describeTotalGroupExpansion,
  expandTotalGroupSelection,
  resolveCloseAction,
  type TotalGroupPeerMap,
} from "@/lib/profitClose";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

/** Bỏ comment `-- ...`: header migration mô tả cả LUẬT CŨ để đối chiếu. */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

let corpusCache: { file: string; sql: string }[] | null = null;
function migrationCorpus(): { file: string; sql: string }[] {
  if (!corpusCache) {
    corpusCache = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({
        file: f,
        sql: stripComments(readFileSync(join(MIG_DIR, f), "utf8")),
      }));
  }
  return corpusCache;
}

/** Định nghĩa SỐNG của một hàm = lần CREATE cuối cùng theo thứ tự timestamp. */
function liveDefinitionOf(fnName: string): { file: string; sql: string } {
  const re = new RegExp(
    `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`,
    "i",
  );
  let hit: { file: string; sql: string } | null = null;
  for (const m of migrationCorpus()) {
    if (re.test(m.sql)) hit = m;
  }
  if (!hit) throw new Error(`Không tìm thấy định nghĩa nào của public.${fnName}`);
  return hit;
}

/**
 * THÂN của định nghĩa sống, không phải cả file.
 *
 * Một migration thường định nghĩa nhiều hàm cạnh nhau, nên quét cả file cho ra
 * báo động giả theo cả hai chiều: khẳng định "có X" đậu nhờ hàm hàng xóm, và
 * khẳng định "không có X" đỏ oan cũng vì hàm hàng xóm. Cắt đúng khối
 * `CREATE ... AS $tag$ ... $tag$` mới là phép đo.
 */
function liveBodyOf(fnName: string): { file: string; body: string } {
  const { file, sql } = liveDefinitionOf(fnName);
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`,
    "gi",
  );
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) start = match.index;
  if (start < 0) throw new Error(`Không cắt được thân public.${fnName}`);

  const tail = sql.slice(start);
  const tagMatch = /AS\s+(\$[A-Za-z_]*\$)/.exec(tail);
  if (!tagMatch) throw new Error(`public.${fnName} không có khối dollar-quote`);
  const tag = tagMatch[1];
  const bodyStart = tagMatch.index + tagMatch[0].length;
  const end = tail.indexOf(tag, bodyStart);
  if (end < 0) throw new Error(`public.${fnName} thiếu dấu đóng ${tag}`);
  return { file, body: tail.slice(0, end + tag.length) };
}

describe("bất biến SQL: writer chốt lợi nhuận cho phép ghi một phần", () => {
  it("không còn bắt CLOSE/RECLOSE phủ mọi nhà của tổ chức", () => {
    const { file, body: sql } = liveBodyOf("_profit_write_close_v2_base");
    expect(
      /must include every active real building/i.test(sql),
      `${file}: writer vẫn còn guard toàn-phủ. Chốt theo từng nhà là yêu cầu của ` +
        `chủ (27/08/2026) — thứ thay thế guard đó là guard đóng-theo-TOTAL_GROUP.`,
    ).toBe(false);
  });

  it("giữ guard đóng-theo-TOTAL_GROUP thay cho guard toàn-phủ", () => {
    const { file, body: sql } = liveBodyOf("_profit_write_close_v2_base");
    expect(
      /TOTAL_GROUP_KHONG_DU/.test(sql),
      `${file}: bỏ guard toàn-phủ mà không có guard TOTAL_GROUP là mở đường cho ` +
        `lương điều hành cả nhóm bị dồn sai vào phần nhà đã chốt, KHÔNG có gì báo.`,
    ).toBe(true);
    expect(
      /basis\s*=\s*'TOTAL_GROUP'/.test(sql),
      `${file}: guard phải soi đúng quy tắc basis='TOTAL_GROUP'.`,
    ).toBe(true);
  });

  it("preview của writer chạy trên phạm vi TOÀN THÁNG, không phải tập ghi", () => {
    const { file, body: sql } = liveBodyOf("_profit_write_close_v2_base");
    // v_scope_ids = mọi nhà thật của org; v_building_ids = tập ghi.
    expect(
      /_profit_close_preview_core_v2\s*\(\s*[\s\S]{0,120}?v_scope_ids/.test(sql),
      `${file}: writer phải truyền v_scope_ids (cả tháng) vào preview core. ` +
        `Truyền tập ghi vào sẽ đổi source_hash theo vùng chọn và làm mọi snapshot ` +
        `đã LOCKED hoá "lệch nguồn".`,
    ).toBe(true);
  });

  it("vẫn ghi source_snapshot toàn tháng cho đường canh độ tươi phiếu chi", () => {
    const { file, body: sql } = liveBodyOf("_profit_write_close_v2_base");
    expect(
      /source_snapshot[\s\S]{0,400}v_preview->'source_snapshot'/.test(sql),
      `${file}: profit_close_runs.source_snapshot phải là tài liệu nguồn TOÀN ` +
        `THÁNG — app_private.current_profit_building_source_hash_v1 dựng lại hash ` +
        `từ run.source_snapshot->'pnl'.`,
    ).toBe(true);
  });

  it("đặt lại nhận phạm vi theo nhà nhưng vẫn CAS toàn kỳ", () => {
    const { file, body: sql } = liveBodyOf("profit_reset_checked_v2");
    expect(
      /p_target_building_ids\s+uuid\[\]/.test(sql),
      `${file}: profit_reset_checked_v2 phải nhận p_target_building_ids để đặt lại ` +
        `từng nhà.`,
    ).toBe(true);
    expect(
      /PROFIT_SNAPSHOT_CONFLICT/.test(sql),
      `${file}: CAS toàn kỳ (expected_state_hash + expected_snapshot_ids) là thứ ` +
        `chặn đặt lại trên trạng thái đã cũ — không được nới cùng lúc với việc thu ` +
        `hẹp phạm vi tác động.`,
    ).toBe(true);
  });

  it("bản đồ nhóm TOTAL_GROUP không chạm vào tài liệu nguồn", () => {
    const { file, body: sql } = liveBodyOf("profit_total_group_peers_v2");
    expect(
      /building_source_hash/.test(sql),
      `${file}: hàm bản đồ nhóm chỉ phục vụ giao diện; đụng vào building_source_hash ` +
        `là làm mọi snapshot đang LOCKED hoá stale.`,
    ).toBe(false);
  });
});

describe("mở rộng vùng chọn theo nhóm TOTAL_GROUP", () => {
  // Đúng cấu hình thật của org iHome CRM: quy tắc "Tagii" FIXED 3.000.000đ phủ
  // bốn nhà. Sáu nhà của JOEY/NATHAN không dính quy tắc nào.
  const peers: TotalGroupPeerMap = {
    b32: { peerIds: ["b32", "b45", "b512", "b80"], peerNames: "32PVC, 45/3, 512TT, 80DS3", ruleLabels: "Tagii" },
    b45: { peerIds: ["b32", "b45", "b512", "b80"], peerNames: "32PVC, 45/3, 512TT, 80DS3", ruleLabels: "Tagii" },
    b512: { peerIds: ["b32", "b45", "b512", "b80"], peerNames: "32PVC, 45/3, 512TT, 80DS3", ruleLabels: "Tagii" },
    b80: { peerIds: ["b32", "b45", "b512", "b80"], peerNames: "32PVC, 45/3, 512TT, 80DS3", ruleLabels: "Tagii" },
  };

  it("kéo cả nhóm vào khi mới chọn một nhà", () => {
    expect(expandTotalGroupSelection(["b32"], peers)).toEqual({
      buildingIds: ["b32", "b45", "b512", "b80"],
      added: ["b45", "b512", "b80"],
    });
  });

  it("không thêm gì khi nhóm đã đủ", () => {
    expect(
      expandTotalGroupSelection(["b32", "b45", "b512", "b80"], peers).added,
    ).toEqual([]);
  });

  it("để yên nhà không dính quy tắc nào", () => {
    expect(expandTotalGroupSelection(["b111", "b158"], peers)).toEqual({
      buildingIds: ["b111", "b158"],
      added: [],
    });
  });

  it("bắc cầu qua hai quy tắc chồng nhau", () => {
    // x–y chung quy tắc A, y–z chung quy tắc B. Chọn x phải kéo cả z.
    const chained: TotalGroupPeerMap = {
      x: { peerIds: ["x", "y"], peerNames: "X, Y", ruleLabels: "A" },
      y: { peerIds: ["x", "y", "z"], peerNames: "X, Y, Z", ruleLabels: "A, B" },
      z: { peerIds: ["y", "z"], peerNames: "Y, Z", ruleLabels: "B" },
    };
    expect(expandTotalGroupSelection(["x"], chained)).toEqual({
      buildingIds: ["x", "y", "z"],
      added: ["y", "z"],
    });
  });

  it("nêu đúng quy tắc đang kéo thêm nhà để giải thích cho người dùng", () => {
    const { added } = expandTotalGroupSelection(["b32"], peers);
    expect(describeTotalGroupExpansion(["b32"], added, peers)?.ruleLabels).toBe(
      "Tagii",
    );
  });

  it("không giải thích gì khi không thêm nhà nào", () => {
    expect(describeTotalGroupExpansion(["b111"], [], peers)).toBeNull();
  });
});

describe("chọn CLOSE hay RECLOSE theo vùng chọn", () => {
  const draft = (id: string) => ({ building_id: id, current_snapshot: null });
  const locked = (id: string) => ({
    building_id: id,
    current_snapshot: { status: "LOCKED" as const },
  });

  it("toàn nhà chưa chốt là CLOSE", () => {
    expect(resolveCloseAction([draft("a"), draft("b")])).toBe("CLOSE");
  });

  it("toàn nhà đã chốt là RECLOSE", () => {
    expect(resolveCloseAction([locked("a"), locked("b")])).toBe("RECLOSE");
  });

  it("lẫn hai trạng thái là MIXED — profit_close_v2 và profit_reclose_v2 là hai RPC", () => {
    expect(resolveCloseAction([draft("a"), locked("b")])).toBe("MIXED");
  });

  it("không chọn gì là EMPTY", () => {
    expect(resolveCloseAction([])).toBe("EMPTY");
  });

  it("snapshot DRAFT tính như chưa chốt", () => {
    expect(
      resolveCloseAction([
        { building_id: "a", current_snapshot: { status: "DRAFT" } },
      ]),
    ).toBe("CLOSE");
  });
});
