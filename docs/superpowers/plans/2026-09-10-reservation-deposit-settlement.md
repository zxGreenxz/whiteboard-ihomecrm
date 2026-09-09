# Xử lý bỏ cọc chưa gắn hợp đồng — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Review tiền/phân quyền độc lập trước phát hành theo PROJECT_CONTRACT.

**Goal:** Một thao tác xử lý cọc chưa có hợp đồng, giữ toàn bộ hoặc một phần, hoàn ngay hoặc hoàn sau; hết giữ phòng và không cộng lại vào hợp đồng mới.

**Architecture:** Giữ phiếu thu gốc và thêm hồ sơ settlement bất biến. Writer server điều phối doanh thu không tiền, nghĩa vụ hoàn và posting chi thật; predicate cọc khả dụng dùng chung ở phòng, hợp đồng và báo cáo. Một dialog dùng cho desktop/mobile.

**Tech Stack:** React, TypeScript, React Query, React Hook Form, Zod, shadcn/ui, Supabase PostgreSQL, Vitest, Playwright headless.

**Triển khai:** Sau khi người dùng yêu cầu hiện thực plan, tính năng đã được xây dựng và kiểm thử. Trạng thái phát hành, số đo và các điều chỉnh so với checklist dự kiến nằm tại [runbook](../runbooks/2026-09-10-reservation-deposit-settlement.md).

## Global Constraints

- Thiết kế nghiệp vụ: [spec](../specs/2026-09-10-reservation-deposit-settlement-design.md); ràng buộc chung: [PROJECT_CONTRACT](../../engineering/PROJECT_CONTRACT.md).
- Phạm vi ban đầu là lập plan. Người dùng sau đó đã yêu cầu hiện thực và hoàn tất toàn bộ plan để đưa lên production; bằng chứng thực hiện nằm trong runbook.
- Base khảo sát: 1d6523fb; base worktree plan: 4285b214. Đọc lại SQL live trước khi viết migration.
- V1 mỗi lần xử lý một phiếu; cho phép giữ 0đ và hoàn toàn bộ; hoàn sau chi toàn bộ số còn nợ một lần.
- Hoàn sau chỉ ghi nghĩa vụ, tạo phiếu chi tại thời điểm hoàn; không tạo phiếu sổ ảo để lách yêu cầu sổ thật.
- Quyền xử lý: deposits.refund và quyền/chính sách duyệt doanh thu hiện hành; quyền thực chi kiểm thêm lúc hoàn.
- Thời điểm tiền ra căn cứ posting có hiệu lực. Không lấy APPROVED làm bằng chứng đã thu/đã chi.
- Không sửa ngày, số tiền hoặc loại cọc của phiếu nhận ban đầu.
- Cơ chế tiền chính xác ở spec §4.1: cặp noncash giảm cọc / tăng doanh thu bằng phần giữ lại. Chỉ phiếu doanh thu mới tính KQKD; phiếu nguồn không bật cờ KQKD.
- Không tự hoàn tác cả quyết định bỏ cọc ở V1; không có đường sửa tiền của settlement đã chốt.
- Tên migration phải do scripts/tao-ten-migration.mjs cấp; không điền timestamp sẵn trong plan.

## 1. Hợp đồng dữ liệu giữa các phần

Tạo src/lib/reservationSettlementRpc.ts. Các số tiền response chuẩn hóa từ numeric SQL thành number nguyên an toàn, không ép lỗi thành 0.

~~~ts
export type RefundMode = "NONE" | "NOW" | "LATER";
export type RefundState = "NOT_REQUIRED" | "PENDING" | "PAID";
export type SettlementReason = "CHANGED_MIND" | "NO_SHOW" | "OTHER";
export type SettlementBlock =
  | "NOT_RECEIVED" | "ALREADY_USED" | "SOURCE_CHANGED"
  | "PERMISSION_DENIED" | "PERIOD_LOCKED" | "DEPOSIT_CLASS_MISMATCH";
export type RoomBlock =
  | "OTHER_DEPOSIT" | "ACTIVE_CONTRACT" | "ROOM_UNAVAILABLE"
  | "UNRELATED_HOLD";
