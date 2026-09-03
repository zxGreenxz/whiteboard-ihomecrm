// Contract test for the G1-C4 migration: the four SENSITIVE read RPCs.
//
// The four functions cannot be exercised from vitest (they need a cluster and a
// JWT), so what is checked here is the part a reviewer forgets first and no type
// system catches: the authorization preamble, the row cap, the ACL, and — one
// assertion per function body — the load-bearing predicate itself.
//
// These four are the ones where getting it wrong is worst. A missing predicate in
// a vacancy report shows someone an extra empty room; a missing predicate here
// shows them a colleague's take-home pay, an owner's profit share, a tenant's
// private chat, or the state of another company's routers. None of those raise an
// error. All of them look like a perfectly plausible answer.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { boCommentSql, docSql } from './helpers/sqlTestUtils';

const migrationPath = 'supabase/migrations/20260902224859_copilot_read_rpc_sensitive_v1.sql';

/**
 * MỌI assertion nội dung chạy trên bản ĐÃ LỘT BÌNH LUẬN.
 *
 * Bản trước chỉ lột comment cho hai assertion (`CURRENT_DATE`, "no write RPC");
 * phần còn lại — kể cả các predicate quyết định một cổ đông có thấy phần của
 * đồng sở hữu hay không — chạy trên văn bản thô. Bài kiểm đột biến ở
 * `sqlTestUtils.test.ts`.
 */
const migration = boCommentSql(docSql(migrationPath));

/**
 * Body of one `CREATE OR REPLACE FUNCTION public.<name>` up to the next function
 * declaration or the ACL block.
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

const RPC_MOI = [
  'copilot_salary_summary_v1',
  'copilot_shareholder_profit_v1',
  'copilot_zalo_conversations_v1',
  'copilot_network_status_v1',
] as const;

/**
 * Permission key each RPC resolves its scope with — the SAME key the screen is
 * guarded by. Reading payroll or a private chat through Copilot under a wider and
 * more easily granted permission would be a back door around the screen's gate.
 */
const KHOA_QUYEN: Record<string, string> = {
  copilot_salary_summary_v1: 'salary.view',
  copilot_shareholder_profit_v1: 'shareholder_profit.view',
  copilot_zalo_conversations_v1: 'chat_zalo.view',
  copilot_network_status_v1: 'network_center.view',
};

/**
 * The three whose rows reach a building, so `b.id = ANY(v_buildings)` is a real
 * predicate on a real column.
 *
 * `copilot_salary_summary_v1` is NOT here and that is the point: `salary_monthly`
 * has no `building_id` column at all (20260628000001), so its boundary is the
 * company column plus `org_wide`, and it is pinned separately below.
 */
const CO_PHAM_VI_TOA = [
  'copilot_shareholder_profit_v1',
  'copilot_zalo_conversations_v1',
  'copilot_network_status_v1',
] as const;

/** Aliases carrying `organization_id` inside each body, listed by hand. */
const ORG_ALIASES: Record<string, string[]> = {
  // `pr` (profiles) is deliberately absent — see the comment on that join.
  copilot_salary_summary_v1: ['sm'],
  copilot_shareholder_profit_v1: ['pm', 'b', 'pa', 'sh', 'pa0', 'pma0', 'pa1', 'pma1'],
  copilot_zalo_conversations_v1: ['c', 'rm', 'b'],
  copilot_network_status_v1: ['b', 'rt', 'cur', 'ni', 'ni2', 'nc'],
};

/**
 * Every Network Center RPC that CHANGES something. None may appear anywhere in
 * this migration: a read tool that can reach one of them is not a read tool.
 */
const RPC_GHI_MANG = [
  'network_center_execute_action_v1',
  'network_center_ack_incident_v1',
  'network_center_create_maintenance_v1',
  'network_center_cancel_maintenance_v1',
  'network_center_request_snapshot_v1',
  'network_center_update_settings_v1',
];

/** Every Zalo RPC that SENDS something. Same rule, same reason. */
const RPC_GUI_ZALO = ['zalo_send', 'zalo_broadcast', 'zalo_recall', 'zalo_queue_send'];

