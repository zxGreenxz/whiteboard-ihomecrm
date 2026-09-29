# Kiểm chứng hotfix lỗi tạo hoa hồng/thưởng Sale

**Trạng thái:** chờ review độc lập, phát hành schema/app và smoke production. Tài liệu này không xác nhận production đã nhận thay đổi.

## Mục tiêu và phạm vi

Hotfix lưu bằng chứng trước khi phát hành phiếu hoa hồng hoặc thưởng Sale, cho phép đối chiếu/tạo lại đúng yêu cầu đã lưu mà không nhân đôi phiếu. Lỗi chỉ hiện tại hai vị trí:

1. dưới hành động **Tạo phiếu hoa hồng** trong chi tiết hợp đồng trên desktop và mobile;
2. trong làn **Cần rà soát** hiện hữu của **Hợp đồng & quyết toán**.

Không có lần tạo thì không suy ra lỗi. Yêu cầu chỉ vào hàng đợi khi có lần thực thi đã ghi nhận lỗi, hoặc sau 5 phút vẫn chưa xác minh được kết quả. Không backfill lỗi cho hợp đồng cũ. Số lỗi tạo tách khỏi tổng tiền phiếu, tiền đã chi và công nợ.

## Bằng chứng source và kiểm thử hiện có

Các số đo dưới đây được ghi trực tiếp để checkout sạch không phụ thuộc báo cáo làm việc bị ignore. Chúng là bằng chứng source/TEST theo từng commit, chưa phải bằng chứng production.

| Phạm vi | Commit ứng viên | Lệnh/kết quả đã ghi |
|---|---|---|
| Backend, migration, retry và bộ đếm theo loại | `fc98a2f7` (gồm `fd260295`, fix lifecycle `8e0b4077`) | Focused SQL/boundary cuối: **30/30**; `scripts/test-commission-failure-retry.mjs --env test`: actual JWT/PostgREST trên TEST đã đạt ở vòng backend, và smoke bộ đếm read-only sau đó đạt **6 ca**; mutation bộ đếm làm suite đỏ rồi được khôi phục; `npm run typecheck:baseline`: **PASS, 0 fingerprint mới**; provenance migration: **PASS**. |
| UI hai vị trí, retry và phục hồi phân trang | `eafe50e1` (trên checkpoint `1ce0a4dd`) | `npx vitest run src/components/contracts/__tests__/ContractCommissionFollowupPanel.test.tsx src/components/contracts/__tests__/CommissionVoucherModal.test.tsx src/components/contracts/__tests__/ContractWorkspaceTabList.test.tsx src/components/contracts/__tests__/ContractDraftWorkspace.commission.test.tsx src/components/thu-tien/contract-settlement/__tests__/ContractSettlementSection.test.tsx src/components/contracts/detail/__tests__/ContractDetailView.mobileSettlement.test.tsx src/hooks/__tests__/useCreateCommissionVoucher.followup.test.tsx scripts/__tests__/commission-e2e-network.test.ts --maxWorkers=2`: **8 file, 135 test đạt**. Hai fixture source vừa chạm được chạy lại sau chỉnh dependency/EOF: **2 file, 72 test đạt**. `npx tsc --noEmit -p tsconfig.app.json`: exit 0 với types TEST tạm; targeted ESLint và `git diff --check`: exit 0. Build/bundle đạt ở checkpoint trước (`npm run build`: 4961 module; `npm run gate:bundle`: exit 0), chưa được gọi là lần build mới sau fix round 1. |
| Browser TEST mới nhất | `eafe50e1` | Popup strict: **đạt** — direct-create và draft-sign đều giữ popup, đóng popup tạo 0 commission request, unexpected console/network/production = 0, cleanup thành công. Core `--skip-settlement`: cả **5 kiểm tra hành vi đạt**, nhưng gate tổng vẫn **đỏ** vì 9 phản hồi HTTP 500/503 và console error tương ứng; một read v2 bị hủy đúng ranh giới reload được ghi riêng và không miễn các lỗi HTTP. Lần Settlement owner trước đó cũng vẫn **đỏ** vì các HTTP 500 từ reader cũ. Không có lần chạy lặp để lấy xanh. |

Types đang có trong worktree được sinh từ TEST và chứa thay đổi rent-support ngoài hotfix; không được commit hoặc dùng làm types production. E2E UI khỏe hoàn chỉnh, điều tra 9 lỗi HTTP, review độc lập và các gate toàn nhánh vẫn còn chờ controller.

## Vòng sửa ba finding của final review (base `4d01d1ba`)

Ý định QL nay được lưu bằng `manager_id` trong payload riêng của yêu cầu. Chỉ fresh canonical creation mới gọi assignment hiện hữu, trong cùng financial subtransaction, trước khi ghi COMPLETED; lỗi assignment rollback phiếu và giữ lỗi/yêu cầu để retry. ALREADY_EXISTS và receipt replay không gán lại manager/account. Không đổi quyền, công thức lương, duyệt hay posting. Modal tách loại đã lưu khỏi loại còn nhập mới: saved kind chỉ có Tạo lại đúng identity; fresh read đổi sang saved/processing sẽ chặn phần form xung đột.