export interface SettlementPreview {
  voucherId: string;
  depositAmount: number;
  fingerprint: string;
  canSettle: boolean;
  canRefundNow: boolean;
  blockers: SettlementBlock[];
  roomBlockers: RoomBlock[];
}
export interface SettleReservationInput {
  voucherId: string;
  refundAmount: number;
  refundMode: RefundMode;
  settlementDate: string;
  reasonCode: SettlementReason;
  reasonText: string;
  refundAccountId: string | null;
  basisFingerprint: string;
  idempotencyKey: string;
}
export interface PayReservationRefundInput {
  settlementId: string;
  accountId: string;
  paidOn: string;
  idempotencyKey: string;
}
export interface ReservationSettlement {
  id: string;
  sourceVoucherId: string;
  depositAmount: number;
  retainedAmount: number;
  refundAmount: number;
  refundedAmount: number;
  refundRemaining: number;
  refundState: RefundState;
  roomReleased: boolean;
  roomBlockers: RoomBlock[];
  revenueVoucherId: string | null;
  offsetVoucherId: string | null;
  refundVoucherId: string | null;
}
~~~

RPC công khai mới, cùng boundary Zod parse response:
- preview_reservation_settlement_v1(p_voucher_id uuid) → SettlementPreview.
- settle_reservation_deposit_v1(p_input jsonb) → ReservationSettlement.
- pay_reservation_refund_v1(p_input jsonb) → ReservationSettlement.
- get_reservation_settlement_summary_v1(p_building_ids uuid[] DEFAULT NULL) → { retainedAmount, retainedCount, refundPendingAmount, refundPendingCount, refundPaidAmount, refundPaidCount }.
- get_reservation_settlements_v1(p_building_ids uuid[], p_refund_state text, p_cursor jsonb, p_limit integer) → { rows: ReservationSettlement[], nextCursor: object | null }; rows thêm building/room/payer/code/date cho UI, lấy từ phiếu nguồn dưới cùng kiểm quyền.

Khóa chuỗi system_source mới: reservation.forfeit_revenue, reservation.forfeit_offset, reservation.refund. Không dùng termination.*.

## Task 1: Chốt căn cứ tiền, quyền và các cửa SQL đang chạy

**Files**
- Read: src/hooks/useDeposits.ts, src/hooks/useTerminationRefund.ts, src/lib/financeV2VoucherState.ts.
- Read: contracts/surfaces/rpc-surface.json, docs/generated/database-inventory.json.
- Read: supabase/migrations/20260721090000_contract_create_v2.sql, 20260731140000_orphan_deposit_trigger_flex.sql, 20260727120000_public_rooms_hide_held_by_deposit.sql.
- Create: docs/superpowers/runbooks/2026-09-10-reservation-deposit-settlement.md (bằng chứng triển khai, không dữ liệu khách).

**Interfaces**
Consumes: các quy tắc spec §4–5.
Produces: định nghĩa SQL được kiểm chứng, danh sách writer/guard và adapter căn cứ tiền dùng trong Task 2.

- [ ] Đọc hợp đồng và chạy freshness trước khi đọc graph tại worktree triển khai.
~~~powershell
npm run gate:graph-freshness -- --nhiem-vu high-risk
npm run graph:impact -- useOrphanDepositVouchers
npm run graph:impact -- useReservationDeposits
~~~
- [ ] Chụp read-only pg_get_functiondef của create_contract_v2, trg_contract_link_orphan_deposits, recompute_contract_deposit_paid, room_has_holding_deposit, create_reservation_deposit_v1, writer thu/chi/post/reverse hiện hành. Ghi digest, không chép token hoặc dữ liệu cá nhân vào evidence.
- [ ] Truy vết contract_deposit_links và mọi cửa UPDATE contract_id để Task 3 không bỏ sót đường gắn phiếu.
- [ ] Đối chiếu cách dựng cọc thực thu cho canonical và legacy. Chốt adapter chỉ nhận tiền đã vào quỹ và chưa đảo; chưa chứng minh được nguồn nào thì preview trả NOT_RECEIVED.
- [ ] Xác minh khóa 24h có liên kết nguồn qua audit/canonical operation. Chỉ giải phóng hold có liên kết định danh; thiếu liên kết thì roomBlockers=UNRELATED_HOLD, không hủy theo room_id hàng loạt.
- [ ] Kiểm tra required_dimensions của deposits.refund, income_expenses.approve và quyền sổ quỹ. Ghi đúng action và writer thực thi để không tạo đường tự duyệt vượt quyền.

