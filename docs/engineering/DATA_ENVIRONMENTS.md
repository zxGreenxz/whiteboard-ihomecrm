# Môi trường dữ liệu

Đọc trước thao tác dữ liệu/quyền; [Project Contract](PROJECT_CONTRACT.md) §2 quy định giới hạn thao tác.

| Đích | ID/quyền |
|---|---|
| Org THẬT trong production | `aaaa0000-0000-4000-8000-000000000001`: chỉ đọc nghiệp vụ |
| Org DEMO trong production | `dddd0000-0000-4000-8000-000000000001`: fixture thử, tự dọn |
| Project TEST `ihomecrm-test` | Project Supabase riêng; ref trong vault, được thử dữ liệu/schema theo lane |

Mật khẩu TEST riêng; web Preview nhánh `test-env`. Bản sao có dữ liệu/tài khoản/vai trò, không có byte ảnh/file. Thử SQL bằng `npm run test-env:thu-sql -- <file>`.
Chỉ đọc nhanh: `npm run db:query -- --sql "<select…>" [--env test]` (READ ONLY, 30s, chặn từ khoá ghi); lệnh cần credential chạy qua `npm run with-cred -- <lệnh>` (nạp vault vào env con, không in).
Không dựng lại clone-org trong production. `sandbox_org_ids()` còn trả org TEST cũ `cccc0000-0000-4000-8000-000000000001` đã xoá; tới khi gỡ helper, bảng mới có `organization_id` cần policy `<bảng>_hide_sandbox_admin`, bọc phép so bằng `COALESCE(…, false)` để xử lý NULL.

Production có hai org (THẬT, DEMO) dùng chung database. Môi trường TEST là project Supabase
riêng mang bản sao dữ liệu thật — bảo vệ như dữ liệu thật; xem [test-env/README](../../scripts/test-env/README.md).

## Cơ chế cách ly cần kiểm

- `organizations.is_demo` là cờ phân loại, không tự cưỡng chế quyền.
- Membership, RLS và các hàm phân quyền quyết định tập dữ liệu người dùng được đọc.
- Policy `*_hide_demo_admin` nhận diện dữ liệu DEMO theo helper hiện hành;
  `*_hide_sandbox_admin` giấu sandbox theo org. Không coi hai họ policy là đồng nghĩa.
- Với `organization_id IS NULL`, dùng predicate xử lý NULL đúng; không để phép phủ định NULL
  giấu nhầm dòng hợp lệ.
- SECURITY DEFINER tự lọc toà bằng `can_access_building()` / `accessible_building_ids()`; không thêm lối tắt `is_super_admin() OR …`. RLS của bảng không thay kiểm quyền trong hàm.
- Kiểm truy vấn bằng role + JWT thật, gồm cả ca được phép và ca khác org bị chặn.
  Kết quả SELECT bằng postgres không chứng minh cách ly người dùng.

## Đồng bộ và xác minh

Ưu tiên thử tính năng trên project TEST. `npm run test-env:check -- --sync` tạo bản sao mới rồi
kiểm JWT/RLS và thao tác Chrome; `npm run test-env:check` dùng lại snapshot đạt còn mới, không
xoá dữ liệu mỗi lần sửa UI. Chỉ đồng bộ (không chạy JWT/RLS, Chrome): `npm run test-env:sync` (cùng
khoá chung, tự đối chiếu vân tay catalog và từng bảng). Xem [quy trình và cleanup](../../scripts/test-env/README.md).
Ngoại lệ dọn fixture: phiếu do lượt Chrome tạo được huỷ (CANCELLED/REVERSED) và ở lại TEST làm vết
kiểm toán tới lần `--sync` sau; report liệt kê chúng, không coi là đã xoá sạch.
Runner build mã nguồn của worktree bằng public config TEST, mở loopback, ghi SHA + digest nguồn,
kiểm build thực và chặn request production. Vault được đọc từ checkout chính, không sao chép.

Các spec fleet cũ dùng web Preview vẫn giữ giới hạn URL riêng: khoá `testchu`/`testquanly` trong
[auth.ts](../../.e2e-fleet/specs/auth.ts) chỉ chấp nhận nhánh `test-env`. Không chạy bộ fleet viết dữ
liệu song song với đồng bộ/runner TEST. DEMO dành cho fixture nhỏ hoặc kiểm tích hợp production
được chỉ định rõ; nó vẫn chung database với công ty thật.
Không đổi tài khoản/owner email để lách giới hạn org.

Cơ chế org TEST cũ (org sao chép `cccc…` trong chính database production, script `scripts/clone-org/`,
cổng `gate:sandbox-leak`) gỡ hẳn 23/09/2026 — xem lịch sử git nếu cần tra. Đừng dựng lại bản sao
trong database production: nó từng nhân đôi báo cáo và đẩy phiếu bàn giao sang nhầm công ty.

Đo rò rỉ giữa các org: truy vấn qua PostgREST bằng JWT của tài khoản thật (không phải role
`postgres`, vốn bỏ qua RLS) và phân biệt:

Staged diff chạm `supabase/migrations/**` phải có phép đo `scripts/measure-org-leak.mjs`
trong kế hoạch kiểm; thiếu credential cần cho phép đo là thiếu gate bắt buộc, không được
bỏ qua để push/apply. UI hoặc docs thuần không tự mở kết nối DB chỉ để chạy kiểm này.

| Kết quả | Ý nghĩa |
|---|---|
| Thấy dòng của org khác từ tài khoản không thuộc org đó | Rò rỉ, phải sửa |
| Không có GRANT SELECT (`42501`) | Bị chặn ở quyền bảng |
| Truy vấn khác lỗi hoặc danh sách đo không đủ | Chưa kiểm được; không phải pass |
| Không rò, đủ phép đo | Đạt trong phạm vi đã kiểm |

Số dòng trước/sau chỉ giúp phát hiện biến động, không thay phép đo rò.
Schema và dữ liệu có thể đổi ngoài Git: dùng catalog, SQL harness và evidence mới nhất.
