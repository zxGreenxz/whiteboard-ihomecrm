# Theo dõi hoa hồng và thưởng Sale sau ký

> Thực hiện trong phiên hiện tại bằng superpowers:subagent-driven-development; review độc lập theo Project Contract cho migration và tiền.

**Mục tiêu:** Sau khi ký, giữ màn tạo phiếu; nếu đóng màn, tải lỗi, tạo lỗi hoặc mất phản hồi, hợp đồng và khu Hợp đồng & quyết toán vẫn chỉ ra khoản chưa được xử lý và có đường tiếp tục, không tạo trùng hoặc coi đã tạo phiếu là đã trả tiền.

**Thiết kế được chọn trong phạm vi yêu cầu:** Bản ghi kiểm soát lưu trên máy chủ cộng với đối chiếu phiếu đang tồn tại. Chỉ toast/localStorage không đủ khi đổi máy hoặc người khác xử lý. Tự sinh hai phiếu chi chưa phù hợp vì người nhận và mức thưởng Sale có thể chưa biết. Mỗi hợp đồng được xét riêng broker/sale; vắng phiếu và vắng quyết định không phát sinh là chưa xử lý, không tự suy thành một khoản nợ đã xác nhận.

**Stack:** React, TanStack Query, Supabase/PostgreSQL, Vitest/PGlite, Playwright.

## Ràng buộc

- Dữ liệu org thật chỉ đọc; kiểm thử ghi chỉ DEMO hoặc project TEST. Không đổi công thức tiền hay áp lịch hỗ trợ tiền thuê trong thay đổi này.
- Phiếu hiện có, kể cả thưởng Sale qua phiếu cọc, là nguồn thật để chống trùng. Trạng thái tạo phiếu và trạng thái duyệt/chi tách biệt.
- Không nuốt lỗi tải thành danh sách rỗng. Ghi nhận bắt đầu trước khi gọi tạo phiếu; nếu không ghi được thì dừng tạo và thông báo. Lỗi lưu kết quả không làm mất dấu bắt đầu.
- Đóng popup giữ việc chưa xử lý. Đánh dấu không phát sinh bắt buộc lý do và ghi người/thời điểm. Có thể mở lại quyết định.
- Phân quyền theo org/toà và quyền miền; không có lối tắt super admin. Không sửa generated types bằng tay.
- Mutation và UI phải kiểm partial success: môi giới thành công nhưng Sale lỗi thì giữ phiếu môi giới, chỉ tiếp tục khoản thiếu.
- Draft PR bắt buộc; không promote khi thiếu gate/evidence. Commit có trailer Codex.

## Task 1: Lưu dấu và đọc trạng thái an toàn

- [x] Viết test SQL hành vi trước, chạy đỏ.
- [x] Migration mới với bảng `contract_commission_events` append-only, action `ATTEMPTED`, `FAILED`, `NOT_APPLICABLE`, `REOPENED`; duy nhất `(organization_id,contract_id,kind,request_id,action)`. Lưu actor/time/amount đề nghị/reason; không chép tài khoản ngân hàng.
- [x] RPC `record_contract_commission_event_v1(p_organization_id uuid,p_contract_id uuid,p_kind text,p_action text,p_request_id uuid,p_amount numeric default null,p_reason text default null)`; validate scope, action, số tiền hữu hạn, lý do bắt buộc cho FAILED/NOT_APPLICABLE, idempotency; không cho che phiếu sống bằng NOT_APPLICABLE.
- [x] RPC `list_contract_commission_followups_v1(p_organization_id uuid,p_contract_ids uuid[] default null,p_building_ids uuid[] default null,p_offset integer default 0,p_limit integer default 50,p_unresolved_only boolean default false)` trả `{rows,total}`. Rows gồm contract_id/contract_number/building_id/building_name/room_name/kind/state/last_reason/last_at/last_actor/attempted_amount/voucher_id/voucher_code/voucher_status/events. State `PENDING`, `UNKNOWN`, `FAILED`, `NOT_APPLICABLE`, `VOUCHER_CREATED`; ATTEMPTED chưa có phiếu → UNKNOWN. Phiếu sống thắng event; phiếu hủy/xóa không được coi hoàn tất; thưởng Sale qua cọc được nhận diện.
- [x] Đọc đầy đủ tổng và pagination, không lấy trang đầu làm tổng; contracts cũ không có event vẫn hiện PENDING thay vì tự kết luận lỗi.
- [x] Test role thật, cách ly org/toà, retry, immutable audit; thử migration TEST và sinh types bằng generator.

