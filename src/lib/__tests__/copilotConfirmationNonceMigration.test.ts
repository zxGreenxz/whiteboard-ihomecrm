// Bất biến của nonce xác nhận GHI — đo trên CHÍNH văn bản migration.
//
// Cái được bảo vệ ở đây là một RANH GIỚI, không phải một tính năng: mô hình phải
// KHÔNG có cách nào tự tạo bằng chứng đồng ý. Mọi khẳng định dưới đây đều là một
// đường mà nếu ai đó vô tình mở ra thì ranh giới đó biến mất trong im lặng — cấp
// nonce cho anon, quên khoá dòng, tiêu nonce sau khi tạo phiếu, hay bỏ phép so
// hash payload.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20260814034500_copilot_confirmation_intent_v1.sql',
  'utf8',
).replace(/\r\n/g, '\n');

describe('kho nonce', () => {
  it('nằm trong app_private và bị REVOKE khỏi mọi vai client', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS app_private\.copilot_write_confirmations/);
    expect(sql).toMatch(
      /REVOKE ALL ON app_private\.copilot_write_confirmations FROM PUBLIC, anon, authenticated;/,
    );
  });

  it('chỉ lưu DIGEST, không lưu nonce thô', () => {
    // Bảng ở app_private nên client không đọc được, nhưng bản sao database, một
    // lần khôi phục hay truy vấn service-role đọc nhầm cũng đủ lộ. Digest thì
    // thứ rò ra không dùng được.
    expect(sql).toMatch(/nonce_digest\s+bytea\s+NOT NULL UNIQUE/);
    // Chỉ soi phần khai báo CỘT — `p_confirmation_nonce text` là THAM SỐ hàm
    // execute, hoàn toàn hợp lệ; bắt nhầm nó là bắt nhầm chỗ.
    const khaiBaoCot = sql.slice(
      sql.indexOf('CREATE TABLE IF NOT EXISTS app_private.copilot_write_confirmations'),
      sql.indexOf('COMMENT ON TABLE app_private.copilot_write_confirmations'),
    );
    expect(khaiBaoCot).not.toMatch(/nonce_raw|nonce\s+text|nonce\s+bytea(?!.*digest)/);
  });

  it('có TTL và cột tiêu dùng một lần', () => {
    expect(sql).toMatch(/expires_at\s+timestamptz NOT NULL/);
    expect(sql).toMatch(/consumed_at\s+timestamptz/);
    expect(sql).toMatch(/interval '5 minutes'/);
  });
});

describe('preview — phát nonce', () => {
  it('sinh 32 byte ngẫu nhiên từ pgcrypto, trả RA MỘT LẦN', () => {
    expect(sql).toMatch(/extensions\.gen_random_bytes\(32\)/);
    expect(sql).toMatch(/'confirmation_nonce',\s*encode\(v_nonce, 'hex'\)/);
  });

  it('chặn anon và người chưa đăng nhập', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.copilot_preview_income_expense_v1\(uuid, jsonb\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'unauthenticated'/);
  });

  it('bắt buộc có tổ chức và có quyền tạo TRONG tổ chức đó', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'organization_required'/);
    expect(sql).toMatch(/authorized_scope_v3\('income_expenses\.create', p_organization_id\)/);
    expect(sql).toMatch(/RAISE EXCEPTION 'not_permitted'/);
  });

  it('khớp NHIỀU toà/hạng mục thì DỪNG, không đoán lấy cái đầu', () => {
    // Đoán lấy kết quả đầu tiên nghĩa là ghi tiền vào một toà mà không ai chọn.
    expect(sql).toMatch(/RAISE EXCEPTION 'toa_nha_mo_ho'/);
    expect(sql).toMatch(/RAISE EXCEPTION 'hang_muc_mo_ho'/);
  });

  it('chỉ tìm toà/hạng mục TRONG tổ chức đã chốt', () => {
    const soLanLocOrg = (sql.match(/organization_id = p_organization_id/g) ?? []).length;
    expect(soLanLocOrg).toBeGreaterThanOrEqual(4); // buildings ×2, types ×2
  });

  it('băm payload CHUẨN HOÁ chứ không băm input thô', () => {
    // Input thô mang tên toà gõ gần đúng: hai cách gõ cho cùng một toà sẽ ra hai
    // hash khác nhau, và phép so hash lúc execute mất hết ý nghĩa.
    expect(sql).toMatch(/v_canonical\s+:?=\s*jsonb_build_object/);
    expect(sql).toMatch(/copilot_payload_hash_v1\(v_canonical\)/);
    expect(sql).toMatch(/'building_id',\s+v_building\.id/);
    expect(sql).toMatch(/'type_id',\s+v_type\.id/);
  });
});

