// Contract test for the G1-C1 read migration.
//
// The four RPCs below cannot be exercised from vitest (they need a cluster and a
// JWT), so what is checked here is the part that a reviewer forgets first and
// that no type system catches: the authorization preamble, the row cap, the ACL
// and the "runs on an empty database" property of the acceptance block.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260902193151_copilot_read_rpc_contracts_ie_approvals_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

/** Body of one `CREATE OR REPLACE FUNCTION <name>` up to its closing `$fn$;`. */
function functionBody(name: string): string {
  const start = migration.search(
    new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i'),
  );
  if (start < 0) return '';
  const end = migration.indexOf('\n$fn$;', start);
  return end < 0 ? migration.slice(start) : migration.slice(start, end + '\n$fn$;'.length);
}

const RPCS = [
  'copilot_contract_search_v1',
  'copilot_contract_detail_v1',
  'copilot_income_expense_search_v1',
  'copilot_pending_requests_v1',
] as const;

const LIMITED = ['copilot_contract_search_v1', 'copilot_income_expense_search_v1', 'copilot_pending_requests_v1'] as const;

describe('copilot read RPC migration — contracts, vouchers, pending inbox', () => {
  it('exists and is a single lock-bounded transaction', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('declares every RPC SECURITY DEFINER, STABLE and with a pinned search_path', () => {
    for (const rpc of RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).not.toBe('');
      expect(body, rpc).toMatch(/\bSECURITY DEFINER\b/);
      expect(body, rpc).toMatch(/\bSTABLE\b/);
      expect(body, rpc).toMatch(/SET search_path = pg_catalog, public, app_private/);
      expect(body, rpc).toMatch(/LANGUAGE plpgsql/);
      // plpgsql (not sql) matters: a `LANGUAGE sql` body is parsed at CREATE time
      // and would make this migration unrunnable on an empty database.
    }
  });

  it('takes the organization boundary from the server, never from the caller', () => {
    for (const rpc of RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/p_organization_id uuid/);
      expect(body, rpc).toMatch(
        /copilot_org_scope_buildings_v1\('(?:contracts|income_expenses)\.view', p_organization_id\)/,
      );
      expect(body, rpc).toMatch(/auth\.uid\(\)/);
      expect(body, rpc).toMatch(/not_permitted/);
      // No RPC may accept a client-supplied building/cashbook array.
      expect(body, rpc).not.toMatch(/p_building_ids|p_cashbook_ids/);
    }
  });

  it('clamps p_limit to 1..50 and echoes the effective cap', () => {
    for (const rpc of LIMITED) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/least\(greatest\(coalesce\(p_limit, 20\), 1\), 50\)/);
      expect(body, rpc).toMatch(/LIMIT v_limit/);
      expect(body, rpc).toMatch(/'gioi_han', v_limit/);
    }
    // The detail RPC has no p_limit: its invoice list is capped by a literal.
    expect(functionBody('copilot_contract_detail_v1')).toMatch(/LIMIT 5/);
  });

  it('keeps restricted income/expense categories behind their own permission', () => {
    const body = functionBody('copilot_income_expense_search_v1');
    expect(body).toMatch(/can_view_restricted_ie\(\)/);
    expect(body).toMatch(/v_thay_han_che OR NOT COALESCE\(ie\.has_restricted_item, false\)/);
  });

  it('reads the pending inbox instead of deciding anything', () => {
    const body = functionBody('copilot_pending_requests_v1');
    expect(body).toMatch(/FROM public\.list_my_pending_approvals_v1\(\) p/);
    expect(body).toMatch(/WHERE p\.organization_id = p_organization_id/);
    // No write verb may appear anywhere in the migration.
    expect(migration).not.toMatch(/\b(?:INSERT INTO|UPDATE\s+public\.|DELETE FROM)\b/i);
  });

  it('revokes PUBLIC/anon/authenticated then grants only authenticated', () => {
    for (const rpc of RPCS) {
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
    // The folding helper is an internal detail: revoked from everyone, granted
    // to nobody. It is reachable only through the SECURITY DEFINER owners.
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.copilot_fold_text_v1\(text\) FROM authenticated;/,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION app_private\.copilot_fold_text_v1/,
    );
  });

  it('guards role-dependent statements so a bare cluster can replay it', () => {
    expect(migration).toMatch(/IF to_regrole\('anon'\) IS NOT NULL THEN/);
    expect(migration).toMatch(/IF to_regrole\('authenticated'\) IS NOT NULL THEN/);
  });

  it('accepts on the catalog only — no fixture row, no data read', () => {
    const start = migration.indexOf('DO $nghiem_thu$');
    expect(start).toBeGreaterThan(0);
    const block = migration.slice(start);
    expect(block).toMatch(/to_regprocedure/);
    expect(block).toMatch(/has_function_privilege\('anon'/);
    for (const rpc of RPCS) expect(block, rpc).toContain(rpc);
    // A SELECT against a business table here would break the empty-DB property.
    expect(block).not.toMatch(/FROM public\.[a-z_]+/i);
  });

  it('picks the unaccent-aware folding body from the catalog, not from a guess', () => {
    expect(migration).toMatch(/to_regprocedure\('extensions\.unaccent\(text\)'\) IS NOT NULL/);
    expect(migration).toMatch(/CREATE SCHEMA IF NOT EXISTS app_private;/);
  });

  it('is replayable: every DDL statement is CREATE OR REPLACE or IF NOT EXISTS', () => {
    const creates = migration.match(/^\s*CREATE (?!OR REPLACE|SCHEMA IF NOT EXISTS)[A-Z]/gm) ?? [];
    expect(creates).toEqual([]);
  });
});

