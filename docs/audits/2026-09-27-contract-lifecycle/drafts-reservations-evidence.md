# Nháp, giữ chỗ và ký trước ngày nhận: bằng chứng và thiết kế để audit

Ngày rà: 27/09/2026. Mốc source: `e498f10d49f3548e72074095c955371d0cee41ab`. Đây là **plan, chưa triển khai**. Đã đọc `docs/engineering/PROJECT_CONTRACT.md`; không đọc vault, gọi production, thử migration hay ghi dữ liệu nghiệp vụ. Đường dẫn bên dưới tương đối từ root repository; hậu tố `:n` là dòng source tại mốc này. Baseline chụp 06/08 chỉ là bằng chứng lịch sử, không chứng minh catalog hiện chạy. Worktree đã có thay đổi ngoài phạm vi tại `supabase/migrations/20260528000007_drop_beds_fix_rpcs.sql`; tác giả tài liệu không sửa hoặc dùng diff đó làm bằng chứng.

## 1. Kết luận thiết kế

Chọn **aggregate nháp riêng**, gồm bản nháp, các revision bất biến và artifact xuất. Người dùng nhập đầy đủ một lần, lưu, mở lại, tải DOCX gửi khách; nháp không cấp quyền sử dụng phòng, không có phiếu tiền, hóa đơn, cư trú hoặc hoa hồng. Giữ chỗ và nhận cọc là hành động riêng, có reservation và khách xác định. Xác nhận thực ký chuyển đúng revision thành hợp đồng; không bắt nhập lại.

Hợp đồng ký trước ngày vào có `SIGNED_WAITING`; chỉ xác nhận nhận phòng thực tế mới tạo occupancy. Cam kết khoảng thuê tương lai phải chặn ký chồng dù phòng hiện vẫn trống. `signed_date`, khoảng thuê, `billing_start` và `actual_move_in_at` là bốn dữ kiện riêng. Không suy ngày thu tiền hoặc ngày tính tiền từ ngày ký hay ngày bấm nhận phòng.

Không chọn `contracts.status=DRAFT` làm kho nháp mới: bảng đã có nhiều trigger, reader kiểm bằng phủ định và writer legacy. Tránh các tác dụng phụ đòi hỏi thay hàng loạt trước khi lưu được một nháp an toàn. Nháp riêng giảm bề mặt đó nhưng **không miễn** audit `SIGNED_WAITING` khi chuyển thành hợp đồng. Không tự chuyển các dòng DRAFT cũ sang mô hình mới: phải kiểm dữ liệu, tiền và nguồn giấy từng nhóm trước. Tên/schema/API chính thức của plan nằm tại `docs/superpowers/plans/2026-09-27-contract-lifecycle.md` §3–4; tên trong evidence này chỉ để diễn giải, không tạo specification song song.

## 2. Bằng chứng source hiện tại

### Writer tạo hợp đồng

`supabase/migrations/20260721090000_contract_create_v2.sql` là định nghĩa nền của `create_contract_v2(jsonb,text)`:

| Neo | Hành vi đã đọc |
|---|---|
| `:498`, `:508`, `:514`, `:517` | Khóa phòng, khóa quyết định org, kiểm `contracts.create` theo tòa. |
| `:523`, `:530`, `:540`, `:542`, `:545` | Operation lưu hash payload, actor, scope phòng/ngày; khóa operation; replay cùng payload, từ chối key khác nội dung. |
| `:549`, `:562` | Chỉ nhận phòng AVAILABLE/RESERVED và từ chối ACTIVE hiện hữu. |
| `:571`, `:577` | Hết hạn hold bằng thời gian server; chặn hold sống của **nhân viên khác**. |
| `:599`, `:638` | Khóa khách theo UUID, kiểm org; kiểm template org/category/active. |
| `:683`, `:691`, `:704` | Luôn tạo ACTIVE, sau đó tạo `contract_customers` và dịch vụ. |
| `:729`, `:751` | Gắn các voucher ID rõ ràng; bảng link có UNIQUE voucher tại `:19`. |
| `:814`, `:830`, `:843` | Ghi phiếu cọc APPROVED, dòng DEPOSIT rồi tính lại `deposit_paid`. |
| `:850`, `:855`, `:940` | Kiểm dư/thiếu cọc; DEBT hoặc FIRST_INVOICE; dòng cọc phải đúng phần thiếu. |
| `:979`, `:987`, `:1032` | Hóa đơn đầu APPROVED; claim operation tính tiền mới nhận cộng tổng hóa đơn. |
| `:1035`, `:1042` | Consume hold bằng phòng + nhân viên; cập nhật phòng OCCUPIED ngay. |

