// Contract test for the G1-C2 read migration.
//
// The fourteen functions below cannot be exercised from vitest (they need a
// cluster and a JWT), so what is checked here is the part a reviewer forgets
// first and no type system catches: the authorization preamble, the row cap, the
// ACL, and — for the nine older RPCs that this migration re-issues — that their
// SIGNATURES really did not move. A `CREATE OR REPLACE` whose argument list
// drifted does not replace anything: it creates an OVERLOAD, PostgREST then
// picks between two functions by argument names, and the old body keeps serving
// traffic while the diff says it was fixed.
import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migrationPath =
  'supabase/migrations/20260902203258_copilot_read_rpc_operations_v1.sql';

/**
 * MỌI assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN — xem
 * `sqlTestUtils.test.ts` cho bài kiểm đột biến: một predicate bị `--` phải làm
 * test đỏ, chứ không được lặng lẽ khớp regex trên văn bản thô.
 */
const migration = boCommentSql(docSql(migrationPath));

/** The two migrations whose functions are re-issued here, as they were shipped. */
const NGUON_CU: Record<string, string> = {
  '20260828160000': 'supabase/migrations/20260828160000_copilot_server_scope_v2.sql',
  '20260829020000': 'supabase/migrations/20260829020000_copilot_customer_contract_scope_v1.sql',
};

function docFile(path: string): string {
  return boCommentSql(docSql(path));
}

/**
 * Body of one `CREATE OR REPLACE FUNCTION public.<name>` up to the next function
 * declaration or the ACL block.
 *
 * Deliberately NOT anchored on `$fn$;`: three of the nine older RPCs are
 * `LANGUAGE sql` and close with `$$;`, and an extractor that only knew one of
 * the two would silently return an empty body — which every `expect(...)` below
 * would then pass on a substring of nothing.
 */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i'));
  if (start < 0) return '';
  const rest = source.slice(start + 1);
  const nextFn = rest.search(/CREATE OR REPLACE FUNCTION/i);
  const acl = rest.search(/^REVOKE ALL ON FUNCTION/mi);
  const ends = [nextFn, acl].filter((index) => index >= 0);
  return ends.length === 0 ? source.slice(start) : source.slice(start, start + 1 + Math.min(...ends));
}