## Task 2: Ghi dấu khi tạo và giao diện theo dõi

- [x] Test boundary DTO, lỗi ghi bước bắt đầu, tạo thành công, thất bại, mất phản hồi và partial success.
- [x] `src/lib/contractCommissionFollowup.ts`: Zod DTO và wrapper RPC typed. `src/hooks/useContractCommissionFollowup.ts`: query/mutation, query key theo org, invalidation.
- [x] Bọc `useCreateCommissionVoucher` bằng ATTEMPTED trước lời gọi và FAILED sau lỗi. Không retry ngầm create. UI yêu cầu người dùng đối chiếu phiếu nếu kết quả chưa rõ.
- [x] `ContractCommissionFollowupPanel`: 2 loại khoản, trạng thái, lý do/thời điểm, nút mở lại modal, không phát sinh có lý do, lịch sử. Loading/error rõ ràng.
- [x] Đặt panel trên chi tiết hợp đồng desktop/mobile; danh sách việc cần kiểm tra có phân trang trên trang hợp đồng và Hợp đồng & quyết toán; giữ đúng bộ lọc toà. Không cộng khoản chưa xác nhận vào tổng tiền phải trả.
- [x] Sửa chữ “Đã chi” của banner phiếu hiện có thành “Đã có phiếu”; chỉ hiển thị trạng thái duyệt, không suy thanh toán.

## Task 3: Sửa vòng đời popup và xác minh

- [x] Chuyển regression đã tái hiện vào test repo: ký từ ContractDraftWorkspace vẫn mở hoa hồng; tải lại kết quả ký sau mất mạng cũng tiếp tục được.
- [x] Giữ component/form hoặc nâng state popup lên vị trí sống sau editor; popup không mất do đóng form.
- [x] Test liên quan, typecheck baseline, build/bundle, E2E headless DEMO/TEST và console errors.
- [x] Sau rollout schema production, sinh lại types/surface/provenance; full pre-push đạt 44 gate, gồm strict, lint và đo rò org.
- [x] Draft PR #94 đã được review độc lập; migration và artifact rollout đã kiểm lại. Promote web còn phụ thuộc CI đúng SHA trên main và kiểm deployment.

## Tiến độ

Đã sửa lỗi unmount của workspace và callback sau khôi phục ký. Có dấu ATTEMPTED trước khi gọi tạo tiền; lỗi và quyết định được giữ trên server, từng khoản được đối chiếu với phiếu sống. Không thay công thức hoa hồng, lịch hỗ trợ thuê hoặc tự sinh khoản nợ từ hợp đồng cũ.

## Bằng chứng ngày 29/09/2026

