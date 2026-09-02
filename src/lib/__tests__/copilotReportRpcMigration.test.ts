// Contract test for the G1-C3 report migration.
//
// The ten functions below cannot be exercised from vitest (they need a cluster
// and a JWT), so what is checked here is the part a reviewer forgets first and
// no type system catches: the authorization preamble, the row cap, the ACL, and
// — one assertion per function body — the load-bearing tenant predicate itself.
//
// A test that only proves `copilot_org_scope_buildings_v1(...)` is CALLED proves
// nothing: delete `b.id = ANY(v_buildings)` from a JOIN and the call is still
// there, every gate is still green, and every building-scoped reader silently
// gets the whole company's books. That failure never shows up as an error — it
// shows up as a plausible answer containing other people's money.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260902213111_copilot_report_rpc_v1.sql';
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n')
  : '';

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

/**
 * SQL with `--` line comments removed.
 *
 * Needed by the `CURRENT_DATE` assertion below: the migration header EXPLAINS why
 * bare `CURRENT_DATE` is banned, and an assertion that greps the raw file would
 * be satisfied only by deleting the explanation. Strip comments, then the rule
 * is about the code it is a rule about.
 */
function boCommentSql(source: string): string {
  return source.replace(/--[^\n]*/g, '');
}

const RPC_MOI = [
  'copilot_report_vacant_rooms_v1',
  'copilot_report_renewals_v1',
  'copilot_report_terminations_v1',
  'copilot_report_new_leases_v1',
  'copilot_report_expense_ratio_v1',
  'copilot_report_daily_cashbook_v1',
  'copilot_report_cash_flow_v1',
  'copilot_report_payment_schedule_v1',
  'copilot_report_overpayment_v1',
  'copilot_report_deposits_v1',
] as const;

/**
 * Permission key each RPC resolves its scope with — the SAME key the report
 * route is guarded by. Reading a report through Copilot under a wider and more
 * easily granted permission would be a back door around the screen's own gate.
 */
const KHOA_QUYEN: Record<string, string> = {
  copilot_report_vacant_rooms_v1: 'reports_real_estate.vacant_rooms',
  copilot_report_renewals_v1: 'reports_real_estate.renewals_transfers',
  copilot_report_terminations_v1: 'reports_real_estate.terminations',
  copilot_report_new_leases_v1: 'reports_real_estate.new_leases',
  copilot_report_expense_ratio_v1: 'reports_real_estate.expense_ratio',
  copilot_report_daily_cashbook_v1: 'reports_finance.daily_cashbook',
  copilot_report_cash_flow_v1: 'reports_finance.cash_flow',
  copilot_report_payment_schedule_v1: 'reports_finance.payment_schedule',
  copilot_report_overpayment_v1: 'reports_finance.overpayment',
  copilot_report_deposits_v1: 'reports_finance.deposits_report',
};

/** Aliases carrying `organization_id` inside each body, listed by hand. */
const ORG_ALIASES: Record<string, string[]> = {
  copilot_report_vacant_rooms_v1: ['rm', 'b', 'ct', 'ct2'],
  copilot_report_renewals_v1: ['ex', 'ct', 'rm', 'b', 'cc', 'cst'],
  copilot_report_terminations_v1: ['ct', 'rm', 'b', 't', 'cc', 'cst'],
  copilot_report_new_leases_v1: ['ct', 'rm', 'b', 'cc', 'cst'],
  copilot_report_expense_ratio_v1: ['ie', 'b', 'it', 't'],
  // Posting truth: the tenant column lives on the LINE (`pl`); the posting `p`
  // is bound to the line's own organization, and the voucher `ie` is joined per
  // organization for the building and the restricted flag.
  copilot_report_daily_cashbook_v1: ['pl', 'ie', 'b'],
  copilot_report_cash_flow_v1: ['pl', 'ie', 'b'],
  copilot_report_payment_schedule_v1: ['i', 'b', 'rm', 'cc', 'cst'],
  copilot_report_overpayment_v1: ['i', 'b', 'rm', 'cc', 'cst'],
  copilot_report_deposits_v1: ['d', 'rm', 'b', 'tn'],
};