Đây không phải API lưu nháp. Truyền `status=DRAFT` trong payload cũng không thay literal ACTIVE. `contracts_one_active_per_room_uq` tại `:99` bảo vệ một ACTIVE/phòng, chưa chứng minh chống hai hợp đồng chờ ký có khoảng thuê giao nhau.

Định nghĩa deployed không được ghép bằng suy đoán thứ tự filename: migration `20260731130000_create_contract_link_deposit_flex.sql:104` vá function từ catalog; `20260909172332_reservation_deposit_settlement_v1.sql:614` thêm loại phiếu đã quyết toán vào cùng writer. Catalog preflight là gate bắt buộc.

### Cọc và giữ chỗ

`src/components/contracts/contract-form/useContractFormState.ts:230` tìm cọc theo phòng/ngày, `:234` cộng tất cả phiếu APPROVED. `useContractSubmit.ts:332` tự truyền toàn bộ ID APPROVED. SQL `20260721090000_contract_create_v2.sql:730` kiểm org/phòng/chưa gắn/loại tiền nhưng chưa kiểm customer hoặc reservation. **Có ID rõ ràng chưa đồng nghĩa chọn đúng khách**; cùng phòng có hai khách thì không được dùng tổng của phòng.

`src/components/deposits/CreateDepositDialog.tsx:233` đặt hold trước; `:235` khách legacy là tùy chọn; `:292` mới tạo phiếu cọc có `contract_id=null`. `src/lib/reservationHold.ts:26` ép amount tối thiểu 1; `:35` coi mọi `23505` là được tiếp tục; `:56` bỏ qua lỗi chưa deploy/quyền/writer và `:59` bắt lỗi mạng. Đây là **fail-open hiện hữu**, không được sao chép cho luồng mới. Không dùng phiếu 1đ để giả giữ chỗ không tiền.

Phân biệt helper và caller: helper trên chỉ đặt hold; riêng `src/pages/phong-trong/QuickDepositModal.tsx:112` dùng `unitPrice=1` khi tiền trống/không hợp lệ rồi `:145` gọi `createIE.mutateAsync`, dòng `:165` truyền số đó vào phiếu. Vì vậy đường QuickDeposit hiện có hành vi tạo phiếu 1đ thật ở tầng gọi, không chỉ amount tượng trưng trên hold.

Baseline `supabase/baseline/schema.sql:59272` cho thấy RPC tên “create_reservation_deposit” thực ra chỉ tạo hold 24 giờ (`:59324`), không tạo phiếu thu. Constraint `:125869` là EXCLUDE trên room và `tstzrange(held_at,expires_at)`, áp dụng PENDING_APPROVAL/APPROVED. Nó bảo vệ thời gian khóa thao tác, không phải khoảng thuê. Phải đọc catalog để biết constraint hiện tại và trạng thái consume/expiry thật.

Không nhầm hạn khóa này với kỳ hạn nghiệp vụ: `src/hooks/useReservationHoldDeadlines.ts:11` phân biệt hạn ký và hạn bổ sung cọc; `:59` đã fail-closed khi đọc lỗi. Hết khóa không tự hoàn/đốt cọc; giải quyết tiền theo reservation settlement, giữ nguyên chứng từ gốc.

### Tác dụng phụ và reader phải đổi