Deliverable: evidence đủ để viết SQL trên định nghĩa thực; thiếu credential chỉ chặn thực thi dependent, không bịa kết quả live.

## Task 2: Settlement, doanh thu và hoàn tiền trong writer chuyên trách

**Files**
- Create: migration do lệnh dưới cấp tên, dưới supabase/migrations/.
- Create: scripts/tests/test-reservation-deposit-settlement.sql.
- Create: scripts/test-reservation-deposit-settlement.mjs (runner SQL/HTTP dùng credential vault runtime, chỉ DEMO/TEST).
- Create: src/lib/reservationSettlementRpc.ts.
- Create: src/lib/__tests__/reservationSettlementRpc.test.ts.

**Interfaces**
Consumes: phiếu nguồn + adapter tiền và writer hiện hành đã xác minh ở Task 1.
Produces: bảng reservation_deposit_settlements và 5 RPC ở §1; runtime guard cho phiếu nguồn/phiếu nội bộ; DTO parse đã kiểm.

- [ ] Cấp tên migration:
~~~powershell
node scripts/tao-ten-migration.mjs reservation_deposit_settlement_v1
~~~
- [ ] Viết test DTO trước, chạy đỏ khi module chưa có:
~~~ts
import { describe, expect, it } from "vitest";
import { reservationSettlementSchema } from "../reservationSettlementRpc";

describe("reservationSettlementSchema", () => {
  it("rejects an impossible retained/refund split", () => {
    expect(() => reservationSettlementSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      sourceVoucherId: "00000000-0000-4000-8000-000000000002",
      depositAmount: 3000000, retainedAmount: 2500000,
      refundAmount: 1000000, refundedAmount: 0, refundRemaining: 1000000,
      refundState: "PENDING", roomReleased: true, roomBlockers: [],
      revenueVoucherId: null, offsetVoucherId: null, refundVoucherId: null,
    })).toThrow();
  });
});
~~~
~~~powershell
npx vitest run src/lib/__tests__/reservationSettlementRpc.test.ts
~~~
- [ ] Thêm các ca SQL có fixture rõ: cọc 3tr đã posting, phiếu trộn cọc 3tr + tiền khác 500k, phiếu chưa posting, phiếu đã reverse. Runner abort nếu org ngoài DEMO/TEST, tạo và dọn fixture trong finally; test đơn transaction ROLLBACK, test concurrency phải có cleanup riêng.
- [ ] Tạo bảng: FK phiếu nguồn và organization_id; unique source_voucher_id; CHECK deposit_amount=retained_amount+refund_amount; tiền nguyên không âm. RLS SELECT kiểm tổ chức và quyền tòa qua phiếu nguồn; policy hide_sandbox_admin. Revoke DML trực tiếp.
- [ ] Định nghĩa predicate và guard nội bộ:
~~~sql
-- Predicate này chỉ trả trạng thái tiêu dùng, không tự thay thế kiểm quyền.
CREATE FUNCTION app_private.reservation_deposit_is_settled_v1(p_voucher_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, app_private
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reservation_deposit_settlements s
    WHERE s.source_voucher_id = p_voucher_id
  )