// GHIM CHÍNH DÒNG CHỊU LỰC, KHÔNG PHẢI DÒNG GỌI HÀM.
//
// Bản đầu của bộ test này chỉ khẳng định `copilot_org_scope_buildings_v1` được
// GỌI. Đó là một khẳng định rỗng về mặt an ninh: xoá `b.id = ANY(v_buildings)`
// khỏi mệnh đề JOIN thì lời gọi vẫn còn nguyên, mọi cửa chặn vẫn xanh, và mọi
// người dùng bị giới hạn theo TOÀ lặng lẽ được nâng lên phạm vi toàn công ty.
// Cái giá của một lỗ như thế không hiện ra dưới dạng lỗi — nó hiện ra dưới dạng
// một câu trả lời "hợp lý" chứa sổ của những toà mà người hỏi không được xem.
//
// Nên ở đây ghim HAI thứ, cho TỪNG thân hàm:
//   1. tập toà do server suy ra phải được GÁN vào biến (`v_buildings := …`) rồi
//      DÙNG trong mệnh đề nối (`= ANY(v_buildings)`);
//   2. mọi alias bảng có cột `organization_id` phải mang bộ lọc công ty của
//      chính nó — liệt kê ĐÍCH DANH, vì một danh sách suy ra từ chính file đang
//      kiểm sẽ teo đi cùng file đó.
describe('bien gioi thue bao — predicate chiu luc bi ghim tung dong', () => {
  /** Alias có `organization_id` trong từng thân hàm, liệt kê tay. */
  const ORG_ALIASES: Record<string, string[]> = {
    copilot_contract_search_v1: ['ct', 'rm', 'b', 'cc', 'cst', 'cc2', 'cst2'],
    copilot_contract_detail_v1: ['ct', 'rm', 'b', 'cc', 'cst', 'i'],
    copilot_income_expense_search_v1: ['ie', 'b', 'acc', 't'],
  };

  /** Ba hàm trả DANH SÁCH — cả ba ràng kết quả vào tập toà của server. */
  const SCOPED_BY_BUILDING = [
    'copilot_contract_search_v1',
    'copilot_contract_detail_v1',
    'copilot_income_expense_search_v1',
  ] as const;

  for (const rpc of SCOPED_BY_BUILDING) {
    it(`${rpc}: gan tap toa server roi RANG ket qua vao no`, () => {
      const body = functionBody(rpc);
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

    it(`${rpc}: moi alias co organization_id deu mang bo loc cong ty`, () => {
      const body = functionBody(rpc);
      for (const alias of ORG_ALIASES[rpc]) {
        expect(body, `${rpc}: alias "${alias}" thieu organization_id = p_organization_id`).toMatch(
          new RegExp(String.raw`\b${alias}\.organization_id\s*=\s*p_organization_id\b`),
        );
      }
    });
  }

  it('income_expense_items KHONG loc cong ty — va do la co y, khong phai bo sot', () => {
    // `it` chỉ tới được qua `it.income_expense_id = ie.id`, mà `ie` đã bị ràng
    // vào công ty VÀ vào tập toà. Thêm một bộ lọc nữa ở đây không đóng cửa nào.
    // Ghim lại để lần sau ai đọc danh sách alias phía trên không tưởng là quên.
    const body = functionBody('copilot_income_expense_search_v1');
    expect(body).toMatch(/it\.income_expense_id\s*=\s*ie\.id/);
    expect(body).not.toMatch(/\bit\.organization_id\b/);
  });

  it('copilot_pending_requests_v1: khong co tap toa, nen phai loc bang chinh cot cong ty', () => {
    // Hàm này đọc `list_my_pending_approvals_v1()` — đã lọc theo auth.uid() — nên
    // nó không có toà để ràng. Hai thứ thay thế: khẳng định biên giới bằng
    // PERFORM, và lọc công ty ngay trên hàng trả về.
    const body = functionBody('copilot_pending_requests_v1');
    expect(body).toMatch(/PERFORM public\.copilot_org_scope_buildings_v1\('income_expenses\.view', p_organization_id\)/);
    expect(body).toMatch(/\bp\.organization_id\s*=\s*p_organization_id\b/);
    expect(body).not.toMatch(/ANY\(v_buildings\)/);
  });

  it('dem du 3 lan xuat hien cua predicate — them mot ham doc moi phai them mot dong', () => {
    // Sàn chống bỏ quên theo chiều ngược: nếu một hàm đọc thứ tư ra đời và quên
    // ràng vào v_buildings, con số này không tăng và test đỏ.
    const lan = migration.match(/b\.id\s*=\s*ANY\(v_buildings\)/g) ?? [];
    expect(lan).toHaveLength(SCOPED_BY_BUILDING.length);
  });
});