| Bề mặt | Neo source và hệ quả cần audit |
|---|---|
| Phòng/tài sản | `20260915144610_trang_thai_phong_theo_hop_dong_definer.sql:48`, `:83` đặt OCCUPIED theo ACTIVE/EXTENDED, không theo thực nhận. Baseline `schema.sql:145820` gắn trigger tài sản khi đổi status. |
| Số hợp đồng/QR/giá | `20260915144507_so_hop_dong_chong_dua.sql:210` cấp số khi insert; baseline `:145443` cấp public code; `20260728180000_room_price_history.sql:227` ghi lịch sử giá khi insert. Nháp không được chạm những trigger này. |
| Khách đang thuê | `src/types/contract.ts:170` chỉ ACTIVE; `src/hooks/useCustomers.ts:226`, `src/hooks/useTenants.ts:231`, `src/hooks/useRoomsWithContracts.ts:78` dựa hợp đồng ACTIVE. Tư cách bên ký và cư trú thực tế phải tách. |
| Bộ lọc/báo cáo | `src/hooks/useContracts.ts:329` loại TERMINATED/TRANSFERRED/DRAFT bằng phủ định; `src/hooks/reports/realEstateReports.ts:895` lấy mọi non-DRAFT. Thêm status sẽ lọt nhầm nếu không phân loại. |
| Lập hóa đơn | Form `useContractSubmit.ts:335` gửi first_invoice; billing writer nền nêu trên lập ngay. Mọi generator/query chọn ACTIVE cần lịch tính tiền dành cho hợp đồng chờ nhận. |
| Hoa hồng | `20260708130400_get_period_commissions.sql:66` lọc ngày ký, không loại DRAFT trong định nghĩa này; form `useContractSubmit.ts:365` mở modal hoa hồng sau tạo. Không suy việc hiển thị nghĩa vụ là đã chi. |
| Hồ sơ cư trú | `20260915075715_residence_dossier_files.sql:14`, `:61` gắn contract và kiểm phạm vi; `20260916005805_residence_dossier_files_lease_term.sql:11` lưu kỳ thuê tài liệu. File chuẩn bị trước nhận không được biến thành cư trú hiện tại. |
| Public QR | UI `ContractListTable.tsx:170` tắt QR cho DRAFT; server `20260808100000_bo_sdt_khoi_payload_cong_khai.sql:73` chỉ loại TERMINATED. Ẩn nút không phải phân quyền API. |
| Copilot/lifecycle | `20260903050215_copilot_read_rpc_hardening_v2.sql:206` allowlist status cũ; `20260920175511_contract_settlement_authenticated_reader.sql:112` chỉ ACTIVE/EXPIRED/TERMINATED. Cần cập nhật chủ động. |

Danh sách trên là inventory source tối thiểu, **chưa tuyên bố đầy đủ deployed dependencies**. Mỗi entry phải có owner, classification và test trước khi bật trạng thái mới.

## 3. Mô hình đề xuất và bất biến

Nháp có `organization_id`, tòa/phòng dự kiến, khách với đúng một đại diện, điều khoản, dịch vụ, lịch tính tiền dự kiến, mẫu, notes, `revision`, creator/editor và `converted_contract_id`. Draft revision lưu snapshot đầy đủ cùng schema version/hash. Đổi dữ liệu tạo revision mới bằng CAS; revision đã xuất/ký không bị sửa. Bỏ nháp giữ tombstone/lịch sử.

Reservation có ID ổn định, org, room, customer đại diện, nhóm khách, khoảng thuê dự kiến, hạn giữ server và trạng thái rõ. Thu cọc tham chiếu reservation, voucher và khách; tiền vẫn lấy từ canonical voucher/ledger. Có reservation không tiền hợp lệ; nhận 0đ không tạo chứng từ. UI luôn hiện “Nháp không giữ phòng”, cọc của **đúng reservation**, thời hạn và nguồn tiền; không preselect toàn bộ cọc theo phòng.

Ký yêu cầu draft revision, artifact đã xác nhận, reservation tùy chọn, expected versions và idempotency key. Trong một transaction: kiểm quyền, khóa phòng/org theo thứ tự tương thích writer đang có; khóa nháp, reservation, khách, phiếu theo thứ tự xác định; kiểm CAS, expiry, customer, khoảng thuê và cọc; tạo hợp đồng từ snapshot; ghi liên kết một lần; tạo cam kết khoảng thuê; consume đúng reservation ID; lưu sự kiện và response. Unique `converted_from_draft_id` chống hai người ký cùng nháp bằng hai key khác nhau. Unique source voucher chống dùng tiền hai lần; không đổi customer bằng payer_name.

**V1 chỉ có một cam kết khách kế tiếp chưa nhận trên mỗi phòng.** Dùng registry claim có UNIQUE một dòng live theo org/phòng, chủ sở hữu là reservation hoặc signed contract; chuyển chủ atomically khi ký, kết thúc next-claim khi nhận hoặc hủy đúng quyền. Hold 24h vẫn là khóa ngắn hạn gắn exact reservation, không thành registry thứ hai. Kiểm ngày nhận tối thiểu theo notice đã xác nhận và ngày dọn/sửa dự kiến; thiếu ngày đáng tin chỉ lưu nháp. Khi đổi notice, renew hoặc transfer phải khóa/đối chiếu cùng registry, giữ claim đã ký và tạo công việc conflict nếu khách cũ lùi ngày. Cần trường ngày rõ ràng, nhưng V1 không cho đặt nhiều lượt thuê tương lai bằng các khoảng không giao nhau. Exclusion trên `[start,end_exclusive)` là phương án mở rộng phase sau nếu có yêu cầu booking nhiều lượt; không triển khai mặc định. Hết hạn hold không tiền phải chuyển state dưới lock trước claim mới; không dùng điều kiện index phụ thuộc `now()`.