$$;
~~~
Revoke PUBLIC/anon/authenticated; caller writer chịu kiểm quyền. Guard cấm các đường sửa/xóa/gắn/đảo phiếu nguồn đã settle, kể cả item, link table và lifecycle APIs; metadata ghi chú an toàn vẫn theo quyền hiện hành.
- [ ] Implement preview: quyền trước dữ liệu, phân loại cọc, nguồn tiền signed/posting, hợp đồng/link, kỳ khóa; trả fingerprint căn cứ. Phân biệt blocker khiến không settle được và ràng buộc khiến phòng chưa trống.
- [ ] Implement settle theo thứ tự: authorize → khóa phòng → khóa tổ chức → khóa phiếu → kiểm/replay operation → kiểm fingerprint và số tiền → insert settlement → tạo cặp noncash phần giữ lại → NOW gọi helper hoàn tiền, LATER không ghi tiền → đóng hold xác định được → reconcile phòng → response. RPC có lock phải VOLATILE.
- [ ] Hai chân tạo tự động: EXPENSE/DEPOSIT reservation.forfeit_offset có kqkd_amount=0; INCOME/PNL reservation.forfeit_revenue tính KQKD bằng retained_amount. Cả hai NON_CASH/NOT_APPLICABLE, cùng ngày và liên kết settlement, đi qua năng lực writer riêng phạm vi hẹp. Đối chiếu số dư thật v1/v2 đều không đổi. Cấm sửa account/posting mode để biến chúng thành giao dịch tiền.
- [ ] Trình tự tiền dùng phép tính:
~~~ts
const retainedAmount = depositAmount - refundAmount;
const refundMode = refundAmount === 0 ? "NONE" : input.refundMode;
// Server kiểm cả hai: 0 <= refundAmount <= depositAmount,
// và số tiền phải là VND nguyên; mode không phù hợp là lỗi validation.
~~~
Giữ lại=0 bỏ qua tạo hai phiếu noncash. Không gắn invoice thanh lý giả.
- [ ] Implement pay helper dùng lại trong NOW và pay RPC: khóa settlement, tính nghĩa vụ trừ posting chi còn hiệu lực; nếu đã đủ trả kết quả cũ. Kiểm account thật/custodian/quyền/closing; tạo và approve/post bằng writer tài chính hiện hành trong cùng transaction. Không phát HTTP nội bộ để tạo giao dịch rời.
- [ ] Một idempotency key đổi payload phải conflict; key khác cùng phiếu vẫn không thể tạo settlement thứ hai. Phiếu hoàn đã reversed phải được liên kết lịch sử và chỉ có một lần chi đang hiệu lực. Không cho mọi caller gọi helper bỏ qua public authorizer.
- [ ] Runtime assertion cuối transaction:
~~~sql
-- Đọc các số từ settlement và posting đang hiệu lực, không lấy giá trị client.
IF v_deposit <> v_retained + v_refund
   OR v_refunded < 0 OR v_refunded > v_refund THEN
  RAISE EXCEPTION 'Số tiền xử lý cọc không khớp' USING ERRCODE = '23514';
END IF;
~~~
- [ ] Chạy SQL/HTTP role thật; test no-op không tiết lộ dữ liệu cross-org. Sau khi schema triển khai qua lane được phép, gen canonical types theo Contract; không cast RPC bằng any.
- [ ] Commit task khi các test Task 2 pass; stage đúng migration được cấp tên trước provenance:generate, dùng trailer Codex.

## Task 3: Chặn tái sử dụng cọc và thống nhất trạng thái phòng

**Files**
- Modify: migration mới Task 2 bằng phần tiếp nối trước khi merge; sau merge phải cấp migration mới.
- Modify: src/hooks/useDeposits.ts.
- Modify: src/components/contracts/contract-form/useContractFormState.ts, useContractSubmit.ts.
- Modify: src/lib/depositWorkQueue.ts.
- Test: src/lib/__tests__/depositWorkQueue.test.ts.
- Test: scripts/tests/test-reservation-deposit-settlement.sql.

**Interfaces**
Consumes: app_private.reservation_deposit_is_settled_v1; settlement table.
Produces: không còn settled receipt trong nguồn khả dụng; lịch sử vẫn đọc được.