Bằng chứng vòng sửa trên TEST `hzulujxgonszuleqticb`:

- RED trước source fix cho SQL manager payload, hook boundary và UI saved/new; GREEN **169 test / 9 file** tập trung. Log giữ cảnh báo Router và lỗi import động cố ý của bài error-boundary hiện hữu; không suy ra console browser sạch.
- Migration áp hai lần TEST; actual JWT **23/23** gồm canonical failure, assignment denial/rollback, cả broker/sale chọn manager khác nhau cạnh tranh, replay không đổi winner, interrupted/new-session retry và scope/redaction/cancellation/alias cũ. Hai mutation bỏ assignment hoặc cho assignment ở replay đều bị suite bắt đỏ, digest khôi phục. SQL SHA256: `2ae63fa284e2df5bc8af9314ab9ac88432c6e4311e9377f1fc8c49bcb20cadde`.
- Hai money gates chạy sau cleanup bằng full-scope owner JWT TEST: v1 **5.784.524.013 VND**, SQL = RPC = 1165 dòng phân trang; v2 **20 sổ thực**, 3741 posting / 4 trang, SQL = phân trang **2.684.308.004 VND**.
- Node **24.18.0** cho lượt xác minh cuối: typecheck baseline **0 fingerprint**, targeted ESLint sạch, build **4958 module**, bundle **564 chunk / entry 235 kB / 99 trang lazy**. Provenance official (SQL stage trước generator, production catalog chỉ đọc), RPC-cast, Copilot docs và truy vấn stable-fn-locks trên TEST đều đạt. Types TEST tạm không stage/commit.

Lượt JWT mở rộng đầu tiên thất bại do harness đọc sai tên cột posting và cleanup gọi sai tên bảng audit; đã giữ log lỗi, dọn exact-ID 12 hợp đồng/14 phiếu/2 manager users cùng configs/2 accounts trước chạy lại. Lượt sau đạt 23/23 và kiểm không còn fixture nghiệp vụ. Giữ nguyên **8 dòng audit append-only** tổng hai lượt, cùng guard/hash chain; không tuyên bố đã xóa mọi dòng và không tắt audit guard để dọn. Chi tiết IDs/RED/recovery/mutation/commands ở report làm việc `.superpowers/sdd/2026-09-29-commission-failure-retry/final-fix-report.md`.

Vòng này không chạy lại browser hoặc toàn bộ app unit. Kết quả E2E đỏ trước đó, scoped rereview ba finding, full suite/gates/release và production smoke còn chờ controller; các PASS trên không thay thế chúng.

## Smoke production chỉ đọc — chưa chạy

Sau khi controller xác nhận migration và app đã phát hành đúng cùng SHA, chạy từ root repo:

```powershell
$env:EXPECTED_PRODUCTION_SHA='<full-40-hex-sha>'
node outputs/commission-failure-retry/production-readonly-smoke.mjs --run-after-release
```

Script từ chối chạy nếu thiếu cờ hoặc SHA đầy đủ, so khớp thẻ `build-sha` trước đăng nhập, chỉ cho phép auth cần thiết, các REST read và danh sách RPC đọc đã duyệt (gồm `list_contract_commission_followups_v2`). Mọi business write bị chặn và làm gate đỏ. Script chọn một hợp đồng từ dữ liệu danh sách mà tài khoản hiện tại được phép đọc; không tạo lỗi, phiếu, hợp đồng hay fixture.

Phép kiểm dự kiến: không còn panel lỗi chung trên danh sách Hợp đồng desktop/mobile và Hợp đồng & quyết toán; chi tiết hợp đồng vẫn có hành động tạo bình thường; hợp đồng không có lần thử không bị bịa lỗi; làn Cần rà soát hiện hữu vẫn truy cập được. Console error, page error, HTTP 5xx, read failure hoặc write attempt đều làm smoke thất bại. Ảnh chụp được che dữ liệu động và chỉ lưu dưới thư mục ignored để controller kiểm trực quan.

Giới hạn: smoke không bấm **Tạo phiếu hoa hồng** hoặc **Tạo lại**, không xác minh mutation trên production và không chứng minh nhánh lỗi khi production không có lỗi thật. Kết quả chỉ có giá trị với SHA được truyền và tài khoản production đã cấp quyền đọc.

## Việc phát hành còn chờ

- review độc lập toàn nhánh và draft PR cho thay đổi tiền/schema;
- forward migration lane có backup trên SHA sạch đã review;
- sinh metadata/types từ production sau migration, chạy toàn bộ gate trước push và CI;
- promote đúng SHA, xác minh Vercel rồi mới chạy smoke chỉ đọc ở trên;
- ghi kết quả release/smoke thực tế vào đây, không đổi trạng thái sang đạt trước khi có bằng chứng.