/** Argument list of one function declaration, whitespace-normalized. */
function chuKy(source: string, name: string): string {
  const start = source.search(new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i'));
  if (start < 0) return '';
  const open = source.indexOf('(', start);
  const close = source.indexOf(')', open);
  // No parameter list in this codebase contains a nested paren, so the first
  // closing paren is the right one; a future default like `DEFAULT now()` would
  // break that, and breaking loudly here is the point.
  return source
    .slice(open + 1, close)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const RPC_MOI = [
  'copilot_lead_search_v1',
  'copilot_meter_readings_v1',
  'copilot_vehicle_search_v1',
  'copilot_tasks_v1',
  'copilot_material_stock_v1',
] as const;

/** The four whose rows hang off a building; `materials` has no building column. */
const THEO_TOA = [
  'copilot_lead_search_v1',
  'copilot_meter_readings_v1',
  'copilot_vehicle_search_v1',
  'copilot_tasks_v1',
] as const;

const KHOA_QUYEN: Record<string, string> = {
  copilot_lead_search_v1: 'leads.view',
  copilot_meter_readings_v1: 'meter_readings.view',
  copilot_vehicle_search_v1: 'vehicles.view',
  copilot_tasks_v1: 'tasks.view',
  copilot_material_stock_v1: 'materials.view',
};

/** The nine older read RPCs re-issued here, with the migration that shipped them. */
const RPC_CU: Record<string, { nguon: keyof typeof NGUON_CU; tran: string }> = {
  copilot_available_rooms_v1: { nguon: '20260828160000', tran: 'LIMIT 2000' },
  copilot_invoice_search_v1: { nguon: '20260828160000', tran: 'LIMIT 2000' },
  copilot_financial_pnl_v1: { nguon: '20260828160000', tran: 'LIMIT 2000' },
  copilot_occupancy_v1: { nguon: '20260828160000', tran: 'LIMIT 2000' },
  copilot_occupancy_upcoming_v1: { nguon: '20260828160000', tran: 'LIMIT 2000' },
  // One aggregate row by construction — the cap says so instead of pretending
  // there is a list to shorten.
  copilot_invoice_stats_v1: { nguon: '20260828160000', tran: 'LIMIT 1' },
  copilot_deposit_summary_v1: { nguon: '20260828160000', tran: 'LIMIT 2000' },
  // Kept at the ten rows its caller was written against.
  copilot_customer_search_v1: { nguon: '20260829020000', tran: 'LIMIT 10' },
  copilot_expiring_contracts_v1: { nguon: '20260829020000', tran: 'LIMIT 2000' },
};

describe('copilot read RPC migration — leads, meters, vehicles, jobs, materials', () => {
  it('exists and is a single lock-bounded transaction', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('declares every new RPC SECURITY DEFINER, STABLE and with a pinned search_path', () => {
    for (const rpc of RPC_MOI) {
      const body = functionBody(migration, rpc);
      expect(body, rpc).not.toBe('');
      expect(body, rpc).toMatch(/\bSECURITY DEFINER\b/);
      expect(body, rpc).toMatch(/\bSTABLE\b/);
      expect(body, rpc).toMatch(/SET search_path = pg_catalog, public, app_private/);
      // plpgsql (not sql) matters: a `LANGUAGE sql` body is parsed at CREATE time
      // and would make this migration unrunnable on an empty database.
      expect(body, rpc).toMatch(/LANGUAGE plpgsql/);
    }
  });

  it('takes the organization boundary from the server, never from the caller', () => {
    for (const rpc of RPC_MOI) {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/p_organization_id uuid/);
      expect(body, rpc).toMatch(
        new RegExp(
          String.raw`copilot_org_scope_buildings_v1\('${KHOA_QUYEN[rpc].replace('.', '\\.')}', p_organization_id\)`,
        ),
      );
      expect(body, rpc).toMatch(/auth\.uid\(\)/);
      expect(body, rpc).toMatch(/not_permitted/);
      // No RPC may accept a client-supplied building/cashbook array.
      expect(body, rpc).not.toMatch(/p_building_ids|p_cashbook_ids/);
    }
  });

  it('clamps p_limit to 1..50 and echoes the effective cap', () => {
    for (const rpc of RPC_MOI) {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
      expect(body, rpc).toMatch(/LIMIT v_limit/);
      expect(body, rpc).toMatch(/'gioi_han', v_limit/);
    }
  });

  it('aggregates totals over the whole match set, not over the capped list', () => {
    // A count taken from a list that was just truncated is a wrong number with
    // nothing in the payload to say so. Both RPCs that report a total compute it
    // in a SEPARATE query that carries no LIMIT.
    const chiSo = functionBody(migration, 'copilot_meter_readings_v1');
    expect(chiSo).toMatch(/INTO v_tong_hop/);
    expect(chiSo).toMatch(/sum\(mr\.consumption\)/);
    expect(chiSo).toMatch(/'tong_hop', v_tong_hop/);

    const vatTu = functionBody(migration, 'copilot_material_stock_v1');
    expect(vatTu).toMatch(/INTO v_tong_hop/);
    expect(vatTu).toMatch(/count\(\*\) FILTER \(WHERE m\.on_hand < m\.reorder_level\)/);
  });

  it('validates the settlement month instead of pasting it into a filter', () => {
    const body = functionBody(migration, 'copilot_meter_readings_v1');
    expect(body).toMatch(/\^\[0-9\]\{4\}-\(0\[1-9\]\|1\[0-2\]\)\$/);
    expect(body).toMatch(/invalid_settlement_month/);
    // A building outside the caller scope answers like an empty period, never
    // like "exists but not yours".
    expect(body).toMatch(/p_building_id IS NOT NULL AND NOT \(p_building_id = ANY\(v_buildings\)\)/);
  });

  it('revokes PUBLIC/anon/authenticated then grants only authenticated', () => {
    for (const rpc of RPC_MOI) {
      expect(migration, rpc).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM PUBLIC;`),
      );
      expect(migration, rpc).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM anon;`),
      );
      expect(migration, rpc).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\) FROM authenticated;`),
      );
      expect(migration, rpc).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\) TO authenticated;`),
      );
    }
  });

  it('guards role-dependent statements so a bare cluster can replay it', () => {
    expect(migration).toMatch(/IF to_regrole\('anon'\) IS NOT NULL THEN/);
    expect(migration).toMatch(/IF to_regrole\('authenticated'\) IS NOT NULL THEN/);
  });

  it('writes nothing, anywhere', () => {
    expect(migration).not.toMatch(/\b(?:INSERT INTO|UPDATE\s+public\.|DELETE FROM)\b/i);
  });

  it('accepts on the catalog only — no fixture row, no data read', () => {
    const start = migration.indexOf('DO $nghiem_thu$');
    expect(start).toBeGreaterThan(0);
    const block = migration.slice(start);
    expect(block).toMatch(/to_regprocedure/);
    expect(block).toMatch(/has_function_privilege\('anon'/);
    for (const rpc of [...RPC_MOI, ...Object.keys(RPC_CU)]) expect(block, rpc).toContain(rpc);
    // A SELECT against a business table here would break the empty-DB property.
    expect(block).not.toMatch(/FROM public\.[a-z_]+/i);
  });

  it('is replayable: every DDL statement is CREATE OR REPLACE', () => {
    const creates = migration.match(/^\s*CREATE (?!OR REPLACE)[A-Z]/gm) ?? [];
    expect(creates).toEqual([]);
  });

  it('reuses the folding helper instead of deciding its body a second time', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION app_private\.copilot_fold_text_v1/);
    expect(migration).toMatch(/app_private\.copilot_fold_text_v1\(/);
  });
});

