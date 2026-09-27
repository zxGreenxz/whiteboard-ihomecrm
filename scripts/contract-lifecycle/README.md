# Baseline tài chính hiện hành (P0c)

Đây là harness TEST để ghi lại hành vi trước khi đổi lifecycle; không đổi policy,
schema, cờ tính năng hoặc dữ liệu production. Suite local đã nằm trong glob CI
`scripts/tests/contract-lifecycle/*.test.mjs`; CI không chạy baseline có credential.

```powershell
npm exec --yes --package=node@24.18.0 -- node --test scripts/tests/contract-lifecycle/*.test.mjs
npm exec --yes --package=node@24.18.0 -- node scripts/contract-lifecycle/baseline.mjs --test --vault --ca-file "<đường dẫn CA Supabase PEM>"
```

`--vault` đọc đúng các trường TEST từ vault gốc qua loader đã có; bỏ tùy chọn này
để dùng biến môi trường TEST. Không có target mặc định hay chế độ commit. Thiếu
credential, CA, marker hoặc ca bắt buộc thì lệnh thoát khác 0. Evidence được ghi
vào `docs/generated/contract-lifecycle/<timestamp>-financial-baseline.json`.

Mỗi ca có một transaction riêng, kiểm TEST marker trên chính kết nối đó và luôn
ROLLBACK. Một transaction chỉ đọc khác kiểm không còn room/customer/contract,
sổ fixture, personal cashbook và possession fixture. Room/customer có UUID từ
run ID + tên ca; ID nguồn tiền do writer cấp. Sổ fixture có tên/key theo run ID,
số dư đầu 0, tạo qua `create_cashbook_v1`; `set_personal_cash_book_v1` chỉ được gọi
nếu người thu chưa có sổ cá nhân. Harness dừng nếu đã có cấu hình, không thay sổ
dùng chung. Giữ nguyên feature flags và ghi route thực tế vào từng ca.

- FORFEIT: cọc thực thu 1.000.000đ; hóa đơn chưa thu 100.000đ, trả 50.000/200.000đ,
  đã trả đủ 300.000đ; thu dư CREDIT 50.000đ; thu thêm 75.000đ. Kiểm hủy phần nợ,
  giữ phần đã thu, giữ hóa đơn đã trả đủ, cặp nội bộ tự duyệt, credit tiêu hết,
  và tiền thật không đổi.
  Oracle đối chiếu đúng ID hóa đơn thu thêm từ writer với nguồn mới
  APPROVED/SETTLEMENT, total/remaining 75.000đ, paid 0 và delta phải thu -175.000đ;
  giữ nguyên đúng lot credit gốc (amount 50.000đ), chỉ đổi sang CONSUMED/remaining 0.
  Hai phiếu nội bộ phải có đúng một nguồn offset EXPENSE và một nguồn revenue
  INCOME, mỗi ID khớp writer và có sổ ảo hợp lệ.
- REFUND: nợ 200.000đ, cấn cọc và tạo phiếu hoàn 800.000đ UNAPPROVED, chưa chọn
  sổ, chưa chi tiền. Đường duyệt UI hiện tại
  `approve_pending_income_expense_checked_v1` phải từ chối P0001 khi chưa có sổ.
  Probe V2 riêng ghi 55000; không suy ra đây là đường UI hay chỉ riêng lỗi
  cùng transaction. Cả hai probe dùng savepoint và kiểm snapshot không đổi.
  Phiếu hoàn phải khớp ID writer, type EXPENSE và CASHBOOK/UNPOSTED; thiếu,
  trùng, đổi ID hoặc trạng thái nguồn đều bị từ chối bởi oracle dùng chung.
- DEBT: nợ 1.500.000đ, cấn cọc 1.000.000đ bằng CT, còn 500.000đ, không thu giả.
- PAID: gạch 1.500.000đ bằng CT, tạo phiếu thu thật và posting 500.000đ.

Các ca kiểm retry cùng key không đổi nguồn và khác payload trả 23505. Các writer
tạo hợp đồng, hóa đơn, thu tiền và thanh lý là writer hiện hành. Snapshot chỉ
chứa nguồn synthetic: hợp đồng/phòng, hóa đơn/payment, phiếu/item/posting/line,
canonical operations, credit lots và termination audit. Evidence ghim Git SHA,
digest mã harness, giờ server, nguồn SQL, số đếm và digest từng ca.
`baseline-sources.test.mjs` dùng bản sao evidence lịch sử để kiểm oracle này;
những test âm đó không thay thế bằng chứng chạy database thật. Evidence P0c đầu
tiên được giữ làm lịch sử; bản fix1 bổ sung kiểm nguồn chính xác và ID từ writer.

Giới hạn: đây là SQL chạy với claims của DEMO owner, **không phải chứng minh
authorization qua JWT**. Chưa kiểm duyệt/chi hoàn thành công sau commit, JWT
mutation theo vai trò, concurrency, đối chiếu tiền toàn hệ thống hoặc các tổ hợp
flags khác. Credit dương mới chứng minh FORFEIT với route hiện tại. Đột biến local
chỉ thay oracle/copy snapshot; không phải đột biến SQL/permission runtime.

## P1a.1 — legacy approval eligibility