Ký xong chưa vào: SIGNED_WAITING, không occupied, không current tenant. Nhận phòng là transaction riêng, kiểm signed version, phòng thực tế, biên bản/ngày nhận, lặp lại trả cùng activation. Chỉ lúc đó mở occupancy và bàn giao tài sản; đến ngày dự kiến cron không tự đánh dấu khách đã ở. Đổi phòng/khoảng thuê phải tái kiểm constraint và lưu amendment, không ghi đè giấy đã ký.

Ví dụ bắt buộc: A và B có hai nháp cùng phòng vẫn lưu được; A ký 01/10–31/12 nhưng chưa nhận thì cả B ký 15/10 và B ký từ 01/01 đều bị chặn bởi một next-claim đang sống. Khi A đã nhận, chỉ tạo claim kế tiếp theo notice/ngày nhận đủ điều kiện; không suy từ end_date rằng phòng đã sẵn sàng. Nhân viên X giữ cho khách A không được dùng hold đó ký khách B. Hết hold lúc 10:00 thì ký 10:00 phải tái kiểm; replay lần ký thành công trước đó trả đúng hợp đồng, không tạo lại tiền.

## 4. Tiền, ngày tính tiền và quyền

| Sự kiện đề xuất | Tác động tiền |
|---|---|
| Lưu/xuất/gửi nháp | Không voucher, invoice, posting, commission, spend HOLD/DRAW. |
| Giữ chỗ không tiền | Chỉ reservation/room commitment; không phiếu tượng trưng. |
| Thu cọc thật | Canonical writer tiền hiện có, số thực nhận/sổ/ngày/chứng từ; liên kết reservation chính xác; recompute số đã thu. |
| Ký từ nháp | Liên kết phiếu cọc đã có, không thu lần hai; đóng băng điều khoản và lịch billing. Không tự chi hoa hồng. |
| Nhận phòng | Ghi thực nhận/occupancy; thực hiện billing theo policy đã chốt; replay không sinh hóa đơn đôi. |
| Hủy/hết reservation | Giải phóng cam kết phòng; tiền đi settlement/refund hiện có, không xóa phiếu. |

**GATE-BILLING-01:** `billing_start` là ngày thỏa thuận độc lập thực nhận. Nếu ký 27/09, tính tiền từ 01/10, khách vào 05/10 thì không âm thầm miễn 01–04/10. Audit phải chốt một policy: phát hành đúng lịch khi chờ nhận; hoặc chỉ phát hành khi nhận nhưng ghi nghĩa vụ/kỳ còn treo và catch-up đầy đủ từ ngày thỏa thuận. Đề xuất mặc định giữ lịch nghĩa vụ độc lập occupancy; nếu yêu cầu “chỉ nhận mới lập hóa đơn” được chọn, phải có hàng đợi quá hạn, báo cáo và xử lý khách không đến. Chưa chốt thì chưa triển khai phase SIGNED_WAITING. Không dùng ngày click activation thay `billing_start`.

Không tạo writer tiền thứ hai: tách orchestration lifecycle khỏi phần tiền của `create_contract_v2`, tái sử dụng canonical writer/adapters hiện có với operation ID ổn định và một ranh giới transaction. Không gọi nguyên RPC đang tạo ACTIVE/OCCUPIED rồi đổi lại status. Thiết kế phải nêu nguồn duy nhất tạo hóa đơn đầu, unique business key lịch/kỳ, rollback và retry sau timeout. Thiếu cọc vẫn dùng DEBT/FIRST_INVOICE đúng invariant; ký không được ghi tăng `deposit_paid` thủ công.

Bộ máy chi 27/09 liên quan trực tiếp: `20260926150000_bo_may_chi_so_tieu_va_quyet_dinh_bong.sql:304` có nguồn INCOME hiện hữu, `:847` phân HOLD/DRAW theo approval, `:914` RELEASE; `20260926160000_noi_writer_vao_bo_may_chi.sql:179` bắt dấu quyết định; `20260926172614_bat_bo_may_chi_ap_dung_sua_cong_an.sql` bật chế độ. Không gọi cam kết phòng là `spend_commitments`; không tự cho nguồn lifecycle mới vào allowlist hệ thống. Thu cọc không phải chi cam kết; phiếu hoa hồng/hoàn cọc thật phải giữ luật writer và audit provenance riêng. Đối chiếu cả reconcile v1/v2 khi triển khai.

