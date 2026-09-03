// Mirror TS của sổ đăng ký hành động phải khớp ĐÚNG seed SQL.
//
// LỖ ĐANG VÁ
//   `ACTION_CATALOG` là một bản chép của `app_private.copilot_action_registry`.
//   Hai bản ở hai ngôn ngữ, không có gì bắt chúng khớp nhau — và cái lệch không
//   nổ ra ở đâu cả: client dựng khoá rollout `action:<id>` theo bản của mình,
//   server đọc bảng của mình, và nếu hai bên hiểu khác nhau về `executorKind`
//   hay `previewRpc` thì triệu chứng là một hành động im lặng không chạy.
//
//   Test đọc THẲNG file migration đã apply (không phải một fixture chép tay:
//   fixture cũng là một bản sao thứ ba) và so từng trường.
//
// ĐO BẰNG ĐỘT BIẾN
//   - Đổi `risk: 'L4'` → `'L5'` trong catalog: đỏ ở "khớp từng trường".
//   - Comment dòng seed trong SQL: đỏ ở "mọi hành động seed đều có trong mirror"
//     (thân SQL đã bị lột bình luận trước khi dò — xem `than()`).
//   - Thêm một entry vào catalog mà không seed: đỏ ở "mirror không thừa".
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACTION_CATALOG,
  khoaQuyenHanhDong,
  khoaRolloutHanhDong,
  type ActionCatalogEntry,
  type ActionId,
} from '../actionCatalog';
import { COPILOT_ROLLOUT_ACTION_CONTRACTS } from '@/copilot/featureFlags';

const THU_MUC_MIGRATION = 'supabase/migrations';

/**
 * MỌI migration có seed `copilot_action_registry`, không chỉ migration G2-A.
 *
 * Bản đầu của test này ghim đúng một file (`*_copilot_action_registry_policy_ledger_v1.sql`).
 * Từ G2-D mỗi action mới đi một migration RIÊNG — đúng luật "một action, một
 * file" — nên một bộ đọc chỉ biết file G2-A sẽ thấy seed có 1 hàng trong khi
 * mirror có 4, và bài "mirror không thừa" sẽ đỏ vì lý do SAI: không phải mirror
 * thừa, mà là phép đo hụt. Quét theo NỘI DUNG (file nào có câu INSERT ấy) thay
 * vì theo tên là cách duy nhất không phải sửa test mỗi lần thêm action.
 */
function timFileMigration(): string[] {
  const ra = readdirSync(THU_MUC_MIGRATION)
    .filter((ten) => ten.endsWith('.sql'))
    .map((ten) => join(THU_MUC_MIGRATION, ten))
    .filter((duong) =>
      /INSERT\s+INTO\s+app_private\.copilot_action_registry/i.test(readFileSync(duong, 'utf8')),
    );
  expect(ra.length, 'không tìm thấy migration nào seed sổ đăng ký hành động').toBeGreaterThan(0);
  return ra;
}

/**
 * Thân SQL đã lột bình luận.
 *
 * BẮT BUỘC phải lột TRƯỚC khi dò: comment một dòng seed ra
 * (`-- 'income_expense.create_draft',`) thì bản dò trên nguyên văn vẫn "thấy"
 * nó và test vẫn xanh — tức là canh đúng thứ nó sinh ra để canh thì trượt.
 */
function than(sql: string): string {
  return sql.replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
}

/** Tách một danh sách phân cách bằng dấu phẩy ở MỨC NGOÀI CÙNG của dấu ngoặc. */
function tachCapNgoaiCung(noiDung: string): string[] {
  const ra: string[] = [];
  let sau = 0;
  let doSau = 0;
  let trongChuoi = false;
  for (let i = 0; i < noiDung.length; i += 1) {
    const c = noiDung[i];
    if (trongChuoi) {
      if (c === "'") trongChuoi = noiDung[i + 1] === "'" ? (i += 1, true) : false;
      continue;
    }
    if (c === "'") trongChuoi = true;
    else if (c === '(' || c === '[') doSau += 1;
    else if (c === ')' || c === ']') doSau -= 1;
    else if (c === ',' && doSau === 0) {
      ra.push(noiDung.slice(sau, i).trim());
      sau = i + 1;
    }
  }
  ra.push(noiDung.slice(sau).trim());
  return ra.map((x) => x.trim()).filter((x) => x.length > 0);
}

/** `'abc'` → `abc`; `NULL` → null; `true`/`1` giữ nguyên dạng chuỗi thô. */
function boNhayDon(gt: string): string | null {
  if (/^null$/i.test(gt)) return null;
  const m = gt.match(/^'([\s\S]*)'$/);
  return m ? m[1].replace(/''/g, "'") : gt;
}

/**
 * Bóc mọi hàng seed của `copilot_action_registry` thành object theo TÊN CỘT.
 *
 * Đọc danh sách cột từ chính câu INSERT thay vì ghim thứ tự: thêm một cột vào
 * giữa danh sách là đủ để một bộ đọc theo vị trí đọc lệch mọi trường mà vẫn
 * "chạy".
 */