`legacy-entrypoints.test.mjs` là oracle local không credential, nằm trong glob CI
hiện tại. Các lệnh live dưới đây chỉ chạy khi opt-in, đọc vault gốc và CA tại
`.superpowers/sdd/2026-09-27-contract-lifecycle/supabase-ca.crt`; evidence đầy đủ
ở cùng thư mục ignored, chỉ chứa fixture mới (không đưa actor/cấu hình thật vào
bản public). Dùng Node24.18.0 theo runtime matrix.

```sh
npm run test:legacy-approval -- --test-rollback --migration supabase/migrations/20260927180948_approve_termination_eligibility.sql
npm run test:legacy-approval-parity -- --test-rollback
npm run test:legacy-approval-negatives -- --test-rollback
npm run test:legacy-approval-http -- --test-commit
npm run test:legacy-approval-auth -- --test-commit
```

Hai lệnh `--test-commit` thực hiện cleanup rehearsal trong ROLLBACK trước seed.
HTTP runner áp migration vào **TEST**, tạo fixture riêng rồi gọi PostgREST bằng
JWT owner; auth runner thêm building + scope + override riêng cho manager.
Không tắt trigger, không sửa role/membership có sẵn. Cleanup transaction riêng
kiểm marker/org/linkage, live FK closure và exact row counts; lỗi cleanup làm
lệnh thất bại. Giữ audit append-only và bước tăng counter/authorization_version;
không tuyên bố database không còn mọi dấu vết.

Parity SQL đối chiếu với definition legacy ghim MD5, gồm ACTIVE/EXTENDED,
refund capped/uncapped, thu thêm, zero và softdeleted COMPLETED replay.
Capped/uncapped chỉ có bằng chứng SQL rollback, không gọi là JWT proof.
HTTP concurrency quan sát hai calls chờ khóa, chỉ một phiếu và một noop.
Hai DRAFT trên cùng contract không dựng được: unique index hiện hành trả23505;
không gỡ index để ép ca đó chạy. Đây là giới hạn tiền đề, không phải pass race.

Chỉ thay eligibility của `approve_contract_termination_v1`; raw-table bypass,
global lock protocol, private capabilities và concurrent authority-revocation
linearization vẫn thuộc các phần việc sau. Không phải release toàn lifecycle.

## P1a.2 — ranh giới ghi contract_terminations

Migration `20260927190750_termination_write_boundary.sql` dùng proof riêng theo
transaction/backend/actor/org/contract/termination và exact row; không dùng
caller GUC hay quyền owner làm bypass. DRAFT dùng `contracts.create`; các writer
cũ giữ quyền hiện có. Hai guard kiểm patch trước normalization và kiểm kết quả
trước trigger ghi contract. Metadata giữ nguyên các giá trị settlement đã lưu.

Chỉ chạy trên project TEST riêng, Node24.18.0 và vault gốc như các harness trên:

```sh
node scripts/contract-lifecycle/termination-boundary-live.mjs --test-rollback --migration supabase/migrations/20260927190750_termination_write_boundary.sql
node scripts/contract-lifecycle/termination-boundary-http-live.mjs --test-commit
node scripts/contract-lifecycle/termination-boundary-auth-live.mjs --test-commit
```

HTTP/auth runner rehearsal cleanup trong rollback trước committed seed. Phạm vi
committed chỉ zero money hoặc INCOME100 chưa duyệt/chưa post, account NULL;
không dùng cho fixture paid/refund/cashbook. Cleanup giữ guard, kiểm exact roots,
marker/org/linkage và live FK closure; proof DELETE chỉ owner, exact row và đóng
ngay sau xóa. Nhánh RPC thất bại trước tạo termination được cleanup khi đã chứng
minh owned contract có zero termination, không tạo business row để dọn. Audit,
canonical identity và counter increments được giữ và ghi trong receipt ignored.

SQL suite gồm direct DML/forged proof, metadata NULL legacy có kiểm soát, rollback
khi audit INSERT lỗi, terminal eligibility, ACTIVE/EXTENDED capped/uncapped/zero.
Fixture NULL chỉ tồn tại trong rollback; trigger fixture exact row được gỡ và
catalog được đối chiếu trước assertion. Không coi nó là INSERT NULL hiện hành.
JWT races đo cùng termination, raw/credit FORFEIT, raw/credit MOVE_OUT,
approve/FORFEIT và reject/MOVE_OUT. Hai DRAFT bị unique index từ chối23505.
Paid refund/collection/cashbook races chưa được xác minh bởi bộ này.

Không có consumer UI hiện hành của `useRejectTermination`; typed unit và JWT
kiểm reject, còn `.e2e-fleet/specs/termination-boundary-read.spec.ts` chỉ smoke
đọc contracts với owner/manager/accountant, headless, local app explicit TEST.
Không gọi smoke này là reject UI E2E. Production/schema release không thuộc lệnh.

P1a.2 fix1 có thể chạy riêng hai negative JWT trên hợp đồng TERMINATED bằng:

```sh
node scripts/contract-lifecycle/termination-boundary-http-live.mjs --test-commit --term-negatives-only
```

Lệnh rehearsal cả TERM không có termination và ACTIVE+DRAFT rồi chuyển TERM,
kiểm cleanup trong rollback trước seed durable; receipt riêng
`p1a2-fix1-term-http.json` không ghi đè bộ runtime trước. Snapshot ngay trước/sau
phải bằng nhau và request được await đầy đủ trước cleanup. Không thêm fixture tiền.
Metadata trong candidate mới so MD5 sau đổi đúng cặp CRLF thành LF; bare CR và
mọi byte khác vẫn có ý nghĩa, owner/ACL/security/config vẫn kiểm exact.
