import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { chuKyHam, docSql, docSqlKhongComment, dongCoLike, thanHam } from "./helpers/sqlTestUtils";

// public.v5_run_digest() INSERT vào notifications mà không có organization_id.
// Trong công thức biên giới tổ chức của repo này organization_id IS NULL =
// "mọi công ty đều thấy", nên mỗi dòng digest là một lỗ rò xuyên tenant và
// scripts/measure-org-leak.mjs đỏ. Cron chạy 00:00 UTC nên vá chỉ-dữ-liệu
// (20260904005929) bị sinh lại mỗi sáng — file này ghim bản vá GỐC ở hàm ghi.
//
// Chỉ mục UNIQUE uq_notif_v5_digest cho đúng MỘT dòng digest mỗi người mỗi ngày,
// nên không thể ghi một dòng cho mỗi org: hàm phải chọn MỘT org tất định, và
// khi không quy được thì BỎ HẲN bản tin thay vì ghi dòng NULL.
const DUONG_DAN = "supabase/migrations/20260905082200_v5_digest_notification_organization_id_v1.sql";
const sql = docSqlKhongComment(resolve(process.cwd(), DUONG_DAN));
const sqlCoComment = docSql(resolve(process.cwd(), DUONG_DAN));
const than = thanHam(sql, "v5_run_digest");