// GHIM CHÍNH DÒNG CHỊU LỰC, KHÔNG PHẢI DÒNG GỌI HÀM.
//
// Xoá `b.id = ANY(v_buildings)` khỏi mệnh đề JOIN thì lời gọi scope vẫn còn
// nguyên, mọi cửa chặn vẫn xanh, và mọi người dùng bị giới hạn theo TOÀ lặng lẽ
// được nâng lên phạm vi toàn công ty. Cái giá không hiện ra dưới dạng lỗi — nó
// hiện ra dưới dạng một câu trả lời "hợp lý" chứa sổ của những toà mà người hỏi
// không được xem.
describe('bien gioi thue bao — predicate chiu luc bi ghim tung dong', () => {
  /** Alias có `organization_id` trong từng thân hàm, liệt kê tay. */
  const ORG_ALIASES: Record<string, string[]> = {
    copilot_lead_search_v1: ['l', 'b', 'rm'],
    copilot_meter_readings_v1: ['mr', 'b', 'rm'],
    copilot_vehicle_search_v1: ['v', 'b', 'rm', 'cst'],
    copilot_tasks_v1: ['j', 'b', 'rm', 'jt'],
    copilot_material_stock_v1: ['m', 'mc'],
  };

  for (const rpc of THEO_TOA) {
    it(`${rpc}: gan tap toa server roi RANG ket qua vao no`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).not.toBe('');
      // Gọi thôi chưa đủ — phải GÁN.
      expect(body, `${rpc}: khong gan ket qua scope vao v_buildings`).toMatch(
        /v_buildings\s*:=\s*public\.copilot_org_scope_buildings_v1\(/,
      );
      // Và phải DÙNG. Đây là dòng chịu lực của cả biên giới thuê bao.
      expect(body, `${rpc}: thieu predicate b.id = ANY(v_buildings)`).toMatch(
        /b\.id\s*=\s*ANY\(v_buildings\)/,
      );
    });

    it(`${rpc}: hang khong co toa chi lot khi quyen la toan cong ty`, () => {
      // LEFT JOIN một mình là một cái cửa mở: hàng có `building_id` NGOÀI phạm
      // vi cũng cho `b.id IS NULL`, y hệt hàng chưa gắn toà. Điều kiện phải soi
      // CHÍNH cột nguồn (`<x>.building_id IS NULL`) chứ không phải kết quả nối.
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(
        /\(b\.id IS NOT NULL OR \([a-z]+\.building_id IS NULL AND v_org_wide\)\)/,
      );
      expect(body, rpc).toMatch(/authorized_scope_v3\('[a-z_]+\.view', p_organization_id\)/);
    });
  }

  for (const rpc of RPC_MOI) {
    it(`${rpc}: moi alias co organization_id deu mang bo loc cong ty`, () => {
      const body = functionBody(migration, rpc);
      for (const alias of ORG_ALIASES[rpc]) {
        expect(body, `${rpc}: alias "${alias}" thieu organization_id = p_organization_id`).toMatch(
          new RegExp(String.raw`\b${alias}\.organization_id\s*=\s*p_organization_id\b`),
        );
      }
    });
  }

  it('copilot_material_stock_v1: khong co cot toa, nen phai lay bien gioi bang PERFORM', () => {
    // `public.materials` không có `building_id` — RLS của nó là
    // `can_access_org_entity('materials','view')`. Không có toà để ràng, nên hai
    // thứ thay thế: khẳng định biên giới bằng PERFORM, và lọc bằng chính cột
    // công ty. Ghim để lần sau không ai "sửa" bằng một LEFT JOIN vô nghĩa.
    const body = functionBody(migration, 'copilot_material_stock_v1');
    expect(body).toMatch(
      /PERFORM public\.copilot_org_scope_buildings_v1\('materials\.view', p_organization_id\)/,
    );
    expect(body).not.toMatch(/ANY\(v_buildings\)/);
    expect(body).toMatch(/\bm\.organization_id = p_organization_id\b/);
  });

  it('dem du 14 ham doc — them mot ham moi phai them mot dong o day', () => {
    // Sàn chống bỏ quên theo chiều ngược: một hàm đọc thứ 15 ra đời mà quên khai
    // ở các danh sách trên thì con số này không khớp và test đỏ.
    const lan = migration.match(/CREATE OR REPLACE FUNCTION public\.copilot_/g) ?? [];
    expect(lan).toHaveLength(RPC_MOI.length + Object.keys(RPC_CU).length);
  });
});