- 168 test liên quan đạt trước tối ưu; SQL cuối mở rộng 18 lên 20 ca đạt, độc lập review SQL 20 + modal 8 đạt.
- Typecheck baseline 0 lỗi, cả hai strict islands đạt với types sinh từ schema TEST; types normalize/check đạt. CLI không nhận định dạng PAT TEST nên dùng API introspection chính thức, qua writer atomic của generator. Types TEST còn phản ánh một số cột bổ sung của các nhánh khác đã có trên môi trường này.
- Build và bundle đạt: entry khoảng 235 kB, 99 trang lazy có chunk riêng. Gate tiền v1 đối chiếu 1.171 phiếu trên 2 trang khớp SQL/RLS; v2 đối chiếu 20 sổ và 3.768 posting khớp.
- Browser TEST thật: danh sách desktop/mobile, chi tiết, quyết toán, phân trang, mở tiếp phiếu; không console/network error hoặc request production trong một lượt đọc đầy đủ.
- Fixture TEST: lưu/mở nháp, ký thật và popup còn hiện; giả lập 503 trước writer, ATTEMPTED/FAILED được lưu thật và hiện sau reload; quyết định không phát sinh Sale có lý do được lưu thật. Không tạo hóa đơn/phiếu tiền trong fixture này. Hạn chế: tài liệu ký dùng metadata mẫu, chưa kiểm byte/upload/download DOCX.
- SQL tối ưu từ lỗi timeout thực tế 57014 xuống khoảng 0,5–1 giây cho 678 khoản; scope tính một lần mỗi quyền/tòa, ưu tiên UNKNOWN/FAILED trước dữ liệu cũ.
- Review độc lập bắt và sửa hai lỗi: lộ số tiền/lý do khi phiếu bị RLS sổ quỹ ẩn; phản hồi A ảnh hưởng popup B. Mutation kiểm audit trước writer, partial success, idempotency/quyền/phiếu hủy/redaction; đều đỏ khi phá và khôi phục digest.
- Full pre-push chạy đủ, gồm measure-org-leak đạt. Hai mục đỏ ban đầu: thiếu provenance (đã sinh và kiểm đạt); production generator chưa có 2 RPC (đã giữ types TEST để branch typecheck được; vẫn là blocker trước production). Catalog production khớp inventory, không apply schema production.

Bằng chứng cục bộ ở outputs/commission-followup/; không commit screenshot/dữ liệu thử. Migration cần review và rollout đúng lane trước khi ứng dụng production dùng các RPC mới.

Kiểm bổ sung: 5/5 test hook đạt, gồm phản hồi tạo phiếu sai cấu trúc phải lưu lỗi để đối chiếu và không tự tạo lại; thông báo không lộ cấu trúc kiểm tra kỹ thuật.

JWT TEST thật: 9 ca owner/outsider/concurrency đạt; quản lý được giới hạn đúng 9 tòa, ngoài phạm vi đọc rỗng và ghi 403. Catalog TEST kiểm 8 hàm, không có quyền anon hoặc SELECT/DML trực tiếp trên audit.

Lượt smoke mở rộng cuối ghi nhận timeout 57014 ở các reader dữ liệu tòa/phí/quyết toán hiện có; RPC theo dõi hoa hồng mới vẫn trả 200. Một lượt browser đầy đủ trước đó sạch lỗi. Chưa xác minh nguyên nhân timeout này, nên không kết luận toàn trang quyết toán luôn ổn định.

## Rollout schema production 29/09/2026

Theo yêu cầu phát hành của người dùng, forward lane chạy dry-run và hai lượt idempotency trong ROLLBACK, rồi tạo backup full 27,2 MB/566 bảng trước apply. Receipt `docs/generated/schema-change-evidence/20260929130117_contract_commission_followups.json` ghi digest, actor, bản review và catalog trước/sau. Review độc lập kiểm cả hash file backup thực tế.

Types đã sinh lại từ production, bỏ các cột/hàm chỉ có ở TEST; RPC surface không còn missingOnServer. Kiểm production chỉ đọc: 8 hàm khớp thân SQL đã review và catalog TEST, owner/search_path/volatility/ACL đúng; audit RLS và trigger bất biến đúng. JWT chủ tổ chức đọc 20/682 khoản trong 247 ms; hợp đồng khác org không xuất hiện; org không có quyền và bảng audit trả 403. Không ghi dữ liệu nghiệp vụ org thật.

Lượt kiểm cuối: 59/59 test tập trung đạt; baseline TypeScript 0 lỗi; full pre-push 44 gate đạt trong 254 giây. Reconcile v1 1.171 phiếu/2 trang khớp 5.799.257.813 VND; v2 20 sổ và 3.768 posting khớp. Bằng chứng cục bộ: `outputs/commission-followup/release-*.log` và `production-readonly-report.json`. Kết quả này xác nhận schema; chưa thay cho CI và smoke của bản web sau promote.