describe('execute — tiêu nonce rồi mới ghi', () => {
  it('KHOÁ dòng nonce ngay khi tra', () => {
    // Không khoá thì hai lần bấm song song đều đọc thấy consumed_at IS NULL và
    // cùng đi tiếp — hai phiếu cho một lần đồng ý.
    expect(sql).toMatch(/FROM app_private\.copilot_write_confirmations c[\s\S]{0,200}FOR UPDATE/);
  });

  it('tiêu nonce bằng CAS TRƯỚC khi tạo phiếu', () => {
    const iTieu = sql.indexOf('SET consumed_at = clock_timestamp()');
    // LỜI GỌI thật, không phải lần nhắc tên trong chú thích đầu file.
    const iTao = sql.indexOf('public.ie_compat_insert_v2(');
    expect(iTieu).toBeGreaterThan(0);
    expect(iTao).toBeGreaterThan(0);
    expect(iTieu, 'phải tiêu nonce trước khi tạo phiếu').toBeLessThan(iTao);
    expect(sql).toMatch(/WHERE id = v_row\.id AND consumed_at IS NULL/);
  });

  it('từ chối mọi ca hỏng: hết hạn, đã dùng, sai người, đổi payload, lệch tổ chức', () => {
    for (const ma of [
      'confirmation_not_found',
      'confirmation_already_used',
      'confirmation_expired',
      'payload_changed',
      'organization_mismatch',
    ]) {
      expect(sql, `thiếu lối chặn ${ma}`).toContain(`RAISE EXCEPTION '${ma}'`);
    }
  });

  it('nonce của người khác báo GIỐNG HỆT "không tìm thấy"', () => {
    // Báo khác nhau là xác nhận giúp kẻ gọi rằng nonce đó có thật.
    const doanNguoiKhac = sql.slice(
      sql.indexOf('v_row.user_id <> v_actor'),
      sql.indexOf('v_row.user_id <> v_actor') + 400,
    );
    expect(doanNguoiKhac).toContain("confirmation_not_found");
  });

  it('nonce sai độ dài bị chặn TRƯỚC khi chạm bảng', () => {
    const iDoDai = sql.indexOf("length(p_confirmation_nonce) <> 64");
    const iTraBang = sql.indexOf('FROM app_private.copilot_write_confirmations c');
    expect(iDoDai).toBeGreaterThan(0);
    expect(iDoDai).toBeLessThan(iTraBang);
  });

  it('ghi audit trong CÙNG giao dịch với phiếu, kèm entity_id ngay', () => {
    // Luồng cũ: browser INSERT audit → RPC tạo phiếu → browser UPDATE entity_id.
    // Ba bước, ba cơ hội để lệch nhau khi hỏng giữa chừng.
    expect(sql).toMatch(/INSERT INTO public\.ai_write_audit[\s\S]{0,400}entity_id/);
    expect(sql).toMatch(/VALUES[\s\S]{0,200}v_vid/);
  });

  it('idempotency: cùng ý định chỉ tạo một phiếu', () => {
    expect(sql).toMatch(/v_key\s+:?=\s*'copilot_ie_' \|\| encode\(v_hash, 'hex'\)/);
    expect(sql).toMatch(/'status', 'da_tao_truoc_do'/);
  });

  it('phiếu tạo ra KHÔNG gắn sổ quỹ (account_id null)', () => {
    // Gắn sổ nghĩa là đụng tiền thật. Copilot chỉ được tạo bản nháp chờ duyệt.
    expect(sql).toMatch(/'account_id',\s+NULL/);
  });

  it('chặn anon', () => {
    expect(sql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.copilot_execute_income_expense_v1\(text, jsonb\) FROM PUBLIC, anon;/,
    );
  });
});

describe('an toàn chung', () => {
  it('cả hai hàm là SECURITY DEFINER kèm search_path cố định', () => {
    // Đúng HAI: preview và execute. `copilot_payload_hash_v1` cố ý KHÔNG phải
    // DEFINER — nó là hàm thuần, không đọc gì, nên nâng quyền cho nó là nâng
    // thừa. Con số ở đây là một khẳng định về bề mặt, không phải sàn tuỳ tiện.
    const soDefiner = (sql.match(/SECURITY DEFINER/g) ?? []).length;
    expect(soDefiner).toBe(2);
    expect(sql).toMatch(/SET search_path = pg_catalog, public, app_private, extensions/);
  });

  it('KHÔNG tự dựng lớp phân quyền song song lúc ghi', () => {
    // Phân quyền lúc ghi do ie_compat_insert_v2 lo. Dựng lớp thứ hai ở đây sẽ tạo
    // hai nguồn sự thật và chúng sẽ lệch nhau.
    const doanExecute = sql.slice(sql.indexOf('copilot_execute_income_expense_v1'));
    expect(doanExecute).not.toMatch(/authorized_scope_v3/);
  });

  it('có BEGIN/COMMIT, lock_timeout và đường lùi đầy đủ', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("SET LOCAL lock_timeout = '15s'");
    for (const doiTuong of [
      'DROP FUNCTION public.copilot_execute_income_expense_v1(text, jsonb);',
      'DROP FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb);',
      'DROP TABLE app_private.copilot_write_confirmations;',
    ]) {
      expect(sql, `rollback thiếu ${doiTuong}`).toContain(doiTuong);
    }
  });
});