- [ ] Viết test chặn explicit create_contract_v2 với id phiếu đã settle, insert hợp đồng theo trigger legacy, INSERT contract_deposit_links trực tiếp và UPDATE contract_id qua compatibility writer.
- [ ] Áp cùng predicate tại lựa chọn/kiểm phiếu ở server; không chỉ bỏ id khỏi payload FE.
~~~sql
AND NOT app_private.reservation_deposit_is_settled_v1(voucher.id)
~~~
Alias áp theo câu SQL thật. Guard kiểm lại sau lock để chặn race, không chỉ kiểm WHERE trước lock.
- [ ] room_has_holding_deposit bỏ phiếu settled; gọi lại recompute_room_reservation sau settle. Giữ các nhánh legacy deposits, active contract và trạng thái bảo trì hiện hành.
- [ ] useOrphanDepositVouchers đọc settlement relation hoặc RPC để lọc server-side trước phân trang. useReservationDeposits giữ dòng lịch sử, thêm trạng thái settlement riêng; summary tính holdingAmount chỉ từ phiếu chưa settle.
- [ ] useContractFormState/useContractSubmit loại settled; server vẫn là cửa cuối khi form cũ chưa refresh. Lỗi SOURCE_CHANGED/ALREADY_USED hiển thị yêu cầu tải lại cọc.
- [ ] buildDepositWorkQueue bỏ mọi nguồn đã settle khỏi HOLD_READY/HOLD_OVERDUE/RESV_TOPUP/PENDING_APPROVAL. Không xóa kỳ hạn lịch sử.
- [ ] Test hai session: settle vs create contract; settle vs thêm cọc/hold; hai settle cùng phiếu. Assert chỉ một kết quả tiêu dùng và không deadlock. Thứ tự khóa cả hai writer phải thống nhất.
- [ ] Test phòng còn cọc khách khác, occupied, maintenance, sắp trống; khóa 24h có/không xác định nguồn. Không báo “phòng trống” khi roomReleased=false.
- [ ] Commit sau kiểm tra query và SQL race.

## Task 4: Một dialog chung và thao tác Hoàn tiền sau

**Files**
- Create: src/hooks/useReservationSettlement.ts.
- Create: src/components/deposits/ReservationSettlementDialog.tsx.
- Create: src/components/deposits/ReservationRefundDialog.tsx.
- Create: src/components/deposits/ReservationSettlementStatus.tsx.
- Create: src/lib/reservationSettlementForm.ts.
- Create: src/lib/__tests__/reservationSettlementForm.test.ts.
- Modify: src/components/income-expenses/IncomeExpenseDetailDialog.tsx, IncomeExpenseDetailMobile.tsx.
- Modify: src/pages/deposits/DepositsPage.tsx, DepositsMobilePage.tsx.

**Interfaces**
Consumes: RPC/DTO §1.
Produces: useReservationSettlementPreview(voucherId), useSettleReservationDeposit(), usePayReservationRefund(); dialogs nhận voucherId/settlementId, open, onOpenChange.

- [ ] Viết và chạy test form: mặc định refund=0/NONE; refund>0 đòi NOW/LATER; NOW đòi account; LATER không đòi account; OTHER đòi lý do; không nhận âm, lớn hơn cọc, NaN hoặc lẻ VND.
~~~ts
import { expect, it } from "vitest";
import { calculateReservationSplit } from "../reservationSettlementForm";

it("keeps the refundable amount out of revenue", () => {
  expect(calculateReservationSplit(3000000, 1000000)).toEqual({
    retainedAmount: 2000000, refundAmount: 1000000,
  });
});
it("rejects refund larger than the deposit", () => {
  expect(() => calculateReservationSplit(3000000, 3000001)).toThrow();
});
~~~
- [ ] Implement pure calculateReservationSplit(depositAmount:number, refundAmount:number) với Number.isSafeInteger, deposit>0, refund>=0 và refund<=deposit; return shape như test.
- [ ] Implement hooks dùng rpc typed, Zod parse; không fetch trong component. Giữ idempotency key ổn định cho retry cùng payload; sửa payload tạo lần yêu cầu mới, không lặp key cũ.
- [ ] Dialog tải preview trước khi mở nút xác nhận; khi query lỗi không hiển thị 0đ. Một input hoàn tiền, phần giữ lại chỉ xem; ngày dùng helper ngày tổ chức. Chọn NOW mặc định khi có quyền thực chi; nếu không, mặc định LATER và nêu quyền cần cho NOW.
- [ ] Confirm NOW ghi rõ “Tôi đã trả tiền cho khách”; nút hoàn sau không có câu này. Nếu RPC lỗi chi, giữ form và không báo settle thành công.
- [ ] Reuse dialog tại cả bốn entry point. Nhãn phiếu đã settle và nút Hoàn tiền lấy số còn phải hoàn từ server, không đoán từ approval_status.
- [ ] Toast dùng số server trả, ví dụ “Đã ghi nhận doanh thu 2.000.000đ · Chờ hoàn 1.000.000đ”; dòng trạng thái phòng chỉ hiện Trống khi roomReleased=true.
- [ ] Lỗi quyền, kỳ khóa, source changed, chưa nhận tiền, phiếu đã dùng hiển thị riêng. Không lộ SQL/code kỹ thuật trong flow.
- [ ] Commit sau Vitest và render dialog desktop/mobile bằng E2E Task 6.