// CHỮ KÝ KHÔNG ĐƯỢC XÊ DỊCH.
//
// `CREATE OR REPLACE` chỉ thay thế khi CHỮ KÝ trùng khít. Lệch một tên tham số
// hay một kiểu là Postgres tạo OVERLOAD chứ không báo lỗi: hàm cũ vẫn phục vụ,
// PostgREST chọn giữa hai bản theo tên đối số, và diff thì nói là đã sửa. Nên
// so sánh với CHÍNH file migration đã ship, không so với trí nhớ.
describe('chin RPC doc cu — tran hang moi, chu ky y nguyen', () => {
  for (const [rpc, meta] of Object.entries(RPC_CU)) {
    it(`${rpc}: chu ky khop nguyen van ban ${meta.nguon}`, () => {
      const goc = docFile(NGUON_CU[meta.nguon]);
      expect(goc, meta.nguon).not.toBe('');
      const cu = chuKy(goc, rpc);
      const moi = chuKy(migration, rpc);
      expect(cu, `${rpc}: khong doc duoc chu ky goc`).not.toBe('');
      expect(moi, `${rpc}: khong duoc phat hanh lai trong migration nay`).not.toBe('');
      expect(moi, `${rpc}: chu ky da xe dich -> CREATE OR REPLACE se de overload`).toBe(cu);
    });

    it(`${rpc}: co tran hang ${meta.tran}`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).not.toBe('');
      expect(body, `${rpc}: thieu ${meta.tran}`).toContain(meta.tran);
    });
  }

  it('khong ham nao trong chin ham bi bo quen', () => {
    expect(Object.keys(RPC_CU)).toHaveLength(9);
  });

  it('tran 2000 la tran chong chay loan, khong phai tran hien thi', () => {
    // Nếu con số này bị hạ về 50 cho vui thì `tim_hoa_don` sẽ in "Tìm thấy 50
    // hoá đơn" cho một công ty có 1.143 hoá đơn, và không có gì trong payload
    // nói rằng con số đó đã bị cắt.
    //
    // Bản trước ghim hai CÂU VĂN trong header (`ceiling is 2000 rows`,
    // `runaway guard, not a display limit`). Một assertion trên chú thích đo
    // sai thứ: xoá lời giải thích thì test đỏ dù trần vẫn đúng, còn hạ trần
    // xuống 50 mà giữ lời giải thích thì test xanh. Ghim CHÍNH con số, trên
    // từng hàm có nó.
    const tran2000 = Object.entries(RPC_CU).filter(([, meta]) => meta.tran === 'LIMIT 2000');
    expect(tran2000.length).toBeGreaterThanOrEqual(7);
    for (const [rpc] of tran2000) {
      expect(functionBody(migration, rpc), rpc).toContain('LIMIT 2000');
    }
    // Và không có hàm nào trong nhóm đó bị hạ xuống trần hiển thị.
    for (const [rpc] of tran2000) {
      expect(functionBody(migration, rpc), rpc).not.toMatch(/LIMIT 50\b/);
    }
  });
});
