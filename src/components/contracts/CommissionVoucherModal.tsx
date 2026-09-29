import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

import {
  useCommissionPrefill,
  useCreateCommissionVoucher,
  usePrepareCommissionVouchers,
  useExistingCommissionVouchers,
  type CreateCommissionVoucherInput,
  type ExistingCommissionVoucher,
} from "@/hooks/useCommissionVoucher";
import { useSaleBonusStatus } from "@/hooks/useSaleBonus";
import { useContractCommissionFollowups } from "@/hooks/useContractCommissionFollowup";
import type { CommissionKind, PreparedCommissionRequest } from '@/lib/contractCommissionFollowup';
import { useAccounts } from "@/hooks/useAccounts";
import { useAuth } from "@/hooks/useAuth";
import { useOrganization } from "@/contexts/OrganizationContext";
import BankSelect from "@/components/income-expenses/BankSelect";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";
import { QlManagerSelectForBuilding } from "@/components/income-expenses/QlManagerSelect";
import {
  assignCommissionManager,
  invalidateAfterCommissionAssign,
  useOptionalQueryClient,
  type CommissionManagerOption,
} from "@/hooks/useCommissionManager";

interface CommissionVoucherModalProps {
  open: boolean;
  contractId: string | null;
  onOpenChange: (open: boolean) => void;
  onlyKind?: CommissionKind;
}

function formatVND(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(Math.round(n)) + " đ";
}

