// `ai_write_audit` phải là sổ CHỈ GHI THÊM — đo trên chính văn bản migration.
//
// Một cuốn sổ mà chính người bị ghi sổ sửa được thì không phải sổ. Trước
// 14/08/2026 vai `authenticated` có cả INSERT lẫn UPDATE own-row, nghĩa là một
// client (hoặc mã chạy trong client) đổi được `payload`/`entity_id` SAU KHI việc
// đã xảy ra — và không có gì trong dữ liệu cho biết, vì bản thân bằng chứng là
// thứ bị sửa.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20260814034600_ai_write_audit_hardening.sql',
  'utf8',
).replace(/\r\n/g, '\n');

const nonce = readFileSync(
  'supabase/migrations/20260814034500_copilot_confirmation_intent_v1.sql',
  'utf8',
);

describe('đóng đường ghi từ trình duyệt', () => {
  it('gỡ đúng hai policy ghi cũ', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS ai_write_audit_insert\s+ON public\.ai_write_audit;/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS ai_write_audit_update_own ON public\.ai_write_audit;/);
  });

  it('thu hồi quyền bảng của authenticated, GIỮ quyền đọc', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.ai_write_audit FROM authenticated;/);
    // Không được REVOKE SELECT: người dùng vẫn phải xem được sổ của chính mình.
    expect(sql).not.toMatch(/REVOKE[^;]*SELECT[^;]*ai_write_audit/);
    expect(sql).toMatch(/has_table_privilege\('authenticated', 'public\.ai_write_audit', 'SELECT'\)/);
  });

  it('KHÔNG gỡ policy SELECT', () => {
    expect(sql).not.toMatch(/DROP POLICY[^;]*ai_write_audit_select/);
  });
});

describe('bất biến với MỌI vai, không chỉ authenticated', () => {
  it('có trigger chặn UPDATE và DELETE', () => {
    // Bỏ policy đủ cho `authenticated`. Trigger là để chặn cả những đường KHÔNG
    // đi qua RLS: service_role, một hàm SECURITY DEFINER viết ẩu sau này, hay
    // một lần sửa tay trong console.
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.ai_write_audit/);
    expect(sql).toMatch(/FOR EACH ROW EXECUTE FUNCTION app_private\.ai_write_audit_bat_bien_v1\(\)/);
    expect(sql).toMatch(/RAISE EXCEPTION[\s\S]{0,200}chi ghi them/);
  });

  it('trigger KHÔNG chặn INSERT — sổ vẫn phải ghi thêm được', () => {
    // Chặn cả INSERT thì đường ghi hợp lệ của server cũng chết theo.
    expect(sql).not.toMatch(/BEFORE INSERT[^\n]*ai_write_audit/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE/);
  });
});

describe('thứ tự phụ thuộc', () => {
  it('chạy SAU migration dựng đường ghi mới', () => {
    // Đóng đường ghi cũ trước khi đường ghi mới tồn tại sẽ tạo một khoảng —
    // dù chỉ trong một lần apply — mà hệ thống không có đường ghi hợp lệ nào.
    const tsNay = '20260814034600';
    const tsNonce = '20260814034500';
    expect(tsNay > tsNonce).toBe(true);
    // Và migration kia phải thật sự ghi audit từ server.
    expect(nonce).toMatch(/INSERT INTO public\.ai_write_audit/);
  });

  it('ghi rõ thứ tự phát hành trong chính file', () => {
    expect(sql).toMatch(/THỨ TỰ PHÁT HÀNH/);
    expect(sql).toMatch(/deploy ngay sau/);
  });
});

describe('nghiệm thu trong migration', () => {
  it('kiểm policy đã gỡ, quyền đã thu, trigger có mặt và đang bật', () => {
    expect(sql).toMatch(/FROM pg_policies/);
    expect(sql).toMatch(/FROM pg_trigger t/);
    expect(sql).toMatch(/t\.tgenabled <> 'D'/);
  });

  it('KHÔNG tự chèn dòng thử vào sổ', () => {
    // Trigger chặn luôn DELETE, nên một dòng thử sẽ không xoá được và ở lại
    // vĩnh viễn — phép nghiệm thu để lại rác trong chính thứ nó vừa tuyên bố là
    // bất biến thì tự mâu thuẫn.
    const khoiNghiemThu = sql.slice(sql.indexOf('DO $nghiem_thu$'));
    expect(khoiNghiemThu).not.toMatch(/INSERT INTO public\.ai_write_audit/);
  });

  it('thử sống trên dòng CÓ SẴN, và bỏ qua có báo khi sổ rỗng', () => {
    expect(sql).toMatch(/UPDATE public\.ai_write_audit SET entity_table = 'bi_sua'/);
    expect(sql).toMatch(/DELETE FROM public\.ai_write_audit WHERE id = v_id/);
    expect(sql).toMatch(/So audit dang rong — bo qua phep thu song/);
  });

  it('phân biệt "bị chặn bởi trigger này" với "bị chặn bởi thứ khác"', () => {
    // Bắt insufficient_privilege rồi coi là đạt sẽ xanh cả khi lỗi đến từ một
    // nguyên nhân hoàn toàn khác.
    expect(sql).toMatch(/GET STACKED DIAGNOSTICS v_loi = MESSAGE_TEXT/);
    expect(sql).toMatch(/v_loi NOT LIKE '%chi ghi them%'/);
  });
});

describe('đường lùi', () => {
  it('ghi đủ các bước khôi phục luồng cũ', () => {
    for (const buoc of [
      'DROP TRIGGER trg_ai_write_audit_bat_bien',
      'GRANT INSERT, UPDATE ON public.ai_write_audit TO authenticated;',
      'CREATE POLICY ai_write_audit_insert',
      'CREATE POLICY ai_write_audit_update_own',
    ]) {
      expect(sql, `rollback thiếu: ${buoc}`).toContain(buoc);
    }
  });
});