describe("v5_run_digest: digest phải mang organization_id, không quy được thì không gửi", () => {
  it("file tồn tại và chạy trong đúng một transaction", () => {
    expect(sql).not.toBe("");
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("CREATE OR REPLACE, KHÔNG drop — giữ ACL và mọi phụ thuộc", () => {
    expect(than).not.toBe("");
    expect(sql).not.toMatch(/DROP\s+FUNCTION[\s\S]{0,40}v5_run_digest/i);
  });

  it("giữ nguyên chữ ký, RETURNS TABLE, SECURITY DEFINER và search_path", () => {
    expect(chuKyHam(sql, "v5_run_digest")).toBe("");
    expect(than).toMatch(/RETURNS TABLE\(\s*user_id uuid,\s*title text,\s*body text,\s*url text\s*\)/i);
    expect(than).toMatch(/LANGUAGE plpgsql/i);
    expect(than).toMatch(/SECURITY DEFINER/i);
    expect(than).toMatch(/SET search_path = public/i);
  });

  it("quy thuộc tổ chức: toà của việc ĐẦU TIÊN trong tuyến", () => {
    expect(than).toMatch(/IF v_cnt = 1 THEN v_toa_dau := v_m\.building_id; END IF;/);
    expect(than).toMatch(
      /SELECT b\.organization_id INTO v_org FROM public\.buildings b WHERE b\.id = v_toa_dau/,
    );
  });

  it("dự phòng: chỉ lấy membership khi người đó thuộc ĐÚNG MỘT tổ chức ACTIVE", () => {
    expect(than).toMatch(
      /organization_memberships om[\s\S]{0,200}om\.status = 'ACTIVE'[\s\S]{0,200}HAVING count\(\*\) = 1/i,
    );
  });

  it("INSERT mang organization_id — và KHÔNG còn dạng cột cũ thiếu org", () => {
    expect(than).toMatch(
      /INSERT INTO public\.notifications \(user_id, organization_id, type, channel, status, subject, content, metadata\)/,
    );
    expect(than).toMatch(/VALUES \(v_staff\.staff_id, v_org, 'CUSTOM', 'IN_APP', 'PENDING'/);
    expect(than).not.toMatch(/INSERT INTO public\.notifications \(user_id, type,/);
  });

  it("không quy được tổ chức thì CONTINUE + RAISE NOTICE, tuyệt đối không ghi dòng NULL", () => {
    expect(than).toMatch(/IF v_org IS NULL THEN[\s\S]{0,400}RAISE NOTICE[\s\S]{0,400}CONTINUE;[\s\S]{0,40}END IF;/);
    // Nhánh bỏ phải nằm TRƯỚC câu INSERT, nếu không dòng NULL vẫn được ghi.
    expect(than.indexOf("IF v_org IS NULL THEN")).toBeGreaterThan(-1);
    expect(than.indexOf("IF v_org IS NULL THEN")).toBeLessThan(
      than.indexOf("INSERT INTO public.notifications"),
    );
  });

  it("giữ nguyên phần còn lại: bỏ Chủ Nhật, bỏ ngày phép, dedup, RETURN NEXT", () => {
    expect(than).toMatch(/IF EXTRACT\(dow FROM v_today\) = 0 THEN RETURN; END IF;/);
    expect(than).toMatch(/salary_attendance_day[\s\S]{0,200}'leave_approved','pending_leave'/);
    expect(than).toMatch(/EXCEPTION WHEN unique_violation THEN CONTINUE;/);
    expect(than).toMatch(/user_id := v_staff\.staff_id;/);
    expect(than).toMatch(/title := 'Tuyến hôm nay: ' \|\| v_cnt \|\| ' toà nên ghé';/);
    expect(than).toMatch(/body := v_lines;/);
    expect(than).toMatch(/url := '\/my-day';/);
    expect(than).toMatch(/RETURN NEXT;/);
  });

  it("ACL phát lại đúng như production: anon/authenticated bị thu, service_role được EXECUTE", () => {
    expect(sql).toMatch(
      /^REVOKE ALL ON FUNCTION public\.v5_run_digest\(\) FROM PUBLIC, anon, authenticated;$/m,
    );
    expect(sql).toMatch(
      /^GRANT EXECUTE ON FUNCTION public\.v5_run_digest\(\) TO service_role;$/m,
    );
  });

  it("vá dữ liệu hai tầng, cả hai chỉ chạm dòng NULL nên chạy lại là 0 dòng", () => {
    const capNhat = sql.match(/UPDATE public\.notifications n\s*\n\s*SET organization_id = m\.organization_id/g);
    expect(capNhat).toHaveLength(2);
    // Tầng A — org của toà được phân công, chỉ áp cho dòng digest.
    expect(sql).toMatch(
      /staff_assignments sa[\s\S]{0,300}HAVING count\(DISTINCT b\.organization_id\) = 1[\s\S]{0,300}\(n\.metadata->>'v5'\) = 'digest'/i,
    );
    // Tầng B — nguyên luật của 20260904005929.
    expect(sql).toMatch(
      /organization_memberships om[\s\S]{0,300}om\.status = 'ACTIVE'[\s\S]{0,200}HAVING COUNT\(\*\) = 1/,
    );
    // 3 lần: hai UPDATE (chốt idempotent) + câu đếm trong khối nghiệm thu.
    expect(sql.match(/WHERE n\.organization_id IS NULL/g)).toHaveLength(3);
  });

  it("nghiệm thu chỉ đọc catalog, ghim organization_id trong prosrc và chặn dòng NULL còn quy được", () => {
    expect(dongCoLike(sql).some((d) => d.includes("'%organization_id%'"))).toBe(true);
    expect(sql).toMatch(/v_src NOT LIKE '%v_org IS NULL%' OR v_src NOT LIKE '%CONTINUE%'/);
    expect(sql).toMatch(/pg_get_function_identity_arguments/);
    expect(sql).toMatch(/'TABLE\(user_id uuid, title text, body text, url text\)'/);
    expect(sql).toMatch(/has_function_privilege\('anon', 'public\.v5_run_digest\(\)', 'EXECUTE'\)/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Con % dong notifications organization_id NULL/);
  });

  it("an toàn trên DB rỗng: mọi thứ chạm bảng/role đều sau to_reg* guard", () => {
    expect(sql).toMatch(/to_regclass\('public\.notifications'\) IS NULL/);
    expect(sql).toMatch(/to_regclass\('public\.staff_assignments'\) IS NULL/);
    expect(sql).toMatch(/to_regprocedure\('public\.v5_run_digest\(\)'\) IS NOT NULL/);
    expect(sql).toMatch(/to_regrole\('anon'\) IS NOT NULL/);
  });

  it("header ghi lại quyết định và lý do trigger autofill không cứu được", () => {
    expect(sqlCoComment).toMatch(/KHÔNG QUY ĐƯỢC TỔ CHỨC THÌ KHÔNG GỬI/);
    expect(sqlCoComment).toMatch(/a90_autofill_org/);
    expect(sqlCoComment).toMatch(/autofill_pre_notification_v1/);
    expect(sqlCoComment).toMatch(/single_org_of_user_v1/);
    expect(sqlCoComment).toMatch(/KHÔNG có JWT/);
    expect(sqlCoComment).toMatch(/uq_notif_v5_digest/);
  });
});