/** The three money rollups that read `income_expenses`. */
const CO_HAN_CHE = [
  'copilot_report_expense_ratio_v1',
  'copilot_report_daily_cashbook_v1',
  'copilot_report_cash_flow_v1',
] as const;

/** The four whose optional `p_building_id` must be checked against the scope. */
const CO_LOC_TOA = [
  'copilot_report_vacant_rooms_v1',
  'copilot_report_expense_ratio_v1',
  'copilot_report_daily_cashbook_v1',
  'copilot_report_cash_flow_v1',
] as const;

describe('copilot report RPC migration — 5 bao cao BDS + 5 bao cao tai chinh', () => {
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
    }
  });

  it('uses the SAME permission key the report route is guarded by', () => {
    // Cross-check against the route table itself, so a renamed permission cannot
    // drift here unnoticed. `reports_real_estate.vacant_rooms` in this migration
    // and `action="vacant_rooms"` on the route are the same fact.
    const routes =
      readFileSync('src/app/routes/realEstateReportRoutes.tsx', 'utf8') +
      readFileSync('src/app/routes/financeReportRoutes.tsx', 'utf8');
    for (const key of Object.values(KHOA_QUYEN)) {
      const [module, action] = key.split('.');
      expect(routes, key).toContain(`module="${module}" action="${action}"`);
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
    // The capped list lives in a scalar sub-select with `LIMIT v_limit`; the
    // totals are computed by the OUTER aggregate over the un-capped CTE. A total
    // taken from a truncated list is a wrong number with nothing in the payload
    // to say so.
    for (const rpc of RPC_MOI) {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/'tong_hop',/);
      expect(body, rpc).toMatch(/INTO v_tong_hop/);
    }
    expect(functionBody(migration, 'copilot_report_payment_schedule_v1')).toMatch(
      /count\(\*\) FILTER \(WHERE l\.due_date < v_today\)/,
    );
    expect(functionBody(migration, 'copilot_report_vacant_rooms_v1')).toMatch(
      /'tien_thue_bo_lo', COALESCE\(sum\(t\.rent_price\), 0\)/,
    );
  });

  it('validates the date window instead of pasting it into a filter', () => {
    for (const rpc of [
      'copilot_report_renewals_v1',
      'copilot_report_terminations_v1',
      'copilot_report_new_leases_v1',
      'copilot_report_expense_ratio_v1',
      'copilot_report_daily_cashbook_v1',
      'copilot_report_cash_flow_v1',
    ]) {
      expect(functionBody(migration, rpc), rpc).toMatch(/invalid_date_window/);
    }
    // The two cash rollups REQUIRE a window: an unbounded scan of every voucher
    // ever posted is not a report, it is an accident waiting for a big tenant.
    for (const rpc of ['copilot_report_daily_cashbook_v1', 'copilot_report_cash_flow_v1']) {
      expect(functionBody(migration, rpc), rpc).toMatch(
        /IF p_tu IS NULL OR p_den IS NULL OR p_tu > p_den THEN/,
      );
    }
  });

  it('rejects a deposit status that is not in the enum', () => {
    const body = functionBody(migration, 'copilot_report_deposits_v1');
    expect(body).toMatch(/'PENDING', 'CONFIRMED', 'CONVERTED', 'REFUNDED', 'FORFEITED'/);
    expect(body).toMatch(/invalid_deposit_status/);
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
    for (const rpc of RPC_MOI) expect(block, rpc).toContain(rpc);
    // A SELECT against a business table here would break the empty-DB property.
    expect(block).not.toMatch(/FROM public\.[a-z_]+/i);
  });

  it('is replayable: every DDL statement is CREATE OR REPLACE', () => {
    const creates = migration.match(/^\s*CREATE (?!OR REPLACE)[A-Z]/gm) ?? [];
    expect(creates).toEqual([]);
  });

  it('reuses the shared helpers instead of deciding their bodies a second time', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION app_private\./);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.copilot_org_scope_buildings_v1/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.can_view_restricted_ie/);
  });
});

