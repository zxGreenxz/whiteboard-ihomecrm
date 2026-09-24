# Môi trường dữ liệu

ID và quyền ghi của THẬT/DEMO/TEST nằm ở [Project Contract](PROJECT_CONTRACT.md) §2.
Production có hai org (THẬT, DEMO) dùng chung database. Môi trường TEST là project Supabase
riêng mang bản sao dữ liệu thật — bảo vệ như dữ liệu thật; xem [test-env/README](../../scripts/test-env/README.md).

## Cơ chế cách ly cần kiểm

- `organizations.is_demo` là cờ phân loại, không tự cưỡng chế quyền.
- Membership, RLS và các hàm phân quyền quyết định tập dữ liệu người dùng được đọc.
- Policy `*_hide_demo_admin` nhận diện dữ liệu DEMO theo helper hiện hành;
  `*_hide_sandbox_admin` giấu sandbox theo org. Không coi hai họ policy là đồng nghĩa.
- Với `organization_id IS NULL`, dùng predicate xử lý NULL đúng; không để phép phủ định NULL
  giấu nhầm dòng hợp lệ.
- SECURITY DEFINER phải tự kiểm scope; RLS của bảng không thay thế kiểm quyền trong hàm.
- Kiểm truy vấn bằng role + JWT thật, gồm cả ca được phép và ca khác org bị chặn.
  Kết quả SELECT bằng postgres không chứng minh cách ly người dùng.

## Đồng bộ và xác minh

Môi trường TEST đồng bộ bằng `npm run test-env:sync` (tự đối chiếu vân tay catalog và từng bảng);
fixture E2E ghi dữ liệu trên production dùng org DEMO. E2E bằng tài khoản thật chỉ chạy trên web TEST:
khoá `testchu`/`testquanly` trong [auth.ts](../../.e2e-fleet/specs/auth.ts) từ chối mọi
`FLEET_BASE_URL` khác web nhánh `test-env`; kiểm khói ở
[moi-truong-test.spec.ts](../../.e2e-fleet/specs/moi-truong-test.spec.ts).
Không đổi tài khoản/owner email để lách giới hạn org.

Cơ chế org TEST cũ (org sao chép `cccc…` trong chính database production, script `scripts/clone-org/`,
cổng `gate:sandbox-leak`) gỡ hẳn 23/09/2026 — xem lịch sử git nếu cần tra. Đừng dựng lại bản sao
trong database production: nó từng nhân đôi báo cáo và đẩy phiếu bàn giao sang nhầm công ty.

Đo rò rỉ giữa các org: truy vấn qua PostgREST bằng JWT của tài khoản thật (không phải role
`postgres`, vốn bỏ qua RLS) và phân biệt:

| Kết quả | Ý nghĩa |
|---|---|
| Thấy dòng của org khác từ tài khoản không thuộc org đó | Rò rỉ, phải sửa |
| Không có GRANT SELECT (`42501`) | Bị chặn ở quyền bảng |
| Truy vấn khác lỗi hoặc danh sách đo không đủ | Chưa kiểm được; không phải pass |
| Không rò, đủ phép đo | Đạt trong phạm vi đã kiểm |

Số dòng trước/sau chỉ giúp phát hiện biến động, không thay phép đo rò.
Schema và dữ liệu có thể đổi ngoài Git: dùng catalog, SQL harness và evidence mới nhất.
