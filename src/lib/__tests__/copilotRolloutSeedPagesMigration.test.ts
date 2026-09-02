// Seed cờ rollout phải PHỦ ĐÚNG danh sách contract mà client dựng ra.
//
// LỖ ĐANG VÁ
//   `set_copilot_feature_flag_v2` chỉ UPDATE dòng CÓ SẴN trong
//   `copilot_feature_flags`; không có dòng thì nó ném `unknown_rollout_contract`.
//   Nên một trang có mặt trong `COPILOT_ROLLOUT_CONTRACTS` mà thiếu dòng seed là
//   một trang KHÔNG BAO GIỜ bật được — và triệu chứng duy nhất là một nút bấm
//   trong trang admin trả lỗi mà người vận hành không có cách nào tự chữa.
//
//   Hai danh sách này ở hai ngôn ngữ khác nhau (TS và SQL) nên không có gì bắt
//   chúng khớp ngoài test này. Đây đúng là lớp lỗi đã đo ở G1-A với ba danh
//   sách route chép tay.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_ROLLOUT_CONTRACTS,
  KHOA_ROLLOUT_DIEU_HUONG,
} from '@/copilot/featureFlags';

const DUONG_DAN = 'supabase/migrations/20260902185838_copilot_rollout_seed_pages_v1.sql';
const sql = readFileSync(DUONG_DAN, 'utf8').replace(/\r\n/g, '\n');

/**
 * Thân SQL đã bỏ chú thích. Bắt buộc phải bỏ TRƯỚC khi dò khối VALUES: đo bằng
 * đột biến — comment một dòng seed ra (`-- ('page', 'tasks.list', …)`) thì bản
 * dò trên nguyên văn vẫn "thấy" nó và test vẫn xanh, tức là canh đúng thứ nó
 * sinh ra để canh thì trượt.
 */
const than = sql.replace(/--.*/g, '');

/** Khoá được seed, đọc từ chính khối VALUES (đã bỏ chú thích). */
const khoaSeed = [...than.matchAll(/\('page',\s*'([^']+)'\s*,\s*'(\w+)'\)/g)].map((m) => ({
  contractId: m[1],
  state: m[2],
}));

describe('seed phủ đúng danh sách contract của client', () => {
  it('mỗi contract scope `page` có đúng một dòng seed', () => {
    const mongDoi = COPILOT_ROLLOUT_CONTRACTS.filter((c) => c.scope === 'page').map(
      (c) => c.contractId,
    );
    expect(mongDoi.length).toBeGreaterThanOrEqual(20); // sàn chống-xanh-rỗng
    expect(new Set(khoaSeed.map((r) => r.contractId))).toEqual(new Set(mongDoi));
    expect(khoaSeed).toHaveLength(mongDoi.length);
  });

  it('có khoá điều hướng riêng — không mượn cờ của ba trang pilot', () => {
    expect(khoaSeed.map((r) => r.contractId)).toContain(KHOA_ROLLOUT_DIEU_HUONG);
    expect(than).toContain("'copilot.navigation'");
  });

  it('MỌI dòng seed `disabled`, không có dòng nào bật sẵn', () => {
    // Bật rollout là quyết định vận hành, có CAS revision + lý do + bằng chứng
    // + tham chiếu rollback trong sổ audit. Bật bằng migration là bật không
    // tên: sổ audit ghi "migration" và không ai trả lời được vì sao.
    for (const dong of khoaSeed) expect(dong.state, dong.contractId).toBe('disabled');
    expect(than).not.toMatch(/'enabled'/);
    expect(than).not.toMatch(/'shadow'/);
  });
});

describe('seed không đè trạng thái đang chạy trên production', () => {
  it('ON CONFLICT (scope, contract_id) DO NOTHING', () => {
    // 3 dòng cũ có thể đã được vận hành chuyển sang shadow/canary. DO UPDATE
    // hay DO NOTHING là khác biệt giữa "thêm công tắc" và "tắt hết công tắc".
    expect(than).toMatch(/ON\s+CONFLICT\s*\(\s*scope\s*,\s*contract_id\s*\)\s*DO\s+NOTHING/i);
    expect(than).not.toMatch(/DO\s+UPDATE/i);
  });

  it('không UPDATE/DELETE dòng nào của bảng cờ', () => {
    expect(than).not.toMatch(/UPDATE\s+public\.copilot_feature_flags/i);
    expect(than).not.toMatch(/DELETE\s+FROM\s+public\.copilot_feature_flags/i);
  });
});

describe('đi đúng cửa transition v2', () => {
  it('đặt GUC `app.copilot_feature_flag_transition` = v2 TRƯỚC khi INSERT', () => {
    // Trigger bump_revision (20260829030000) RAISE 42501 nếu thiếu dấu này.
    // Thiếu nó thì migration chết ngay dòng INSERT đầu tiên.
    const iGuc = than.search(
      /set_config\(\s*'app\.copilot_feature_flag_transition'\s*,\s*'v2'\s*,\s*true\s*\)/i,
    );
    const iInsert = than.search(/INSERT\s+INTO\s+public\.copilot_feature_flags/i);
    expect(iGuc).toBeGreaterThanOrEqual(0);
    expect(iInsert).toBeGreaterThan(iGuc);
  });

  it('trả GUC về rỗng sau khi seed xong', () => {
    const iTra = than.search(
      /set_config\(\s*'app\.copilot_feature_flag_transition'\s*,\s*''\s*,\s*true\s*\)/i,
    );
    const iInsert = than.search(/INSERT\s+INTO\s+public\.copilot_feature_flags/i);
    expect(iTra).toBeGreaterThan(iInsert);
  });
});

describe('khối nghiệm thu chỉ soi catalog cờ', () => {
  it('kiểm đủ mặt từng contract và sàn ≥ 20 dòng scope page', () => {
    expect(than).toMatch(/copilot_rollout_seed_thieu_contract/);
    expect(than).toMatch(/copilot_rollout_seed_thieu_dong/);
    expect(than).toMatch(/count\(\*\)[\s\S]{0,120}WHERE\s+scope\s*=\s*'page'/i);
  });

  it('không đọc/ghi bảng nghiệp vụ nào ngoài bảng cờ', () => {
    // Nghiệm thu phải chạy được trên DB rỗng của Restore Drill: tham chiếu một
    // bảng nghiệp vụ (hay một organization có thật) là biến cả migration thành
    // thứ chỉ replay được trên production.
    const bang = [...sql.matchAll(/\b(?:FROM|JOIN|INTO)\s+(public\.\w+)/gi)].map((m) => m[1]);
    expect(new Set(bang)).toEqual(new Set(['public.copilot_feature_flags']));
    expect(sql).not.toMatch(/organizations/i);
  });
});

describe('hình dạng migration', () => {
  it('đúng MỘT cặp BEGIN/COMMIT kèm lock_timeout', () => {
    const khongChuThich = sql.replace(/--[^\n]*/g, '');
    expect(khongChuThich.match(/^\s*BEGIN;/gm)?.length ?? 0).toBe(1);
    expect(khongChuThich.match(/^\s*COMMIT;/gm)?.length ?? 0).toBe(1);
    expect(sql).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'15s';/i);
  });

  it('mở đầu bằng lý do, không phải chỉ tên bảng', () => {
    expect(sql.slice(0, 1500)).toMatch(/unknown_rollout_contract|KHÔNG\s+BAO\s+GIỜ bật được/);
  });
});