// GHIM CHÍNH DÒNG CHỊU LỰC, KHÔNG PHẢI DÒNG GỌI HÀM.
//
// Xoá `b.id = ANY(v_buildings)` khỏi mệnh đề JOIN thì lời gọi scope vẫn còn
// nguyên, mọi cửa chặn vẫn xanh, và mọi người dùng bị giới hạn theo TOÀ lặng lẽ
// được nâng lên phạm vi toàn công ty.
describe('bien gioi thue bao — predicate chiu luc bi ghim tung ham', () => {
  for (const rpc of RPC_MOI) {
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

    it(`${rpc}: moi alias co organization_id deu mang bo loc cong ty`, () => {
      const body = functionBody(migration, rpc);
      for (const alias of ORG_ALIASES[rpc]) {
        expect(body, `${rpc}: alias "${alias}" thieu organization_id = p_organization_id`).toMatch(
          new RegExp(String.raw`\b${alias}\.organization_id\s*=\s*p_organization_id\b`),
        );
      }
    });
  }

  for (const rpc of CO_LOC_TOA) {
    it(`${rpc}: toa ngoai pham vi tra loi nhu bao cao rong, khong phai "co nhung khong cho xem"`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(
        /IF p_building_id IS NOT NULL AND NOT \(p_building_id = ANY\(v_buildings\)\) THEN/,
      );
      expect(body, rpc).toMatch(/v_buildings := ARRAY\[\]::uuid\[\];/);
    });
  }

  for (const rpc of CO_HAN_CHE) {
    it(`${rpc}: hang muc han che bi loai VA duoc dem, khong bi bo im lang`, () => {
      // Loại lặng lẽ biến một tổng thiếu thành một tổng trông như đủ. Đếm rồi
      // trả kèm là cách duy nhất để câu trả lời nói được "số này chưa đủ".
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/v_thay_han_che := public\.can_view_restricted_ie\(\);/);
      expect(body, rpc).toMatch(/has_restricted_item/);
      expect(body, rpc).toMatch(/v_thay_han_che OR NOT/);
      expect(body, rpc).toMatch(/'phieu_han_che_bi_loai',/);
    });
  }

  it('copilot_report_deposits_v1: coc chua gan phong chi lot khi quyen la toan cong ty', () => {
    // LEFT JOIN một mình là một cái cửa mở: hàng có `room_id` NGOÀI phạm vi cũng
    // cho `b.id IS NULL`, y hệt hàng chưa gắn phòng. Điều kiện phải soi CHÍNH
    // cột nguồn (`d.room_id IS NULL`) chứ không phải kết quả nối.
    const body = functionBody(migration, 'copilot_report_deposits_v1');
    expect(body).toMatch(/\(b\.id IS NOT NULL OR \(d\.room_id IS NULL AND v_org_wide\)\)/);
    expect(body).toMatch(/authorized_scope_v3\('reports_finance\.deposits_report', p_organization_id\)/);
  });

  it('copilot_report_terminations_v1: mau so ti le nam trong CUNG pham vi toa voi tu so', () => {
    // Tử số bị giới hạn theo toà mà mẫu số đếm cả công ty thì tỉ lệ thanh lý của
    // một quản lý một toà luôn nhỏ hơn sự thật — sai theo hướng trấn an.
    const body = functionBody(migration, 'copilot_report_terminations_v1');
    const mauSo = body.slice(body.indexOf('INTO v_mau_so'), body.indexOf('WITH ket_thuc'));
    expect(mauSo).toMatch(/b\.id = ANY\(v_buildings\)/);
    expect(mauSo).toMatch(/ct\.status <> 'DRAFT'/);
  });

  it('dem du 10 ham — them mot ham moi phai them mot dong o day', () => {
    // Sàn chống bỏ quên theo chiều ngược: một hàm thứ 11 ra đời mà quên khai ở
    // các danh sách trên thì con số này không khớp và test đỏ.
    const lan = migration.match(/CREATE OR REPLACE FUNCTION public\.copilot_/g) ?? [];
    expect(lan).toHaveLength(RPC_MOI.length);
  });
});