Quyền hiện hữu: `contracts.create` tại create RPC `:517`, `thu_tien.collect` tại `:808`, `deposits.create` tại baseline `:59303`. Đề xuất quyền draft edit/export, sign, activate riêng theo permission catalog; không mặc nhiên kế thừa sign/check-in từ create. Migration quyền phải có bảng vai trò được phép, default deny và review độc lập. Mỗi RPC tự kiểm building/org qua authz framework; RLS nháp/revision/artifact chặn cross-org, tòa không được cấp, khách khác org; áp dụng hide-sandbox theo Contract. Không grant anon cho dữ liệu nháp. Client sửa payload, version hoặc idempotency key không được bỏ qua server guard; retry phải kiểm quyền trước replay.

## 5. Nguồn giấy đã gửi

`src/components/contracts/PrintContractDialog.tsx:124` dựng dữ liệu hiện tại, `:125` tải `selected.file_url`, `:129` download blob. `src/lib/contractTemplateEngine.ts:525` render DOCX; `:541` biến placeholder thiếu thành rỗng. `src/hooks/useDocumentTemplates.ts:457` thay URL và `:462` xóa file cũ. Chưa có bằng chứng lưu revision/template bytes/export hash bất biến.

Đề xuất xuất từ snapshot server đã kiểm, ghim template version/byte hash, data revision/hash, renderer version, actor/time và output hash. Lưu chính file đã xuất trong lớp storage/R2 hiện có, bảo toàn template cũ; download lại trả artifact đó. Ghi `shared_at` là người dùng xác nhận đã gửi, không giả là hệ thống đã gửi email. Nếu nội dung sửa sau gửi, tạo revision/artifact mới và yêu cầu xác nhận bản nào thực ký. Bản có chữ ký tải lên là artifact riêng liên kết đúng revision; ký không chỉ dựa vào `signed_date`. Kiểm trường bắt buộc trước render; placeholder thiếu không được im lặng thành giấy hợp lệ. PDF có thể bổ sung sau, không là điều kiện giả định của DOCX hiện tại.

## 6. Gate triển khai và phần chưa xác minh

Trước viết migration cần catalog snapshot read-only đã được phép trên TEST: `pg_get_functiondef` của create/hold/settlement/billing/commission/public readers; `pg_trigger` và definitions trên contracts, customers, services, holds, vouchers/items; `pg_constraint`/`pg_indexes`; enum, ACL/owner/`provolatile`/search_path, policies và feature routes. So với baseline + forward provenance, ghi digest và drift. Chưa đọc catalog thì không khẳng định tất cả trigger, constraint hoặc quyền đang chạy đã được phủ.

Harness bắt buộc: JWT vai trò thật/cross-org; actor mất quyền trước replay; hai người ký cùng nháp; hai nháp chồng phòng; đồng thời ký và hết hold/refund; hai khách cùng phòng; key cũ payload mới; crash sau tạo invoice; delayed move-in; giờ Bangkok qua nửa đêm; hết hạn không hoàn cọc tự động; template thay sau xuất; public QR không lộ nháp/chờ nhận; mọi reader không đếm nhầm occupancy. Mutation phải chứng minh bỏ customer predicate, bỏ constraint, nuốt lỗi hold hoặc đổi ngày billing làm suite đỏ.

Các lệnh thực chạy trong lượt này: `git rev-parse HEAD` đúng SHA trên; `git status --short` phát hiện file ngoài phạm vi; `rg -n` và đọc có số dòng các source nêu trên; `Test-Path node_modules` trả false. Một số glob Windows ban đầu sai đường dẫn đã được thay bằng `rg -g`; không coi lượt grep lỗi là bằng chứng không tồn tại. Không cài dependencies. Root chịu trách nhiệm ghi kết quả baseline tests chạy từ checkout cùng SHA vào tài liệu tổng; tài liệu này không tự nhận test runtime đã pass.

Kiểm tài liệu mới: `git diff --no-index --check -- NUL docs/audits/2026-09-27-contract-lifecycle/drafts-reservations-evidence.md` không báo lỗi whitespace (exit 1 vì file mới khác NUL); kiểm từng dòng bằng PowerShell cho 0 dòng whitespace cuối. Bản đầu có 2.572 từ theo cách đếm khoảng trắng; đây chỉ là kiểm artifact, không thay test nghiệp vụ.

Chưa xác minh: deployed catalog, DB concurrency, RLS/PostgREST, byte DOCX render thật, browser E2E, ledger reconciliation và chính sách phát hành hóa đơn khi chờ nhận. Docs-only không cần chạy toàn app. Chỉ sau audit chốt các gate mới lập implementation plan, forward migration và draft PR theo Contract §3; không coi tài liệu này là lệnh triển khai.