## Task 5: Báo cáo, Chờ hoàn, lịch sử và realtime

**Files**
- Create: src/components/deposits/ReservationPendingRefundList.tsx.
- Modify: src/hooks/useDepositDashboard.ts.
- Modify: src/pages/deposits/DepositsPage.tsx, DepositsMobilePage.tsx, DepositSidePanel.tsx.
- Modify: src/lib/voucherSources.ts.
- Modify: src/hooks/realtime/finance.ts.
- Modify: src/components/income-expenses/VoucherHistoryDialog.tsx (liên kết hồ sơ nguồn).
- Modify: migration mới với RPC summary/list §1 và tích hợp nguồn báo cáo.
- Test: scripts/tests/test-reservation-deposit-settlement.sql.

**Interfaces**
Consumes: ReservationSettlement, summary và list RPC §1.
Produces: tổng giữ lại, đang giữ, phải hoàn, đã hoàn thống nhất giữa chi tiết/danh sách/KPI.

- [ ] Viết fixtures cùng số: 3tr giữ2/hoàn1; sau settle LATER, holding=0, retained=2tr, pending=1tr, paid=0. Sau pay, pending=0, paid=1tr; doanh thu vẫn 2tr.
- [ ] Tạo danh sách Chờ hoàn trong màn cọc hiện hành, không yêu cầu ngày hẹn; nút Hoàn tiền mở dialog Task 4. Server lọc/sắp xếp/keyset page trước limit.
- [ ] Gộp nguồn reservation.* vào tổng bỏ cọc/hoàn cọc mà không giả thành contract_terminations và không bị đếm hai lần bởi query cũ. Giữ tách “đã hoàn” và “phải hoàn”.
- [ ] Báo cáo doanh thu đọc đúng revenue leg theo ngày xử lý; cashflow chỉ đọc posting refund theo ngày thực chi. Offset và refund cọc không vào chi phí KQKD.
- [ ] Đăng ký labels system_source, liên kết phiếu nguồn/hồ sơ/phiếu chi trong lịch sử. Ngày nhận tiền gốc không đổi.
- [ ] Invalidate sau settle/pay: income-expenses, ie-history, voucher-change-log, reservation-deposits, orphan-deposit-vouchers, deposit-dashboard, reservation-settlements, reservation-settlement-summary, rooms, contracts, phong-trong và query công khai liên quan; thêm key báo cáo tiền/KQKD hiện hành qua helper dùng chung.
- [ ] Thêm subscription bảng settlement theo cơ chế realtime hiện tại; sự kiện refund posting/reversal cũng invalidate summary. Kiểm client thứ hai thấy thay đổi khi client đầu hoàn tiền.
- [ ] Test dữ liệu trên 1000 dòng, tổng SQL bằng tổng phân trang; tòa ngoài quyền không góp tổng.
- [ ] Commit khi totals/realtime pass.

## Task 6: Chứng minh nghiệp vụ, tài liệu và phát hành

**Files**
- Create: .e2e-fleet/specs/reservation-deposit-settlement.spec.ts.
- Extend: scripts/test-reservation-deposit-settlement.mjs với chế độ --concurrency.
- Modify: docs/he-thong/04-coc-giu-cho.md, docs/he-thong/08-thu-chi-so-quy.md.
- Modify: docs/he-thong/manifest.json chỉ theo cơ chế manifest hiện hành.
- Update: runbook Task 1 với số đo/gate và evidence.

**Interfaces**
Consumes: feature đầy đủ Tasks 2–5.
Produces: bằng chứng acceptance, draft PR riêng cho thay đổi tiền/schema.