// SỰ THẬT CỦA SỔ QUỸ NẰM Ở BÚT TOÁN, KHÔNG NẰM Ở PHIẾU.
//
// Bản đầu của hai hàm này cộng `income_expenses.total_amount` lọc
// `approval_status = 'APPROVED'` theo `voucher_date`. Nó "chạy đúng" trên mọi dữ
// liệu chưa từng bị đảo — và sai câm trên dữ liệu có thật: một phiếu đã vào sổ
// rồi bị ĐẢO nets về 0 trong sự thật bút toán nhưng được cộng NGUYÊN trong cách
// đó, và một phiếu huỷ-sau-khi-vào-sổ cũng vậy. Chính màn hình này vừa bị gỡ
// đúng cái bệnh hai-nguồn-sự-thật ấy (xem src/hooks/useCashBook.ts).
//
// Kèm theo là hàng rào sổ quỹ: 20260730101000 ("Vá LỖ C") đóng lỗ rò tồn quỹ
// bằng đúng một predicate ở cuối mỗi hàm tổng hợp. Một rollup mới thiếu nó là
// mở lại cái lỗ đó bằng một cánh cửa khác.
describe('so quy — su that but toan + ranh gioi so quy', () => {
  const ROLLUP_TIEN = ['copilot_report_daily_cashbook_v1', 'copilot_report_cash_flow_v1'] as const;

  for (const rpc of ROLLUP_TIEN) {
    it(`${rpc}: doc income_expense_posting_lines, khong doc income_expenses.total_amount`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/FROM public\.income_expense_posting_lines pl/);
      expect(body, rpc).toMatch(/JOIN public\.income_expense_postings p\b/);
      expect(body, rpc).toMatch(/p\.id = pl\.posting_id/);
      expect(body, rpc).toMatch(/p\.organization_id = pl\.organization_id/);
      // Nguồn cũ phải biến mất hẳn, kể cả bộ lọc của nó.
      expect(body, rpc).not.toMatch(/ie\.total_amount/);
      expect(body, rpc).not.toMatch(/approval_status/);
      expect(body, rpc).not.toMatch(/ie\.voucher_date/);
    });

    it(`${rpc}: chi cong POSTING va REVERSAL, khoa theo posted_on`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/p\.event_kind IN \('POSTING', 'REVERSAL'\)/);
      expect(body, rpc).toMatch(/p\.posted_on BETWEEN p_tu AND p_den/);
      // Dấu lấy y hệt cashflow_by_day_v2: dương là tiền vào, âm là tiền ra.
      expect(body, rpc).toMatch(/sum\(d\.signed_amount\) FILTER \(WHERE d\.signed_amount > 0\)/);
      expect(body, rpc).toMatch(/sum\(-d\.signed_amount\) FILTER \(WHERE d\.signed_amount < 0\)/);
    });

    it(`${rpc}: rang theo CA HAI nua cua ranh gioi so quy`, () => {
      // Đây là dòng chịu lực của Vá LỖ C. Xoá nó thì mọi cửa chặn vẫn xanh và
      // tồn quỹ của sổ người khác chảy ra qua một câu hỏi Copilot.
      const body = functionBody(migration, rpc);
      expect(body, `${rpc}: khong gan tap so quy RBAC cua cong ty da chon`).toMatch(
        /v_cashbooks := app_private\.copilot_scope_cashbooks_v1\('cashbooks\.view', p_organization_id\);/,
      );
      expect(body, `${rpc}: thieu predicate pl.account_id = ANY(v_cashbooks)`).toMatch(
        /pl\.account_id = ANY\(v_cashbooks\)/,
      );
      expect(body, `${rpc}: thieu ranh gioi ie_visible_cashbook_ids_v1`).toMatch(
        /pl\.account_id IN \(SELECT v\.cashbook_id FROM app_private\.ie_visible_cashbook_ids_v1\(\) v\)/,
      );
    });

    it(`${rpc}: bien gioi cong ty lay tu tham so, khong tu my_org_ids()`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/pl\.organization_id = p_organization_id/);
      // `my_org_ids()` là chính thứ khiến hai RPC của trang không tái dùng được.
      expect(body, rpc).not.toMatch(/my_org_ids\(\)/);
    });

    it(`${rpc}: dong khong gan toa chi lot khi quyen la toan cong ty`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(
        /\(b\.id IS NOT NULL OR \(ie\.building_id IS NULL AND v_org_wide\)\)/,
      );
      expect(body, rpc).toMatch(/authorized_scope_v3\('reports_finance\.[a-z_]+', p_organization_id\)/);
    });
  }

  it('cat danh sach ky o dau MOI NHAT, khong phai dau cu nhat', () => {
    // `ORDER BY ky LIMIT 20` trên cửa sổ 12 tháng trả về các tháng CŨ NHẤT rồi
    // bỏ đúng những tháng vừa được hỏi — một câu trả lời đầy đủ về sai kỳ.
    for (const rpc of ['copilot_report_cash_flow_v1', 'copilot_report_expense_ratio_v1']) {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/ORDER BY ky DESC LIMIT v_limit/);
      expect(body, rpc).not.toMatch(/ORDER BY ky LIMIT v_limit/);
    }
    // Sổ quỹ theo ngày vốn đã cắt đúng đầu; ghim để không ai "đồng bộ" ngược lại.
    expect(functionBody(migration, 'copilot_report_daily_cashbook_v1')).toMatch(
      /ORDER BY ngay DESC LIMIT v_limit/,
    );
  });
});