describe('copilot sensitive RPC migration — luong, co dong, zalo, network', () => {
  it('exists and is a single lock-bounded transaction', () => {
    expect(migration).not.toBe('');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '15s';/);
  });

  it('declares every RPC SECURITY DEFINER, STABLE and with a pinned search_path', () => {
    for (const rpc of RPC_MOI) {
      const body = functionBody(migration, rpc);
      expect(body, rpc).not.toBe('');
      expect(body, rpc).toMatch(/\bSECURITY DEFINER\b/);
      expect(body, rpc).toMatch(/\bSTABLE\b/);
      expect(body, rpc).toMatch(/SET search_path = pg_catalog, public, app_private/);
      // plpgsql (not sql): a `LANGUAGE sql` body is parsed at CREATE time and
      // would make this migration unrunnable on an empty database.
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
      // No RPC may accept a client-supplied building/cashbook ARRAY. A single
      // `p_building_id` is fine — it is checked against the server scope below.
      expect(body, rpc).not.toMatch(/p_building_ids|p_cashbook_ids/);
      // Nor may any of them accept an identity to answer "on behalf of": the tool
      // contract is "you, in the company you selected", and a second subject filled
      // in by a model is exactly what that contract exists to refuse.
      expect(body, rpc).not.toMatch(/p_user_id|p_staff_id|p_manager_id|p_shareholder_id/);
    }
  });

  it('uses the SAME permission key the screen is guarded by', () => {
    // Cross-check against the permission catalog itself, so a renamed permission
    // cannot drift here unnoticed.
    const catalog = readFileSync('src/lib/permissionPages.ts', 'utf8');
    for (const key of Object.values(KHOA_QUYEN)) {
      const [module, action] = key.split('.');
      expect(catalog, key).toContain(`f("${module}", "${action}"`);
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

  it('aggregates every total over the whole match set, not over the capped list', () => {
    // The capped list lives in a scalar sub-select with `LIMIT v_limit`; the totals
    // come from the OUTER aggregate over the un-capped CTE. A total taken from a
    // truncated list is a wrong number with nothing in the payload to say so.
    for (const rpc of RPC_MOI) {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/'tong_hop',/);
      expect(body, rpc).toMatch(/INTO v_tong_hop/);
    }
    expect(functionBody(migration, 'copilot_salary_summary_v1')).toMatch(
      /'tong_thuc_nhan', COALESCE\(sum\(l\.take_home\), 0\)/,
    );
    expect(functionBody(migration, 'copilot_network_status_v1')).toMatch(
      /'tong_su_co_mo', COALESCE\(sum\(m\.open_incidents\), 0\)/,
    );
  });

  it('rejects a period that is not YYYY-MM instead of pasting it into a filter', () => {
    for (const rpc of ['copilot_salary_summary_v1', 'copilot_shareholder_profit_v1']) {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/p_ky !~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}\$'/);
      expect(body, rpc).toMatch(/invalid_period/);
    }
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

  it('writes NOTHING except the three rollout flag rows', () => {
    // Một lát đọc không được ghi gì vào dữ liệu nghiệp vụ. Ngoại lệ duy nhất là
    // ba dòng công tắc rollout: `set_copilot_feature_flag_v2` chỉ UPDATE dòng CÓ
    // SẴN, nên công tắc phải tồn tại trước thì mới có chuyện bật hay không bật.
    const ghi = migration.match(/\b(?:INSERT INTO|UPDATE\s+public\.|DELETE FROM)\s+[a-z_.]*/gi) ?? [];
    expect(ghi).toEqual(['INSERT INTO public.copilot_feature_flags']);
  });

  it('seed cờ đi đúng cửa transition v2, DO NOTHING, và mọi dòng `disabled`', () => {
    // Trigger `copilot_feature_flags_bump_revision` (20260829030000) RAISE 42501
    // nếu thiếu dấu transaction này — thiếu nó thì migration chết ngay dòng
    // INSERT. DO UPDATE thay vì DO NOTHING là khác biệt giữa "thêm công tắc" và
    // "tắt hết công tắc của người khác".
    const iGuc = migration.search(
      /set_config\(\s*'app\.copilot_feature_flag_transition'\s*,\s*'v2'\s*,\s*true\s*\)/i,
    );
    const iInsert = migration.search(/INSERT\s+INTO\s+public\.copilot_feature_flags/i);
    const iTra = migration.search(
      /set_config\(\s*'app\.copilot_feature_flag_transition'\s*,\s*''\s*,\s*true\s*\)/i,
    );
    expect(iGuc).toBeGreaterThanOrEqual(0);
    expect(iInsert).toBeGreaterThan(iGuc);
    expect(iTra).toBeGreaterThan(iInsert);
    expect(migration).toMatch(/ON\s+CONFLICT\s*\(\s*scope\s*,\s*contract_id\s*\)\s*DO\s+NOTHING/i);
    expect(migration).not.toMatch(/DO\s+UPDATE/i);
    const seed = [...migration.matchAll(/\('page',\s*'([^']+)'\s*,\s*'(\w+)'\)/g)];
    expect(seed.map((m) => m[1])).toEqual([
      'copilot.sensitive.salary',
      'copilot.sensitive.shareholder-profit',
      'copilot.sensitive.network',
    ]);
    // Bật rollout là quyết định vận hành có CAS + lý do + bằng chứng trong sổ
    // audit. Bật bằng migration là bật không tên.
    for (const dong of seed) expect(dong[2], dong[1]).toBe('disabled');
  });

  it('cannot reach a Network Center action or a Zalo send, by name', () => {
    // The four domains here are the ones with a write twin one identifier away.
    // Naming the twins is the cheapest way to make "read only" a checked fact
    // instead of a claim in a header comment.
    const sql = boCommentSql(migration);
    for (const name of RPC_GHI_MANG) expect(sql, name).not.toContain(name);
    for (const name of RPC_GUI_ZALO) expect(sql, name).not.toContain(name);
  });

  it('accepts on the catalog only — no fixture row, no data read', () => {
    const start = migration.indexOf('DO $nghiem_thu$');
    expect(start).toBeGreaterThan(0);
    const block = migration.slice(start);
    expect(block).toMatch(/to_regprocedure/);
    expect(block).toMatch(/has_function_privilege\('anon'/);
    // And that each one is STABLE in the CATALOG, not just in the source text: a
    // function re-created VOLATILE later would still match the source assertion.
    expect(block).toMatch(/p\.provolatile = 's'/);
    for (const rpc of RPC_MOI) expect(block, rpc).toContain(rpc);
    // A SELECT against a BUSINESS table here would break the empty-DB property.
    // The flag table is the one exception and it is named explicitly: it is
    // created by 20260828170000 in the same forward lane, and it is what this
    // migration just seeded (same property 20260902185838 relies on).
    const bang = [...block.matchAll(/FROM public\.([a-z_]+)/gi)].map((m) => m[1]);
    expect(new Set(bang)).toEqual(new Set(['copilot_feature_flags']));
  });

  it('is replayable: every DDL statement is CREATE OR REPLACE', () => {
    const creates = migration.match(/^\s*CREATE (?!OR REPLACE)[A-Z]/gm) ?? [];
    expect(creates).toEqual([]);
  });

  it('reuses the shared helpers instead of deciding their bodies a second time', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION app_private\./);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.copilot_org_scope_buildings_v1/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.org_today_v1/);
  });

  it('dem du 4 ham — them mot ham moi phai them mot dong o day', () => {
    const lan = migration.match(/CREATE OR REPLACE FUNCTION public\.copilot_/g) ?? [];
    expect(lan).toHaveLength(RPC_MOI.length);
  });
});

// GHIM CHÍNH DÒNG CHỊU LỰC, KHÔNG PHẢI DÒNG GỌI HÀM.
//
// Xoá `b.id = ANY(v_buildings)` khỏi mệnh đề JOIN thì lời gọi scope vẫn còn
// nguyên, mọi cửa chặn vẫn xanh, và mọi người dùng bị giới hạn theo TOÀ lặng lẽ
// được nâng lên phạm vi toàn công ty.
describe('bien gioi thue bao — predicate chiu luc bi ghim tung ham', () => {
  for (const rpc of CO_PHAM_VI_TOA) {
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

  it('copilot_network_status_v1: toa ngoai pham vi tra loi nhu bao cao rong', () => {
    const body = functionBody(migration, 'copilot_network_status_v1');
    expect(body).toMatch(
      /IF p_building_id IS NOT NULL AND NOT \(p_building_id = ANY\(v_buildings\)\) THEN/,
    );
    expect(body).toMatch(/v_buildings := ARRAY\[\]::uuid\[\];/);
  });

  it('copilot_network_status_v1: KHONG doc org_wide — quyen nay luon tra false', () => {
    // `network_center.view` khai `required_dimensions = {BUILDING}`, và
    // `authorized_scope_v3` trả `org_wide = false` cho MỌI quyền khai như thế
    // (nhánh `when r.needs_building ... then false`). Gác hàm này bằng `org_wide`
    // sẽ từ chối tất cả mọi người, mọi lúc — một lỗi fail-closed nên sẽ được báo
    // là "Trung tâm mạng hỏng", không phải là một lỗ hổng, và vì thế sẽ được
    // "chữa" bằng cách nới phạm vi.
    //
    // Bỏ chú thích trước khi kiểm: chính chú thích trong thân hàm giải thích luật
    // này, nên một khẳng định trên văn bản thô sẽ được "thoả mãn" bằng cách xoá
    // lời giải thích đi.
    const body = boCommentSql(functionBody(migration, 'copilot_network_status_v1'));
    expect(body).not.toMatch(/org_wide/);
  });
});


// CỔ ĐÔNG CHỈ THẤY PHẦN CỦA MÌNH — TRỪ KHI HỌ LÀ NGƯỜI CHỐT SỔ.
//
// `20260713110400` (đã apply) cấp `shareholder_profit.view` ALLOW cho MỌI thành
// viên đang hoạt động là `shareholders.auth_user_id` hoặc
// `profit_managers.auth_user_id` — 4 thành viên như vậy trên production ngày
// 02/09/2026. Khoá đó chỉ cấp được ở mức ORGANIZATION nên `authorized_scope_v3`
// trả `org_wide = true`, và trên MÀN HÌNH điều đó vô hại vì RLS thu hẹp lại
// (`profit_alloc_self_select`, `profit_monthly_self_select`,
// `profit_monthly_self_manager`, `pma_self_select`). Hàm này SECURITY DEFINER
// nên KHÔNG có policy nào chạy: thiếu nhánh dưới đây, một cổ đông hỏi Copilot sẽ
// nhận TÊN và SỐ TIỀN của mọi cổ đông khác — rộng hơn hẳn màn hình của chính họ.
describe('loi nhuan co dong — khong phai quan ly thi CHI thay phan cua minh', () => {
  const body = () => functionBody(migration, 'copilot_shareholder_profit_v1');

  it('phan biet quan ly bang khoa mà override KHONG cap', () => {
    // `shareholder_profit.view` là thứ override cấp, nên nó KHÔNG phân biệt được
    // ai là ai. `.lock` và `.manage_shareholders` thì có: không migration nào cấp
    // chúng cho cổ đông.
    expect(body()).toMatch(
      /authorized_scope_v3\('shareholder_profit\.lock', p_organization_id\)/,
    );
    expect(body()).toMatch(
      /authorized_scope_v3\('shareholder_profit\.manage_shareholders', p_organization_id\)/,
    );
    expect(body()).toMatch(/v_quan_ly := COALESCE\(v_quan_ly, false\);/);
  });

  it('lay "chinh minh" bang DUNG hai ham ma RLS dung', () => {
    expect(body()).toMatch(/v_co_dong_id := public\.current_shareholder_id\(\);/);
    expect(body()).toMatch(/v_quan_ly_ln_id := public\.current_profit_manager_id\(\);/);
  });

  it('danh sach phan chia bi rang vao co dong cua chinh actor', () => {
    // ĐÂY là dòng quyết định một cổ đông có thấy phần của đồng sở hữu hay không.
    expect(body(), 'thieu rang buoc pa.shareholder_id = v_co_dong_id').toMatch(
      /AND \(v_quan_ly OR pa\.shareholder_id = v_co_dong_id\)/,
    );
  });

  it('thang cung bi rang — soi ca hai duong cua RLS', () => {
    // `profit_monthly_self_select` (cổ đông) VÀ `profit_monthly_self_manager`
    // (quản lý hưởng lợi nhuận). Thiếu vế thứ hai thì một profit manager không
    // phải cổ đông sẽ nhận rỗng ở nơi màn hình cho họ xem.
    const than = body();
    expect(than).toMatch(/pa1\.shareholder_id = v_co_dong_id/);
    expect(than).toMatch(/pma1\.manager_id = v_quan_ly_ln_id/);
    // Hai CTE `ky` phải mang CÙNG một ràng buộc, không được lệch nhau.
    expect((than.match(/pa1\.shareholder_id = v_co_dong_id/g) ?? [])).toHaveLength(2);
    expect((than.match(/pma1\.manager_id = v_quan_ly_ln_id/g) ?? [])).toHaveLength(2);
    // Và kỳ MẶC ĐỊNH cũng đi qua bộ lọc đó — nếu không, kỳ mới nhất của người
    // khác quyết định cổ đông được xem tháng nào.
    expect(than).toMatch(/pa0\.shareholder_id = v_co_dong_id/);
    expect(than).toMatch(/pma0\.manager_id = v_quan_ly_ln_id/);
  });

  it('noi ro pham vi trong chinh cau tra loi', () => {
    expect(body()).toMatch(
      /'pham_vi', CASE WHEN v_quan_ly THEN 'toan_cong_ty' ELSE 'chi_minh_toi' END/,
    );
  });

  it('nghiem thu doi hai ham danh tinh cua RLS ton tai truoc khi tin ket qua', () => {
    const block = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(block).toContain('public.current_shareholder_id()');
    expect(block).toContain('public.current_profit_manager_id()');
  });
});

// LƯƠNG: KHÔNG CÓ CỘT TOÀ, NÊN BIÊN GIỚI LÀ CÔNG TY + `org_wide` + DÒNG CỦA MÌNH.
describe('bang luong — org_wide thi ca cong ty, khong thi CHI dong cua minh', () => {
  const body = () => functionBody(migration, 'copilot_salary_summary_v1');

  it('van goi scope helper de kiem to chuc/thanh vien/quyen', () => {
    // `PERFORM`, không phải gán: `salary_monthly` không có `building_id` nên giữ
    // một mảng toà mà không ai đọc sẽ đọc như một hàng rào không tồn tại. Giá trị
    // của lời gọi này là các exception nó ném ra.
    expect(body()).toMatch(
      /PERFORM public\.copilot_org_scope_buildings_v1\('salary\.view', p_organization_id\);/,
    );
    expect(body()).not.toMatch(/ANY\(v_buildings\)/);
  });

  it('lay org_wide tu authorized_scope_v3 va mac dinh la false', () => {
    expect(body()).toMatch(
      /SELECT s\.org_wide INTO v_org_wide\s*\n\s*FROM app_private\.authorized_scope_v3\('salary\.view', p_organization_id\) s;/,
    );
    expect(body()).toMatch(/v_org_wide := COALESCE\(v_org_wide, false\);/);
  });

  it('dong cua chinh minh khoa theo staff_id, KHONG PHAI user_id', () => {
    // `user_id` là CHỦ SỞ HỮU dòng (người lập bảng lương), `staff_id` là người
    // được trả lương — xem DDL 20260628000001 và cặp policy `sm_owner_all` /
    // `sm_self_select` ngay cạnh. Viết nhầm sang `user_id` thì một người chủ khớp
    // MỌI dòng họ lập ra (đúng cái rò rỉ nhánh này sinh ra để chặn) còn nhân viên
    // không khớp dòng nào của chính mình.
    expect(body()).toMatch(/AND \(v_org_wide OR sm\.staff_id = v_actor\)/);
    expect(body()).not.toMatch(/sm\.user_id\s*=\s*v_actor/);
    expect(body()).not.toMatch(/sm\.user_id\s*=\s*auth\.uid\(\)/);
  });

  it('noi ro pham vi trong chinh cau tra loi', () => {
    // Không có trường này thì một dòng lương của riêng người hỏi trông y hệt
    // "bảng lương cả công ty chỉ có một người".
    expect(body()).toMatch(
      /'pham_vi', CASE WHEN v_org_wide THEN 'toan_cong_ty' ELSE 'chi_minh_toi' END/,
    );
  });

  it('ky mac dinh cung phai di qua bo loc pham vi', () => {
    // Câu `max(period_month)` để chọn kỳ mặc định là một truy vấn THẬT vào bảng
    // lương. Thiếu bộ lọc ở đó thì kỳ mặc định của một người chỉ được xem dòng
    // của mình lại được suy từ kỳ mới nhất của NGƯỜI KHÁC — rò một bit, nhưng là
    // một bit về việc công ty đã chốt lương tháng nào.
    const doan = body().slice(body().indexOf('SELECT max(sm.period_month)'));
    expect(doan).toMatch(/sm\.organization_id = p_organization_id/);
    expect(doan).toMatch(/\(v_org_wide OR sm\.staff_id = v_actor\)/);
  });
});

// ZALO: HỘI THOẠI KHÔNG GẮN PHÒNG CHỈ LỌT KHI QUYỀN LÀ TOÀN CÔNG TY.
describe('hoi thoai zalo — ranh gioi va pham vi tim kiem', () => {
  const body = () => functionBody(migration, 'copilot_zalo_conversations_v1');

  it('soi CHINH cot nguon, khong soi ket qua LEFT JOIN', () => {
    // LEFT JOIN một mình là một cái cửa mở: hàng có `room_id` NGOÀI phạm vi cũng
    // cho `b.id IS NULL`, y hệt hàng chưa gắn phòng.
    expect(body()).toMatch(/\(b\.id IS NOT NULL OR \(c\.room_id IS NULL AND v_org_wide\)\)/);
    expect(body()).toMatch(
      /authorized_scope_v3\('chat_zalo\.view', p_organization_id\)/,
    );
  });

  it('tim theo NGUOI, khong tim trong noi dung tin nhan', () => {
    // Cho `p_query` chạm `last_message_text` là biến danh sách hội thoại thành
    // công cụ tìm toàn văn trong tin nhắn riêng tư — một sản phẩm khác, với một
    // câu chuyện đồng ý khác.
    const dieuKien = body().slice(body().indexOf('v_needle IS NULL'));
    expect(dieuKien).toMatch(/copilot_fold_text_v1\(COALESCE\(c\.peer_name, ''\)\) LIKE v_needle/);
    expect(dieuKien).toMatch(/copilot_fold_text_v1\(COALESCE\(c\.peer_phone, ''\)\) LIKE v_needle/);
    const truocOrderBy = dieuKien.slice(0, dieuKien.indexOf('jsonb_build_object'));
    expect(truocOrderBy).not.toMatch(/last_message_text.*LIKE v_needle/);
  });

  it('cat tin cuoi ngay tai server', () => {
    expect(body()).toMatch(/left\(COALESCE\(s\.last_message_text, ''\), 160\)/);
  });
});

// HÔM NAY LÀ HÔM NAY CỦA CÔNG TY.
describe('moc thoi gian — org_today_v1, khong phai CURRENT_DATE', () => {
  it('khong con mot CURRENT_DATE tran nao trong ma', () => {
    expect(boCommentSql(migration)).not.toMatch(/CURRENT_DATE/i);
  });

  for (const rpc of ['copilot_salary_summary_v1', 'copilot_shareholder_profit_v1']) {
    it(`${rpc}: ky mac dinh lay hom nay tu org_today_v1(p_organization_id)`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/v_today := public\.org_today_v1\(p_organization_id\);/);
      expect(body, rpc).toMatch(/date_trunc\('month', v_today\)::date/);
    });
  }

  it('nghiem thu doi du ham nen truoc khi tin ket qua', () => {
    const block = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(block).toContain('public.copilot_org_scope_buildings_v1(text, uuid)');
    expect(block).toContain('app_private.authorized_scope_v3(text, uuid)');
    expect(block).toContain('app_private.copilot_fold_text_v1(text)');
    expect(block).toContain('public.org_today_v1(uuid)');
  });
});