- [ ] E2E tạo fixture mới trong DEMO; không lấy ngẫu nhiên hồ sơ thật để chi. Dùng cơ chế login/cleanup của fleet, không chép mật khẩu vào test.
- [ ] E2E cover: bỏ toàn bộ; partial NOW; partial LATER rồi pay; full refund; cancel dialog; reload sau timeout; người thiếu quyền; form hợp đồng đã mở trước settle; màn desktop và mobile.
- [ ] Các assertion tối thiểu (locator theo role/text thực tế, không phụ thuộc vị trí):
~~~ts
await dialog.getByLabel("Hoàn lại khách", { exact: true }).fill("1000000");
await dialog.getByRole("radio", { name: "Hoàn sau", exact: true }).check();
await expect(dialog.getByText("2.000.000", { exact: false })).toBeVisible();
await dialog.getByRole("button", { name: "Xác nhận xử lý", exact: true }).click();
await expect(page.getByText("Chờ hoàn 1.000.000đ", { exact: true })).toBeVisible();
~~~
Fixture companion đọc lại server: cọc khả dụng=0, doanh thu=2tr, delta cash=0; sau pay delta cash=-1tr.
- [ ] Run runner SQL/HTTP bằng role thật; mode concurrency dùng hai kết nối độc lập, dọn fixture ngay cả khi assertion fail:
~~~powershell
node scripts/test-reservation-deposit-settlement.mjs
node scripts/test-reservation-deposit-settlement.mjs --concurrency
npx vitest run src/lib/__tests__/reservationSettlementRpc.test.ts src/lib/__tests__/reservationSettlementForm.test.ts src/lib/__tests__/depositWorkQueue.test.ts
npm run typecheck:baseline
npm run build
~~~
- [ ] Chạy E2E headless từ .e2e-fleet:
~~~powershell
$env:FLEET_WORKERS = '2'
npx playwright test specs/reservation-deposit-settlement.spec.ts
~~~
- [ ] Chạy cả reconcile v1/v2, stable-fn-locks, view-invoker nếu thêm view, migration provenance và gate:truoc-push theo Contract. Kiểm bundle dialog/assets sau build.
- [ ] Mutation testing ba invariant tiền/quyền: bỏ NOT settled guard, cho refund>deposit, bỏ org/building authorizer. Mỗi mutation phải đỏ đúng test tương ứng; dùng scripts/dot-bien.mjs, ghi digest/exit code và hoàn nguyên.
- [ ] Cập nhật docs nghiệp vụ và manifest; ghi rõ feature mới chưa-HĐ, tách ngày doanh thu/ngày chi. Chạy docs:check:links; cập nhật file runbook chứa baseline, số ca, tổng tiền, gate và khoảng trống còn lại.
- [ ] Mở draft PR với số đo và gate; review độc lập phần tiền, quyền, SQL trước merge. Migration dùng forward lane/backup theo Contract, không direct-write production. Không tự backfill cọc cũ thành bỏ cọc.
- [ ] Sau backend xanh, kiểm UI preview bằng DEMO rồi phát hành theo Contract. Feature lỗi thì ẩn entry point mới; không xóa settlement đã ghi. Sửa SQL bằng forward migration.

## Self-review của plan

- [x] Bao phủ bỏ toàn bộ, một phần, hoàn ngay, hoàn sau và thao tác chi sau.
- [x] Tiền quỹ không tăng khi ghi doanh thu; chỉ giảm khi chi thật.
- [x] Phiếu giữ lịch sử; trạng thái duyệt, xử lý cọc và hoàn tiền độc lập.
- [x] Có chặn FE, create_contract_v2, trigger legacy, link table và cửa sửa/đảo phiếu.
- [x] Có room holds, kỳ hạn, phòng sắp trống, nhiều cọc cùng phòng.
- [x] Có RLS, quyền duyệt/chi, kỳ khóa, idempotency, stale preview và concurrency.
- [x] Có báo cáo/KPI, dữ liệu hơn 1000 dòng, realtime và nguồn riêng reservation.*.
- [x] DTO và tên RPC thống nhất; các tên mới là hợp đồng thiết kế, không khẳng định đã tồn tại.
- [x] Test/gate trong các task là công việc triển khai tương lai, chưa được báo cáo là đã chạy.

Checklist trên lưu thứ tự công việc dự kiến; runbook ghi bằng chứng thực hiện, thay đổi artifact tương đương và trạng thái phát hành. Việc triển khai và phát hành dựa trên các yêu cầu rõ ràng sau đó của người dùng, không suy từ lựa chọn “hỗ trợ cả 2”.