// HÔM NAY LÀ HÔM NAY CỦA CÔNG TY.
//
// Máy chủ chạy UTC còn dữ liệu ở UTC+7: từ 00:00 đến 07:00 giờ Việt Nam,
// `CURRENT_DATE` vẫn là HÔM QUA. `20260731070000` đã đổi 78 chỗ sang
// `org_today_v1` đúng vì thế. Hai chỗ trong migration này quyết định TIỀN —
// "quá hạn hay chưa" và mốc cuối của cửa sổ thu tiền.
describe('moc thoi gian — org_today_v1, khong phai CURRENT_DATE', () => {
  it('khong con mot CURRENT_DATE tran nao trong ma', () => {
    expect(boCommentSql(migration)).not.toMatch(/CURRENT_DATE/i);
  });

  const CAN_HOM_NAY: Record<string, RegExp[]> = {
    copilot_report_vacant_rooms_v1: [/\(v_today - s\.effective_end\)/],
    copilot_report_expense_ratio_v1: [/v_den := COALESCE\(p_den, v_today\);/],
    copilot_report_payment_schedule_v1: [
      /v_den := v_today \+ v_so_ngay;/,
      /FILTER \(WHERE l\.due_date < v_today\)/,
      /\(s\.due_date - v_today\)/,
    ],
    copilot_report_deposits_v1: [/\(v_today - s\.deposit_date\)/],
  };

  for (const [rpc, patterns] of Object.entries(CAN_HOM_NAY)) {
    it(`${rpc}: lay hom nay tu org_today_v1(p_organization_id)`, () => {
      const body = functionBody(migration, rpc);
      expect(body, rpc).toMatch(/v_today := public\.org_today_v1\(p_organization_id\);/);
      for (const pattern of patterns) expect(body, `${rpc}: ${pattern}`).toMatch(pattern);
    });
  }

  it('nghiem thu doi du bon ham nen mong truoc khi tin ket qua', () => {
    const block = migration.slice(migration.indexOf('DO $nghiem_thu$'));
    expect(block).toContain('app_private.copilot_scope_cashbooks_v1(text, uuid)');
    expect(block).toContain('app_private.ie_visible_cashbook_ids_v1()');
    expect(block).toContain('public.org_today_v1(uuid)');
  });
});
