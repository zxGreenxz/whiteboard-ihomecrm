# Bằng chứng thi hành — Hợp đồng & quyết toán

Ngày chốt bằng chứng: 21/09/2026

Nhánh: `codex/hop-dong-quyet-toan`

Release candidate giao diện: `b2935a56`

## Kết quả sản phẩm

- `/thanh-toan` trên desktop có khu **Hợp đồng & quyết toán** theo HTML đã duyệt: khung 1.180 px, hai tab Khoản chi/Biến động, thẻ tổng hợp, bộ lọc, bảng và modal vòng đời lớn.
- Ba nguồn Hoàn khách, Hoa hồng và Thưởng sale dùng chung action policy, dialog và các writer của Thu chi. Các entrypoint và modal cũ tại Thanh toán đã bị gỡ.
- Nguồn chưa có phiếu dùng **Lập phiếu chờ duyệt**. Phiếu `CHANGES_REQUESTED` dùng **Chuyển chờ duyệt**, giữ nguyên phiếu và chỉ thực hiện chuyển trạng thái review qua RPC dùng chung.
- Tab Biến động đọc đủ năm nhóm Ký mới, Gia hạn, Thanh lý, Bỏ cọc và Giữ chỗ. Modal trình bày các lane hợp đồng theo phòng và tách số liệu dòng tiền đã kiểm chứng khỏi số liệu chưa xác minh.
- Mobile giữ màn Tổng quan kỳ an toàn; workbench rộng không mount trên mobile trong release này.

## Dữ liệu, quyền và machine tiền

- 15 migration của feature đã đi qua reviewed migration lane, có provenance và schema-change evidence trong `docs/generated/schema-change-evidence/`.
- Reader, snapshot/capability action, review transition, sửa người nhận, nguồn thưởng sale và hoàn giữ chỗ đều scope theo tổ chức và dùng quyền/custody của Finance V2.
- Các adapter tạo nguồn chỉ lập phiếu chờ duyệt; không truyền sổ mặc định để tránh nhánh hoa hồng tự duyệt/tự ghi chi cũ.
- Harness tiền đã kiểm create-only, khóa nguồn chống trùng, posting/reversal và đối chiếu tiền theo voucher. Catalog/type/RPC/realtime/ACL, definer-body authorization, stable function lock và sandbox leak đã đạt trong vòng kiểm schema.
- Production schema đã nhận đủ migration trước khi phát hành frontend. Việc đưa bundle ứng dụng lên production được ghi bổ sung sau bước promote.

## Kiểm thử và đối chiếu giao diện

| Nhóm | Kết quả | Bằng chứng chính |
|---|---:|---|
| Unit/component/hook mục tiêu | **Đạt 281/281**, 37 file | Reader, mapper, source create, timeline, modal, shared actions, review, recipient, reservation refund |
| TypeScript baseline | **Đạt** | 0 fingerprint mới |
| `tsc -p tsconfig.app.json --noEmit` | **Đạt** | exit 0 |
| `typecheck:e2e` | **Đạt** | exit 0 |
| Build production | **Đạt** | 4.905 module, build 15,42 giây |
| Bundle gate | **Đạt** | 529 chunk, entry 232 kB, tổng 8,40 MB, 97 trang lazy |
| E2E khu mới trên local build | **Đạt 7/7** | Desktop, mobile fallback, 3/4 thẻ, bộ lọc, 5 biến động, modal dữ liệu DEMO, route/back |
| E2E reservation liên quan | **Đạt 6/7** | Ca còn lại đạt UI và đối chiếu tiền nhưng bị console error do truy vấn `deposits.refundsForfeits` timeout `57014` |
| So ảnh với HTML duyệt | **Đạt về bố cục chính** | Khung 1.180 px tại x=130/y=24 ở viewport 1.440×1.000; header, radius, shadow và mật độ bảng đã được đối chiếu |

Ảnh đối chiếu cục bộ của release candidate:

- [Tổng quan app](assets/contract-settlement-overview-final.png)
- [Modal vòng đời app](assets/contract-settlement-modal.png)
- [HTML thiết kế đối chiếu](assets/contract-settlement-design-workbench.png)

## Gate trước push và giới hạn còn lại

`npm run gate:truoc-push` đạt toàn bộ gate nguồn liên quan đến feature, gồm capability surfaces, route/permission, workflow paths, RPC callers, realtime keys, money-table DML, migration provenance, promote readiness, strict islands và ESLint baseline. Gate tổng trả exit 1 vì báo cáo **Copilot negative-proofs** của tính năng khác đã 17,6 ngày tuổi, vượt hạn 14 ngày.

Hai giới hạn không được coi là bằng chứng feature lỗi:

1. Một ca reservation Realtime gặp timeout truy vấn production `57014`; mutation, state UI và đối chiếu tiền của ca đó vẫn đạt và fixture được dọn.
2. Suite Finance V2 cũ phụ thuộc fixture tên `CANARY renamed` không còn trong DEMO và có các giả định role/scope cũ. Không sửa suite đó trong feature này; shared action machine được bao phủ bởi unit/component tests mới và harness tiền.

Các generator cần PAT từng báo cảnh báo khi chạy từ worktree không chứa vault. Trước đó, cùng nhánh đã chạy catalog/types/RPC/realtime và ACL với PAT trên production sau khi áp dụng migration. Không có secret nào được ghi vào repo hoặc artifact.

## Dữ liệu thử

- Các phòng reservation mang marker E2E của lần chạy này đã được dọn; trigger ownership được trả về mode production `O`.
- Phiếu `[E2E-V2]` tạm đã được huỷ bằng đúng ID; không xoá broad theo tên hoặc theo tổ chức.
- Không ghi thử vào tổ chức thật; harness mutation chỉ dùng tổ chức DEMO.

## Review

- Review thiết kế độc lập: đạt sau khi khôi phục đúng khung HTML và semantics hai action lập/gửi lại phiếu.
- Review ACL và luồng tiền: đạt sau khi đóng các khoảng trống review recovery, canonical workflow, sale-source consistency và reservation refund pending.
- Draft PR và trạng thái phát hành production sẽ được liên kết ở lần cập nhật cuối của tài liệu này.