export function docSeedRegistry(sql: string): Record<string, string | null>[] {
  const m = than(sql).match(
    /INSERT\s+INTO\s+app_private\.copilot_action_registry\s*\(([\s\S]*?)\)\s*VALUES\s*([\s\S]*?)ON\s+CONFLICT/i,
  );
  if (!m) return [];
  const cot = tachCapNgoaiCung(m[1]).map((x) => x.replace(/\s+/g, ''));
  const khoiValues = m[2];
  const hang: Record<string, string | null>[] = [];
  // Mỗi tuple `( ... )` ở mức ngoài cùng là một hàng.
  let doSau = 0;
  let dau = -1;
  let trongChuoi = false;
  for (let i = 0; i < khoiValues.length; i += 1) {
    const c = khoiValues[i];
    if (trongChuoi) {
      if (c === "'") trongChuoi = khoiValues[i + 1] === "'" ? (i += 1, true) : false;
      continue;
    }
    if (c === "'") trongChuoi = true;
    else if (c === '(') {
      if (doSau === 0) dau = i + 1;
      doSau += 1;
    } else if (c === ')') {
      doSau -= 1;
      if (doSau === 0 && dau >= 0) {
        const gt = tachCapNgoaiCung(khoiValues.slice(dau, i));
        expect(gt).toHaveLength(cot.length);
        hang.push(Object.fromEntries(cot.map((ten, idx) => [ten, boNhayDon(gt[idx])])));
        dau = -1;
      }
    }
  }
  return hang;
}

/** Bóc các dòng seed cờ scope `action` của cùng migration. */
export function docSeedCoAction(sql: string): { contractId: string; state: string }[] {
  // KHÔNG đòi dấu `)` ngay sau trạng thái: G2-A seed bằng một danh sách VALUES
  // rút gọn `('action','x','disabled')`, còn mỗi migration action từ G2-D seed
  // một tuple ĐẦY ĐỦ sáu cột. Một regex đòi đóng ngoặc sẽ im lặng bỏ qua dạng
  // thứ hai, và bài "mỗi contract có đúng một dòng seed cờ" sẽ xanh trên một
  // tập rỗng.
  return [...than(sql).matchAll(/\(\s*'action',\s*'([^']+)'\s*,\s*'(\w+)'/g)].map((m) => ({
    contractId: m[1],
    state: m[2],
  }));
}

const cacFile = timFileMigration();
const seed = cacFile.flatMap((duong) => docSeedRegistry(readFileSync(duong, 'utf8')));
const seedCo = cacFile.flatMap((duong) => docSeedCoAction(readFileSync(duong, 'utf8')));

describe('mirror ACTION_CATALOG khớp seed registry của migration G2-A', () => {
  it('bộ đọc thật sự bóc được dữ liệu (chống xanh-rỗng)', () => {
    expect(seed.length).toBeGreaterThan(0);
    expect(Object.keys(seed[0])).toContain('action_id');
    expect(seedCo.length).toBeGreaterThan(0);
  });

  it('mọi hành động seed đều có trong mirror, và mirror không thừa', () => {
    expect(new Set(seed.map((r) => r.action_id))).toEqual(new Set(Object.keys(ACTION_CATALOG)));
  });

  it('khớp từng trường: version, risk, executorKind, consentRequired, RPC, quyền', () => {
    for (const hang of seed) {
      const id = String(hang.action_id);
      const muc = (ACTION_CATALOG as Record<string, ActionCatalogEntry>)[id];
      expect(muc, `mirror thiếu hành động ${id}`).toBeDefined();
      expect(muc.actionId).toBe(id);
      expect(String(muc.version)).toBe(hang.version);
      expect(muc.labelVi).toBe(hang.label_vi);
      expect(muc.risk).toBe(hang.risk);
      expect(muc.executorKind).toBe(hang.executor_kind);
      expect(muc.consentRequired).toBe(hang.consent_required);
      expect(muc.previewRpc).toBe(hang.preview_rpc);
      expect(muc.executeRpc).toBe(hang.execute_rpc);
      expect(khoaQuyenHanhDong(muc)).toBe(hang.permission_key);
      // Cờ kill switch của hành động là `flag_contract_id` — client dựng khoá
      // rollout từ `actionId`, nên hai thứ đó lệch nhau nghĩa là bật cờ ở trang
      // admin xong tool vẫn tắt.
      expect(hang.flag_contract_id).toBe(muc.actionId);
    }
  });

  it('mỗi contract rollout scope action có đúng một dòng seed cờ', () => {
    expect(new Set(seedCo.map((r) => r.contractId))).toEqual(
      new Set(COPILOT_ROLLOUT_ACTION_CONTRACTS.map((c) => c.contractId)),
    );
    expect(seedCo).toHaveLength(COPILOT_ROLLOUT_ACTION_CONTRACTS.length);
    // Seed ở trạng thái `disabled`: một đường ghi mới KHÔNG được tự sống ngay
    // khi bản web lên — nó chờ một quyết định có tên người và có lý do.
    for (const dong of seedCo) expect(dong.state).toBe('disabled');
  });

  it('khoá rollout của hành động luôn mang tiền tố `action:`', () => {
    for (const id of Object.keys(ACTION_CATALOG) as ActionId[]) {
      expect(khoaRolloutHanhDong(id)).toBe(`action:${id}`);
    }
  });

  it('input schema của hành động IE nhận đúng payload xem trước và từ chối payload thiếu', () => {
    const muc = ACTION_CATALOG['income_expense.create_draft'];
    expect(
      muc.inputSchema.safeParse({
        loai: 'chi',
        so_tien: 150000,
        ten_phieu: 'Chi mua bóng đèn',
        toa_nha: 'DEMO A',
        hang_muc: 'Vệ sinh',
      }).success,
    ).toBe(true);
    expect(muc.inputSchema.safeParse({ loai: 'chi', so_tien: -1 }).success).toBe(false);
    // `previewFields` phải phủ đúng khối `preview` mà RPC trả về.
    expect([...muc.previewFields]).toEqual([
      'loai',
      'so_tien',
      'ten_phieu',
      'toa_nha',
      'hang_muc',
      'ngay',
      'trang_thai',
    ]);
  });
});