function formatDateVN(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")}-${String(
    d.getMonth() + 1
  ).padStart(2, "0")}-${d.getFullYear()}`;
}

/** Có phiếu chưa chứng minh khoản tiền đã được thanh toán. */
function ExistingVoucherBanner({
  voucher,
  label,
}: {
  voucher: ExistingCommissionVoucher;
  label: string;
}) {
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
      Đã có phiếu {label} cho HĐ này: <b>{voucher.code ?? "?"}</b> —{" "}
      <b>{formatVND(Number(voucher.total_amount) || 0)}</b>
      {voucher.approval_status === "UNAPPROVED" ? " (chờ duyệt)" : voucher.approval_status === "APPROVED" ? " (đã duyệt)" : ""}.
      {' '}Đã có phiếu không đồng nghĩa đã thanh toán. Đối chiếu tại Thu chi trước khi xử lý tiếp.
    </div>
  );
}

/**
 * Ô "Tên người nhận" kèm ô QL (migration 20260927155251): tích QL thì chọn quản lý
 * hưởng lương thay vì gõ tên. Phiếu tạo xong được gán cho quản lý đó và chuyển sang
 * sổ ảo "Hoa hồng QL chờ trả lương" — không chi từ sổ quỹ, tiền trả qua lương.
 */
function QlRecipientField({
  idPrefix,
  buildingId,
  ql,
  onQl,
  managerId,
  onManager,
  recipient,
  onRecipient,
}: {
  idPrefix: string;
  buildingId: string | null | undefined;
  ql: boolean;
  onQl: (v: boolean) => void;
  managerId: string;
  onManager: (m: CommissionManagerOption) => void;
  recipient: string;
  onRecipient: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs" htmlFor={`${idPrefix}-recipient`}>
          Tên người nhận
        </Label>
        <label className="flex items-center gap-1 text-xs font-medium cursor-pointer select-none">
          <input
            type="checkbox"
            id={`${idPrefix}-ql`}
            checked={ql}
            onChange={(e) => onQl(e.target.checked)}
            aria-label="Người nhận là quản lý (QL)"
          />
          QL
        </label>
      </div>
      {ql ? (
        <QlManagerSelectForBuilding
          id={`${idPrefix}-recipient`}
          buildingId={buildingId}
          value={managerId}
          onPick={onManager}
        />
      ) : (
        <Input
          id={`${idPrefix}-recipient`}
          value={recipient}
          onChange={(e) => onRecipient(e.target.value)}
        />
      )}
    </div>
  );
}

function QlNote() {
  return (
    <p className="col-span-2 md:col-span-3 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
      Hoa hồng của quản lý: phiếu sẽ chuyển sang sổ ảo <b>Hoa hồng QL chờ trả lương</b> —
      duyệt vẫn tính chi phí tòa nhưng <b>không chi tiền từ sổ quỹ</b>; tiền trả qua lương
      của quản lý.
    </p>
  );
}

export function CommissionVoucherModal({
  open,
  contractId,
  onOpenChange,
  onlyKind,
}: CommissionVoucherModalProps) {
  const { selectedOrganizationId } = useOrganization();
  const {
    data: prefill,
    isError: prefillFailed,
    error: prefillError,
    refetch: refetchPrefill,
  } = useCommissionPrefill(open ? contractId : null);
  const { data: accounts = [] } = useAccounts();
  const { data: authUser } = useAuth();
  const createVoucher = useCreateCommissionVoucher();
  const prepareVouchers = usePrepareCommissionVouchers();
  const queryClient = useOptionalQueryClient();

  // Chống chi lần 2: phiếu HH sống đã có của HĐ này (mỗi HĐ tối đa 1 phiếu/loại)
  const vouchersQuery = useExistingCommissionVouchers(
    open ? contractId : null
  );
  const existingVouchers = vouchersQuery.data ?? [];
  const existingBroker = existingVouchers.find(
    (v) => v.commission_kind === "broker"
  );
  const existingSale = existingVouchers.find(
    (v) => v.commission_kind === "sale"
  );

  // Thưởng Sale có thể đã được chi TỪ PHIẾU CỌC, lúc hợp đồng còn chưa tồn tại.
  // Phiếu đó `contract_id` rỗng nên `useExistingCommissionVouchers` KHÔNG thấy —
  // tin nó thì màn hình này mời người dùng thưởng lần hai cho cùng thương vụ.
  // `sale_bonus_status_v1` dò cả đường phiếu cọc → hợp đồng.
  const saleQuery = useSaleBonusStatus(open ? contractId : null);
  const saleBonus = saleQuery.data;
  const salePaidElsewhere = !!saleBonus?.alreadyPaid && !existingSale;
  const followups = useContractCommissionFollowups({ contractId: contractId ?? undefined, enabled: open && !!contractId });
  const [createdKinds, setCreatedKinds] = useState<string[]>([]);
  const brokerFollowup = followups.data?.rows.find(row => row.kind === 'broker');
  const saleFollowup = followups.data?.rows.find(row => row.kind === 'sale');
  const resolved = (row: typeof brokerFollowup) => row?.state === 'VOUCHER_CREATED' || row?.state === 'NOT_APPLICABLE';
  const brokerDone = !!existingBroker || resolved(brokerFollowup) || createdKinds.includes('broker');
  const saleDone = !!existingSale || salePaidElsewhere || resolved(saleFollowup) || createdKinds.includes('sale');
  const checkingVouchers = vouchersQuery.isLoading || saleQuery.isLoading || followups.isLoading;
  const checkFailed = vouchersQuery.isError || saleQuery.isError || followups.isError;
  const canCreate = onlyKind === 'broker' ? !!brokerFollowup?.can_manage : onlyKind === 'sale' ? !!saleFollowup?.can_manage
    : !!brokerFollowup?.can_manage && !!saleFollowup?.can_manage;
  const statusSources = useRef({ vouchersQuery, saleQuery, followups });
  statusSources.current = { vouchersQuery, saleQuery, followups };
  useEffect(() => {
    if (open && contractId) {
      const sources = statusSources.current;
      void Promise.all([sources.vouchersQuery.refetch(), sources.saleQuery.refetch(), sources.followups.refetch()]);
    }
  }, [open, contractId, selectedOrganizationId]);

  // ---- Form state (no react-hook-form — lightweight modal) ----
  const [accountId, setAccountId] = useState<string>("");
  const [voucherDate, setVoucherDate] = useState<string>("");

  // Mục 2 — Đơn vị MG
  const [brokerAmount, setBrokerAmount] = useState<number>(0);
  const [brokerName, setBrokerName] = useState<string>("");
  const [brokerAccountNumber, setBrokerAccountNumber] = useState<string>("");
  const [brokerBank, setBrokerBank] = useState<string>("");
  const [brokerRecipient, setBrokerRecipient] = useState<string>("");
  const [brokerAttachments, setBrokerAttachments] = useState<string[]>([]);
  const [brokerQl, setBrokerQl] = useState(false);
  const [brokerManagerId, setBrokerManagerId] = useState<string>("");

  // Mục 3 — Sale (optional). Sổ quỹ riêng: mặc định theo sổ quỹ chung (mục 1),
  // đổi được độc lập để chi thưởng nóng từ quỹ khác quỹ chi hoa hồng MG.
  const [saleAmount, setSaleAmount] = useState<number | "">("");
  const [saleName, setSaleName] = useState<string>("");
  const [saleAccountNumber, setSaleAccountNumber] = useState<string>("");
  const [saleBank, setSaleBank] = useState<string>("");
  const [saleRecipient, setSaleRecipient] = useState<string>("");
  const [saleAccountId, setSaleAccountId] = useState<string>("");
  const [saleAttachments, setSaleAttachments] = useState<string[]>([]);
  const [saleQl, setSaleQl] = useState(false);
  const [saleManagerId, setSaleManagerId] = useState<string>("");

  /**
   * Sổ quỹ mặc định = sổ CÙNG TÊN với toà nhà, chọn ngay trên danh sách dropdown
   * đang hiển thị.
   *
   * Trước 15/09/2026 việc này là một round-trip `accounts` chạy tuần tự sau
   * contracts bên trong prefill. Hai cái giá: prefill chậm gấp đôi (mà nó chạy
   * đúng lúc vừa tạo HĐ xong, giữa cơn bão refetch), và sổ nó chọn có thể KHÔNG
   * nằm trong dropdown này — dropdown lọc sổ DEMO còn truy vấn kia thì không —
   * nên ô sổ quỹ hiện trống mà không ai hiểu vì sao.
   */
  const defaultAccountId = useMemo(() => {
    const ten = prefill?.building_name?.trim().toLowerCase();
    if (!ten) return "";
    const khop = accounts.filter((a) => a.name?.trim().toLowerCase() === ten);
    return (khop.find((a) => a.is_default) ?? khop[0])?.id ?? "";
  }, [accounts, prefill?.building_name]);

  /**
   * Mồi form ĐÚNG MỘT LẦN cho mỗi hợp đồng.
   *
   * Bản cũ phụ thuộc identity của `prefill`, nên mỗi lần react-query trả về một
   * object mới — kể cả cùng dữ liệu y hệt — là toàn bộ ô người dùng đang gõ bị
   * đặt về rỗng. Đó chính là "form tự xoá" của bug 15/09/2026. Người dùng gõ tên
   * môi giới, hub realtime đánh thức prefill 1–2,5 giây sau, và cái họ vừa gõ
   * biến mất; số tiền còn "nhảy về" lúc rời ô vì CurrencyInput bỏ qua đồng bộ
   * khi đang focus.
   *
   * Neo theo `contract_id` thay vì theo object: refetch bao nhiêu lần cũng không
   * đụng tới thứ người dùng đã nhập. Đóng modal thì quên, để lần mở sau mồi lại.
   */
  const seededForContractId = useRef<string | null>(null);
  const seededAccountForContractId = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      seededForContractId.current = null;
      seededAccountForContractId.current = null;
      return;
    }
    if (!prefill) return;
    if (seededForContractId.current === prefill.contract_id) return;
    seededForContractId.current = prefill.contract_id;
    setCreatedKinds([]);

    setVoucherDate(prefill.signed_date);

    if (prefill.matched_tier) {
      const amount =
        Math.round((prefill.rent_price * prefill.matched_tier.rate_percent) / 100) || 0;
      setBrokerAmount(amount);
    } else {
      setBrokerAmount(0);
    }

    setBrokerName("");
    setBrokerAccountNumber("");
    setBrokerBank("");
    setBrokerRecipient("");
    setBrokerAttachments([]);
    setBrokerQl(false);
    setBrokerManagerId("");
    setSaleAmount("");
    setSaleName("");
    setSaleAccountNumber("");
    setSaleBank("");
    setSaleRecipient("");
    setSaleAttachments([]);
    setSaleQl(false);
    setSaleManagerId("");
  }, [open, prefill]);

  /**
   * Sổ quỹ mồi riêng một nhịp: danh sách sổ là truy vấn KHÁC prefill nên có thể
   * về sau. Gộp chung effect trên thì lần seed duy nhất rơi vào lúc danh sách
   * còn rỗng và ô sổ quỹ ở lại trống mãi. Vẫn chỉ mồi một lần cho mỗi hợp đồng,
   * nên sổ người dùng tự chọn không bị đặt lại.
   */
  useEffect(() => {
    if (!open || !prefill || !defaultAccountId) return;
    if (seededAccountForContractId.current === prefill.contract_id) return;
    seededAccountForContractId.current = prefill.contract_id;
    setAccountId((cur) => (cur === "" ? defaultAccountId : cur));
    setSaleAccountId((cur) => (cur === "" ? defaultAccountId : cur));
  }, [open, prefill, defaultAccountId]);

  const tierLabel = useMemo(() => {
    if (!prefill?.matched_tier) return null;
    const t = prefill.matched_tier;
    const exact =
      prefill.months >= Number(t.min_months) &&
      prefill.months <= Number(t.max_months);
    return exact
      ? `${t.rate_percent}% tiền phòng (mốc ${t.min_months}-${t.max_months} tháng)`
      : `${t.rate_percent}% tiền phòng (vượt mốc, áp dụng mốc cao nhất ${t.min_months}-${t.max_months} tháng)`;
  }, [prefill]);

  // % hoa hồng hiển thị (owner decision 23/07): ưu tiên mốc cấu hình khớp;
  // nếu không có mốc thì suy từ số tiền HH đang nhập / giá phòng.
  const commissionPercent =
    prefill?.matched_tier != null
      ? Number(prefill.matched_tier.rate_percent)
      : prefill && prefill.rent_price > 0 && brokerAmount > 0
      ? (brokerAmount / prefill.rent_price) * 100
      : null;

  const [submitting, setSubmitting] = useState(false);
  const activeSubmission = useRef<symbol>();
  useEffect(() => {
    activeSubmission.current = undefined;
    setSubmitting(false);
    return () => { activeSubmission.current = undefined; };
  }, [open, contractId, selectedOrganizationId]);

  const handleSubmit = async () => {
    if (!prefill) return;
    if (submitting || activeSubmission.current) return;
    if (checkingVouchers || checkFailed || !canCreate) return;

    const saleAmt = typeof saleAmount === "number" ? saleAmount : 0;
    // Loại đã có phiếu sống → skip (RPC + unique index vẫn chặn nếu lách)
    let willCreateBroker = onlyKind !== 'sale' && brokerAmount > 0 && !brokerDone;
    let willCreateSale = onlyKind !== 'broker' && saleAmt > 0 && !saleDone;

    if (!willCreateBroker && !willCreateSale) {
      if (existingBroker || existingSale || salePaidElsewhere) {
        toast.info(
          "HĐ này đã có phiếu hoa hồng. Kiểm tra tại Thu chi trước khi xử lý tiếp."
        );
      } else {
        toast.info("Chưa chọn số tiền để tạo phiếu.");
      }
      onOpenChange(false);
      return;
    }

    if ((willCreateBroker && brokerQl && !brokerManagerId) || (willCreateSale && saleQl && !saleManagerId)) {
      toast.error("Đã tích QL — hãy chọn quản lý nhận hoa hồng.");
      return;
    }

    // Gán quản lý NGAY sau khi tạo (ô QL). Lỗi gán không huỷ phiếu vừa tạo: phiếu ở
    // lại sổ đã chọn, báo rõ để gán lại ở màn Lương (khoản đó → "Chuyển sang trả qua lương").
    const ganQl = async (v: { id: string | null; code: string | null } | undefined, managerId: string) => {
      if (!v?.id || !managerId) return;
      try {
        await assignCommissionManager({ voucherId: v.id, managerId });
        await invalidateAfterCommissionAssign(queryClient);
      } catch (e) {
        toast.error(
          `Đã tạo phiếu ${v.code ?? ""} nhưng CHƯA gán quản lý: ${
            e instanceof Error ? e.message : "lỗi không xác định"
          }. Gán lại ở Lương → Thu nhập & thanh toán.`
        );
      }
    };

    setSubmitting(true);
    const submission = Symbol('commission submission');
    activeSubmission.current = submission;
    let created = 0;
    try {
      const [liveVouchers, liveSale, liveFollowups] = await Promise.all([
        vouchersQuery.refetch(), saleQuery.refetch(), followups.refetch(),
      ]);
      if (liveVouchers.isError || liveSale.isError || liveFollowups.isError || !liveFollowups.data || !liveVouchers.data) {
        throw new Error('Chưa đối chiếu được trạng thái hiện tại. Hãy tải lại trước khi tạo phiếu.');
      }
      if (activeSubmission.current !== submission) return;
      const liveRows = liveFollowups.data.rows;
      const liveBroker = liveRows.find(row => row.kind === 'broker');
      const liveSaleRow = liveRows.find(row => row.kind === 'sale');
      if ((willCreateBroker && !liveBroker) || (willCreateSale && !liveSaleRow))
        throw new Error('Chưa đọc đủ trạng thái hoa hồng của hợp đồng. Hãy đối chiếu lại trước khi tạo.');
      willCreateBroker = willCreateBroker && !!liveBroker?.can_manage && !resolved(liveBroker)
        && !liveVouchers.data.some(v => v.commission_kind === 'broker');
      willCreateSale = willCreateSale && !!liveSaleRow?.can_manage && !resolved(liveSaleRow)
        && !liveSale.data?.alreadyPaid && !liveVouchers.data.some(v => v.commission_kind === 'sale');
      if (!willCreateBroker && !willCreateSale) {
        toast.info('Trạng thái đã thay đổi hoặc đã có phiếu. Hãy đối chiếu lại trên hợp đồng.');
        if (activeSubmission.current === submission) onOpenChange(false);
        return;
      }
      const common = { contract_id: prefill.contract_id, contract_number: prefill.contract_number,
        building_id: prefill.building_id, room_id: prefill.room_id, tenant_id: prefill.tenant_id, voucher_date: voucherDate };
      const selected: CreateCommissionVoucherInput[] = [];
      if (willCreateBroker) selected.push({ ...common, kind: 'broker', account_id: accountId || null, amount: brokerAmount,
        payer_name: brokerName || null, recipient_name: brokerRecipient || null, recipient_bank: brokerBank || null,
        recipient_account_number: brokerAccountNumber || null, attachments: brokerAttachments,
        item_description: prefill.matched_tier ? `Hoa hồng MG (${prefill.matched_tier.rate_percent}% tiền phòng × ${prefill.months} tháng HĐ)`
          : `Hoa hồng MG (HĐ ${prefill.months} tháng — không khớp mốc cấu hình)` });
      if (willCreateSale) selected.push({ ...common, kind: 'sale', account_id: saleAccountId || null, amount: saleAmt,
        payer_name: saleName || null, recipient_name: saleRecipient || null, recipient_bank: saleBank || null,
        recipient_account_number: saleAccountNumber || null, attachments: saleAttachments,
        item_description: `Thưởng nóng Sale HĐ ${prefill.months} tháng` });
      // Saved failed intents execute exactly their private payload; new positive selections are prepared together.
      const saved = new Map<CommissionKind, PreparedCommissionRequest>();
      for (const input of selected) {
        const live = liveRows.find(row => row.kind === input.kind);
        if (live?.can_retry && live.request_id && (live.state === 'FAILED' || live.state === 'UNKNOWN')) {
          saved.set(input.kind, { contract_id: input.contract_id, kind: input.kind, request_id: live.request_id });
        } else if (live?.state === 'PROCESSING') throw new Error('Yêu cầu đang được xử lý. Hãy kiểm tra lại trạng thái.');
      }
      const newInputs = selected.filter(input => !saved.has(input.kind));
      const prepared = newInputs.length ? await prepareVouchers.mutateAsync(newInputs) : [];
      for (const receipt of prepared) saved.set(receipt.kind, receipt);
      if (selected.some(input => !saved.has(input.kind))) throw new Error('Chưa xác nhận đầy đủ yêu cầu tạo phiếu; chưa gửi tạo phiếu chi.');
      // Tạo tuần tự để tránh race condition trên trigger
      // auto_generate_voucher_code (đọc MAX(seq) — 2 insert song song có thể
      // sinh trùng code → vi phạm idx_income_expenses_unique_code_per_user).
      if (willCreateBroker) {
        const v = await createVoucher.mutateAsync({
          contract_id: prefill.contract_id,
          contract_number: prefill.contract_number,
          building_id: prefill.building_id,
          room_id: prefill.room_id,
          tenant_id: prefill.tenant_id,
          account_id: accountId || null,
          voucher_date: voucherDate,
          kind: "broker",
          preparedRequest: saved.get('broker'),
          amount: brokerAmount,
          payer_name: brokerName || null,
          recipient_name: brokerRecipient || null,
          recipient_bank: brokerBank || null,
          recipient_account_number: brokerAccountNumber || null,
          attachments: brokerAttachments,
          item_description: prefill.matched_tier
            ? `Hoa hồng MG (${prefill.matched_tier.rate_percent}% tiền phòng × ${prefill.months} tháng HĐ)`
            : `Hoa hồng MG (HĐ ${prefill.months} tháng — không khớp mốc cấu hình)`,
        });
        if (v.status === 'ALREADY_EXISTS') toast.info(`Đã có phiếu${v.code ? ` ${v.code}` : ''}.`); else created++;
        if (activeSubmission.current === submission) setCreatedKinds(kinds => [...kinds, 'broker']);
        if (brokerQl) await ganQl(v, brokerManagerId);
      }

      if (willCreateSale) {
        const v = await createVoucher.mutateAsync({
          contract_id: prefill.contract_id,
          contract_number: prefill.contract_number,
          building_id: prefill.building_id,
          room_id: prefill.room_id,
          tenant_id: prefill.tenant_id,
          account_id: saleAccountId || null,
          voucher_date: voucherDate,
          kind: "sale",
          preparedRequest: saved.get('sale'),
          amount: saleAmt,
          payer_name: saleName || null,
          recipient_name: saleRecipient || null,
          recipient_bank: saleBank || null,
          recipient_account_number: saleAccountNumber || null,
          attachments: saleAttachments,
          item_description: `Thưởng nóng Sale HĐ ${prefill.months} tháng`,
        });
        if (v.status === 'ALREADY_EXISTS') toast.info(`Đã có phiếu${v.code ? ` ${v.code}` : ''}.`); else created++;
        if (activeSubmission.current === submission) setCreatedKinds(kinds => [...kinds, 'sale']);
        if (saleQl) await ganQl(v, saleManagerId);
      }

      if (created) toast.success(
        `Đã tạo ${created} phiếu hoa hồng / thưởng Sale cho HĐ ${
          prefill.contract_number ?? ""
        }`
      );
      if (activeSubmission.current === submission) onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Chưa xác minh được kết quả tạo phiếu. Hãy kiểm tra lại trạng thái.');
    } finally {
      if (activeSubmission.current === submission) {
        activeSubmission.current = undefined;
        setSubmitting(false);
      }
    }
  };

  const isPending = submitting || createVoucher.isPending || prepareVouchers.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="text-green-700 uppercase">
            Tạo phiếu chi hoa hồng
          </DialogTitle>
          <DialogDescription>
            Hợp đồng đã được tạo. Vui lòng xác nhận thông tin chi hoa hồng cho
            đơn vị môi giới và (nếu có) thưởng nóng Sale.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-180px)] px-6 pb-2">
          {prefillFailed ? (
            /* Lỗi phải NHÌN THẤY được và phải có đường ra. Bản cũ nuốt lỗi rồi
               hiện mãi dòng "Đang tải..." — người dùng không biết chuyện gì, chờ
               bao lâu cũng vậy, và nút Tạo phiếu disable vĩnh viễn. */
            <div className="py-8 text-center text-sm space-y-3">
              <p className="text-destructive">
                Không tải được thông tin hợp đồng.
              </p>
              <p className="text-muted-foreground">
                {prefillError instanceof Error
                  ? prefillError.message
                  : "Lỗi không xác định."}
              </p>
              <Button type="button" variant="outline" onClick={() => void refetchPrefill()}>
                Tải lại
              </Button>
            </div>
          ) : !prefill ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Đang tải thông tin hợp đồng...
            </div>
          ) : checkingVouchers || checkFailed || !canCreate ? <div className="p-6 text-sm space-y-2">
            {checkingVouchers ? <p role="status">Đang đối chiếu phiếu hiện có...</p> : checkFailed ? <>
              <p role="alert">Chưa đối chiếu được phiếu hiện có. Hãy tải lại trước khi tạo để tránh trùng phiếu.</p>
              <Button variant="outline" onClick={() => { void vouchersQuery.refetch(); void saleQuery.refetch(); void followups.refetch(); }}>Đối chiếu lại</Button>
            </> : <p>Bạn chưa có quyền xử lý hoa hồng của hợp đồng này.</p>}
          </div> : (
            <div className="space-y-6 pb-2">
              {checkingVouchers ? <p role="status" className="text-sm text-muted-foreground">Đang đối chiếu phiếu hiện có...</p>
                : checkFailed ? <div role="alert" className="text-sm text-destructive space-y-2">
                  <p>Chưa đối chiếu được phiếu hiện có. Hãy tải lại trước khi tạo để tránh trùng phiếu.</p>
                  <Button variant="outline" onClick={() => { void vouchersQuery.refetch(); void saleQuery.refetch(); void followups.refetch(); }}>Đối chiếu lại</Button>
                </div> : !canCreate ? <p role="alert" className="text-sm text-muted-foreground">Bạn chưa có quyền xử lý hoa hồng của hợp đồng này.</p> : null}
              {/* Metadata HĐ (owner decision 2026-07-23): Phòng/Tòa, thời hạn
                  HĐ, giá phòng, % hoa hồng — read-only, không đổi logic tạo. */}
              <div className="rounded-md border bg-muted/40 px-3 py-2.5 text-sm grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Phòng / Tòa</span>
                  <span className="font-medium text-right">
                    {prefill.room_name ?? "—"} / {prefill.building_name || "—"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    Ngày bắt đầu – kết thúc HĐ
                  </span>
                  <span className="font-medium text-right">
                    {formatDateVN(prefill.start_date)} –{" "}
                    {formatDateVN(prefill.end_date)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Giá phòng</span>
                  <span className="font-medium text-right">
                    {formatVND(prefill.rent_price)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    % hoa hồng (tính theo giá phòng)
                  </span>
                  <span className="font-medium text-right">
                    {commissionPercent != null
                      ? `${(
                          Math.round(commissionPercent * 100) / 100
                        ).toLocaleString("vi-VN")}%`
                      : "—"}
                  </span>
                </div>
              </div>

              {/* Mục 1: Thông tin chung */}
              <div className="space-y-3">
                <h3 className="font-medium">1. THÔNG TIN CHUNG</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Tòa nhà</Label>
                    <Input value={prefill.building_name} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Phòng</Label>
                    <Input value={prefill.room_name ?? ""} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Mã hợp đồng</Label>
                    <Input value={prefill.contract_number ?? ""} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Khách hàng</Label>
                    <Input value={prefill.tenant_name ?? ""} disabled />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Số tháng HĐ</Label>
                    <Input
                      value={`${prefill.months} tháng${
                        tierLabel ? ` — ${tierLabel}` : " — không khớp mốc"
                      }`}
                      disabled
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Ngày phiếu</Label>
                    <DateInput
                      value={voucherDate}
                      onChange={setVoucherDate}
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs">Sổ quỹ (chi hoa hồng MG)</Label>
                    <Select
                      value={accountId}
                      onValueChange={(v) => setAccountId(v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn sổ quỹ..." />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((a: any) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {defaultAccountId && (
                      <p className="text-xs text-muted-foreground">
                        Mặc định: sổ quỹ cùng tên với tòa nhà.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <Separator />

              {/* Mục 2: Đơn vị MG */}
              {onlyKind !== 'sale' && <div className="space-y-3">
                <h3 className="font-medium">2. ĐƠN VỊ MÔI GIỚI</h3>
                {existingBroker ? (
                  <ExistingVoucherBanner
                    voucher={existingBroker}
                    label="hoa hồng môi giới"
                  />
                ) : brokerDone ? <p className="text-sm text-muted-foreground">{brokerFollowup?.state === 'NOT_APPLICABLE' ? 'Đã ghi nhận không phát sinh hoa hồng môi giới. Có thể mở lại tại phần theo dõi trên hợp đồng.' : 'Đã có phiếu hoa hồng môi giới; đối chiếu tại Thu chi.'}</p> : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Số tiền hoa hồng *</Label>
                    <CurrencyInput
                      value={brokerAmount}
                      onChange={(v) => setBrokerAmount(v || 0)}
                    />
                    {brokerAmount > 0 && (
                      <p className="text-xs text-muted-foreground">
                        ≈ {formatVND(brokerAmount)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tên đơn vị MG</Label>
                    <Input
                      value={brokerName}
                      onChange={(e) => setBrokerName(e.target.value)}
                      placeholder="Tên công ty / cá nhân môi giới"
                    />
                  </div>
                  <QlRecipientField
                    idPrefix="hh-broker"
                    buildingId={prefill.building_id}
                    ql={brokerQl}
                    onQl={(v) => {
                      setBrokerQl(v);
                      if (!v) setBrokerManagerId("");
                    }}
                    managerId={brokerManagerId}
                    onManager={(m) => {
                      setBrokerManagerId(m.staffId);
                      setBrokerRecipient(m.displayName);
                      setBrokerName((cur) => cur || m.alias || m.displayName);
                    }}
                    recipient={brokerRecipient}
                    onRecipient={setBrokerRecipient}
                  />
                  {brokerQl && <QlNote />}
                  <div className="space-y-1">
                    <Label className="text-xs">Số tài khoản</Label>
                    <Input
                      value={brokerAccountNumber}
                      onChange={(e) => setBrokerAccountNumber(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs">Ngân hàng</Label>
                    <BankSelect
                      value={brokerBank}
                      onChange={setBrokerBank}
                      className="h-10"
                    />
                  </div>
                  {authUser?.id && (
                    <div className="space-y-1 col-span-2 md:col-span-3">
                      <Label className="text-xs">
                        Ảnh chứng từ hoa hồng MG
                      </Label>
                      <AttachmentUpload
                        attachments={brokerAttachments}
                        onChange={setBrokerAttachments}
                        userId={authUser.id}
                      />
                    </div>
                  )}
                </div>
                )}
              </div>}

              <Separator />

              {/* Mục 3: Sale optional */}
              {onlyKind !== 'broker' && <div className="space-y-3">
                <h3 className="font-medium">
                  3. THƯỞNG NÓNG SALE{" "}
                  <span className="text-xs text-muted-foreground font-normal">
                    (tuỳ chọn — chỉ tạo phiếu khi có số tiền)
                  </span>
                </h3>
                {existingSale ? (
                  <ExistingVoucherBanner
                    voucher={existingSale}
                    label="thưởng nóng Sale"
                  />
                ) : salePaidElsewhere ? (
                  /* Đã thưởng từ PHIẾU CỌC — tô xám, nói rõ bao nhiêu và khi nào. */
                  <div className="rounded-md border bg-muted/50 p-3 text-sm space-y-1">
                    <div className="font-medium text-muted-foreground">
                      Hợp đồng này đã có phiếu thưởng Sale từ phiếu cọc
                    </div>
                    <p className="text-muted-foreground">{saleBonus?.code ? `Phiếu ${saleBonus.code}. ` : ''}Đã có phiếu không đồng nghĩa đã thanh toán.</p>
                    {saleBonus?.status === "UNAPPROVED" && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Phiếu đó đang chờ duyệt.
                      </p>
                    )}
                  </div>
                ) : saleDone ? <p className="text-sm text-muted-foreground">{saleFollowup?.state === 'NOT_APPLICABLE' ? 'Đã ghi nhận không phát sinh thưởng Sale. Có thể mở lại tại phần theo dõi trên hợp đồng.' : 'Đã có phiếu thưởng Sale; đối chiếu tại Thu chi.'}</p> : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Số tiền thưởng</Label>
                    <CurrencyInput
                      value={typeof saleAmount === "number" ? saleAmount : null}
                      onChange={(v) => setSaleAmount(v === 0 ? "" : v)}
                      placeholder="Để trống nếu không có"
                    />
                    {typeof saleAmount === "number" && saleAmount > 0 && (
                      <p className="text-xs text-muted-foreground">
                        ≈ {formatVND(saleAmount)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tên Sale</Label>
                    <Input
                      value={saleName}
                      onChange={(e) => setSaleName(e.target.value)}
                    />
                  </div>
                  <QlRecipientField
                    idPrefix="hh-sale"
                    buildingId={prefill.building_id}
                    ql={saleQl}
                    onQl={(v) => {
                      setSaleQl(v);
                      if (!v) setSaleManagerId("");
                    }}
                    managerId={saleManagerId}
                    onManager={(m) => {
                      setSaleManagerId(m.staffId);
                      setSaleRecipient(m.displayName);
                      setSaleName((cur) => cur || m.alias || m.displayName);
                    }}
                    recipient={saleRecipient}
                    onRecipient={setSaleRecipient}
                  />
                  {saleQl && <QlNote />}
                  <div className="space-y-1">
                    <Label className="text-xs">Số tài khoản</Label>
                    <Input
                      value={saleAccountNumber}
                      onChange={(e) => setSaleAccountNumber(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label className="text-xs">Ngân hàng</Label>
                    <BankSelect
                      value={saleBank}
                      onChange={setSaleBank}
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-1 col-span-2 md:col-span-2">
                    <Label className="text-xs">Sổ quỹ chi thưởng nóng</Label>
                    <Select
                      value={saleAccountId}
                      onValueChange={(v) => setSaleAccountId(v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn sổ quỹ..." />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((a: any) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Riêng cho thưởng nóng — mặc định theo sổ quỹ chung ở mục 1.
                    </p>
                  </div>
                  {authUser?.id && (
                    <div className="space-y-1 col-span-2 md:col-span-3">
                      <Label className="text-xs">
                        Ảnh chứng từ thưởng nóng
                      </Label>
                      <AttachmentUpload
                        attachments={saleAttachments}
                        onChange={setSaleAttachments}
                        userId={authUser.id}
                      />
                    </div>
                  )}
                </div>
                )}
              </div>}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="px-6 pb-6 pt-2 gap-2">
          {/* Đường ra LUÔN mở. Phiếu hoa hồng là bước tuỳ chọn sau khi hợp đồng
              đã tạo xong; khoá nút này lại là nhốt người dùng trong một hộp thoại
              vì một truy vấn phụ hỏng. Bấm giữa lúc đang tạo phiếu cũng không mất
              gì: mutation vẫn chạy tới nơi và tự báo kết quả bằng toast. */}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Để xử lý sau
          </Button>
          <Button
            type="button"
            className="bg-green-600 hover:bg-green-700"
            onClick={handleSubmit}
            disabled={
              isPending || !prefill || checkingVouchers || checkFailed || !canCreate || (onlyKind === 'broker' ? brokerDone : onlyKind === 'sale' ? saleDone : brokerDone && saleDone)
            }
          >
            {isPending
              ? "Đang tạo..."
              : brokerDone && saleDone
              ? "Đã xử lý cả hai khoản"
              : "Tạo phiếu chi"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
