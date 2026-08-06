import { useEffect, useState, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { contractFormSchema } from "@/lib/contractValidation";
import type { ContractFormData } from "@/lib/contractValidation";
import { calculateContractDepositBalance } from "@/lib/contractCreateRpc";
import { describeDepositAdjustment } from "@/lib/contractPriceAdjustment";
import type { ContractWithRelations, PaymentCycle } from "@/types/contract";
import {
  useCreateContract,
  useSyncContractCustomers,
  useSyncContractServices,
  useUpdateContract,
} from "@/hooks/useContracts";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useBuildingServices } from "@/hooks/useBuildingServices";
import type { BuildingServiceWithDetails } from "@/types/building";
import type { CustomerBasic } from "../CustomerSelectionDialog";
import type { ServiceBasic } from "../ServiceSelectionDialog";
import {
  buildFirstInvoiceItems,
  buildFirstInvoiceDiscount,
  normalizeFirstBillingPeriod,
  type FirstInvoiceItem,
} from "@/lib/firstInvoiceBuilder";
import { useOrphanDepositVouchers } from "@/hooks/useDeposits";
import { useAccounts, type Account } from "@/hooks/useAccounts";
import { useAuth } from "@/hooks/useAuth";
import { todayISO } from '@/lib/collect';
import {
  nextDepositUid,
  type ContractPrefill,
  type DepositRow,
  type SelectedCustomer,
  type SelectedService,
} from "./types";

interface UseContractFormStateParams {
  open: boolean;
  contract?: ContractWithRelations;
  prefill?: ContractPrefill;
}

/** Sổ quỹ được phép nhận tiền cọc: CHỈ sổ THẬT, không bao giờ là sổ ảo.
 *
 * `create_contract_v2` chặn sổ ảo bằng `NOT accounts.is_virtual` rồi ném 42501
 * "Sổ quỹ cọc không thuộc tổ chức" — và 42501 lại hiện thành toast "Không đủ
 * quyền", nên user tưởng mình bị khoá quyền chứ không phải chọn nhầm sổ.
 *
 * ÁN LỆ 27/07/2026 (tk joey, phòng 503 158PVC): sổ đứng đầu danh sách của joey
 * là "Cấn trừ thanh lý (nội bộ)" — sổ ảo — nên form tự chọn nó, mọi lần lưu HĐ
 * đều đỏ. Chủ nhà không dính vì sổ đầu danh sách của họ là sổ thật.
 */
export const selectDepositAccounts = (accounts: Account[]): Account[] =>
  accounts.filter((a) => !a.is_virtual);

/** Sổ quỹ mặc định cho dòng cọc mới: ƯU TIÊN sổ của CHÍNH user hiện tại (staff
 *  route cọc vào sổ mình, không vào sổ owner). Fallback sổ bất kỳ nếu user chưa
 *  có sổ riêng (vd owner thấy mọi sổ). Chỉ nhận danh sách đã lọc sổ ảo. */
export const pickDefaultDepositAccountId = (
  accounts: Account[],
  userId: string | undefined,
): string => {
  const mine = accounts.filter((a) => a.user_id === userId);
  return (
    mine.find((a) => a.is_default)?.id ??
    mine[0]?.id ??
    accounts.find((a) => a.is_default)?.id ??
    accounts[0]?.id ??
    ""
  );
};

/**
 * Toàn bộ state + derived values + handlers của form HĐ — tách CƠ HỌC từ
 * ContractFormDialog (logic giữ NGUYÊN VĂN, chỉ chuyển chỗ). Submit
 * orchestration nằm riêng ở useContractSubmit.
 */
export function useContractFormState({
  open,
  contract,
  prefill,
}: UseContractFormStateParams) {
  const isEditMode = !!contract;

  // Mutations
  const createContract = useCreateContract();
  const updateContract = useUpdateContract();
  const syncCustomers = useSyncContractCustomers();
  const syncServices = useSyncContractServices();
  const isPending =
    createContract.isPending ||
    updateContract.isPending ||
    syncCustomers.isPending ||
    syncServices.isPending;

  // Data hooks
  const { data: buildings = [] } = useBuildings();

  // Cascading state
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>("");
  const [selectedRoomId, setSelectedRoomId] = useState<string>("");

  const { data: rooms = [] } = useRooms(selectedBuildingId || undefined);

  // Filtered rooms for cascading
  const filteredRooms = useMemo(
    () => (selectedBuildingId ? rooms : []),
    [rooms, selectedBuildingId]
  );

  // Customer & service local state
  const [selectedCustomers, setSelectedCustomers] = useState<SelectedCustomer[]>([]);
  const [selectedServices, setSelectedServices] = useState<SelectedService[]>([]);
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);

  // Nút gạt "Dùng dịch vụ riêng cho HĐ". OFF (mặc định) = HĐ dùng dịch vụ của
  // toà → KHÔNG lưu contract_services, hoá đơn tự fallback đơn giá toà. ON =
  // HĐ có dịch vụ riêng (seed từ toà rồi thêm/bớt/sửa) → lưu contract_services
  // và hoá đơn lấy đúng theo HĐ. Khớp luồng resolveInvoicePricing.
  const [useCustomServices, setUseCustomServices] = useState(false);

  // Dịch vụ đang BẬT của toà — dùng để (1) hiển thị preview mờ khi OFF, (2)
  // seed vào dịch vụ riêng khi user bật nút gạt lần đầu.
  const { data: buildingServicesData = [] } = useBuildingServices(selectedBuildingId);
  const buildingActiveServices = useMemo(
    () =>
      (buildingServicesData as BuildingServiceWithDetails[]).filter(
        (b) => b.is_active,
      ),
    [buildingServicesData],
  );
  const buildingServicesAsSelected = useMemo<SelectedService[]>(
    () =>
      buildingActiveServices.map((b) => ({
        id: b.service_id,
        name: b.service?.name ?? "",
        unit_price: b.unit_price_override ?? b.service?.unit_price ?? 0,
        unit: b.service?.unit ?? null,
        type: b.service?.type ?? "",
        pricing_type: b.service?.pricing_type ?? null,
        initial_reading: 0,
        quantity:
          b.service?.pricing_type === "DON_GIA_THEO_NGUOI"
            ? Math.max(1, selectedCustomers.length)
            : 1,
      })),
    [buildingActiveServices, selectedCustomers.length],
  );

  // Invoice preview (hoá đơn cọc + tháng đầu) — items được tự sinh từ
  // rent/cọc/services, user có thể chỉnh trực tiếp; khi lưu HĐ items này
  // được dùng làm nội dung hoá đơn. Reset khi inputs đổi (xem useEffect).
  const [invoiceItems, setInvoiceItems] = useState<FirstInvoiceItem[]>([]);

  // RPC creates deposit receipts atomically; the form only needs accounts for
  // selecting the real cashbook of each receipt row.
  const { data: allAccounts = [] } = useAccounts({ enabled: open });
  const { data: authUser } = useAuth();

  const accounts = useMemo(
    () => selectDepositAccounts(allAccounts),
    [allAccounts],
  );

  // Danh sách dòng "Đã đặt cọc": mỗi dòng = 1 lần khách đưa cọc → 1 phiếu thu
  // cọc (is_deposit) vào SỔ QUỸ THẬT đã chọn (sổ CỌC chỉ là sổ ảo theo dõi).
  const [depositRows, setDepositRows] = useState<DepositRow[]>([]);
  // Khoá/mở 2 ô tiền. KHOÁ (xám + nút bút chì) = bám mặc định:
  //   - "Tiền thuê"  bám giá niêm yết của phòng (rooms.rent_price)
  //   - "Tiền cọc"   bám tiền thuê của hợp đồng
  // MỞ KHOÁ = user tự quyết → ngừng auto-đồng bộ, và việc lệch mặc định được
  // lưu dấu (room_price_history + dòng ghi chú "[Điều chỉnh cọc]").
  const [rentUnlocked, setRentUnlocked] = useState(false);
  const [depositUnlocked, setDepositUnlocked] = useState(false);
  const defaultDepositAccountId = useMemo(
    () => pickDefaultDepositAccountId(accounts, authUser?.id),
    [accounts, authUser?.id],
  );

  // Commission voucher modal — open after successful create (not edit)
  const [commissionContractId, setCommissionContractId] = useState<string | null>(null);

  // Form
  const form = useForm<ContractFormData>({
    resolver: zodResolver(contractFormSchema),
    defaultValues: {
      room_id: "",
      signed_date: todayISO(),
      start_date: "",
      end_date: "",
      rent_price: 0,
      total_deposit: 0,
      deposit_paid: 0,
      deposit_account_id: null,
      payment_cycle: "MONTHLY" as PaymentCycle,
      start_billing_date: "",
      end_billing_date: "",
      contract_template_id: null,
      invoice_template_id: null,
      notes: "",
      discount_months: 0,
      discount_amount_per_month: 0,
      deposit_debt_acknowledged: false,
      deposit_debt_mode: undefined,
      deposit_debt_reason: "",
      deposit_topup_due_date: "",
    },
  });

  const totalDeposit = form.watch("total_deposit") ?? 0;
  const depositDebtMode = form.watch("deposit_debt_mode");
  // Tổng cọc user nhập ở các dòng "Đã đặt cọc".
  const typedDepositTotal = useMemo(
    () => depositRows.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    [depositRows],
  );

  // ---- Cọc đã thu trước của phòng (phiếu IE mồ côi: giữ chỗ / cọc trước) ----
  // create_contract_v2 receives approved voucher IDs explicitly, links them,
  // then recomputes deposit_paid in the same transaction. Vì vậy:
  //  - hiển thị dòng XÁM read-only để quản lý biết đã có phiếu cọc nào;
  //  - chỉ tính phiếu ĐÃ DUYỆT vào "đã đặt cọc" (recompute chỉ cộng APPROVED);
  //  - KHÔNG tạo lại phiếu cho các dòng này (tránh double-count deposit_paid).
  const startDateWatch = form.watch("start_date");
  const { data: orphanDepositVouchers = [] } = useOrphanDepositVouchers(
    !isEditMode && open ? selectedRoomId || undefined : undefined,
    startDateWatch || undefined,
  );
  const approvedOrphanTotal = useMemo(
    () =>
      orphanDepositVouchers
        .filter((v) => v.approval_status === "APPROVED")
        .reduce((sum, v) => sum + (Number(v.total_amount) || 0), 0),
    [orphanDepositVouchers],
  );

  // Cọc đã đặt = dòng user nhập + phiếu cọc cũ ĐÃ DUYỆT (khớp recompute DB).
  const depositPaidTotal = typedDepositTotal + approvedOrphanTotal;
  const depositBalance = calculateContractDepositBalance(
    totalDeposit,
    depositPaidTotal,
  );
  const depositRemaining = depositBalance.shortfall;
  // Chặn ký khi thiếu cọc (chênh ≥ ngưỡng làm tròn) mà chưa chọn cách xử lý
  // (Nợ cọc / Đóng đủ). Chỉ áp dụng lúc tạo mới — edit không khoá.
  const depositShortfall = depositBalance.requiresResolution;
  const blockByDepositDebt = !isEditMode && depositShortfall && !depositDebtMode;

  useEffect(() => {
    if (isEditMode || depositShortfall) return;
    if (form.getValues("deposit_debt_mode") !== undefined) {
      form.setValue("deposit_debt_mode", undefined);
    }
    if (form.getValues("deposit_debt_reason")) {
      form.setValue("deposit_debt_reason", "");
    }
    if (form.getValues("deposit_topup_due_date")) {
      form.setValue("deposit_topup_due_date", "");
    }
    if (form.getValues("deposit_debt_acknowledged")) {
      form.setValue("deposit_debt_acknowledged", false);
    }
  }, [depositShortfall, form, isEditMode]);

  // ---- Helpers thao tác dòng cọc ----
  const addDepositRow = (amount = 0) =>
    setDepositRows((p) => [
      ...p,
      {
        uid: nextDepositUid(),
        amount,
        account_id: p[p.length - 1]?.account_id || defaultDepositAccountId,
        received_date:
          form.getValues("signed_date") ||
          todayISO(),
        images: [],
      },
    ]);
  const updateDepositRow = (uid: string, patch: Partial<DepositRow>) =>
    setDepositRows((p) => p.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const removeDepositRow = (uid: string) =>
    setDepositRows((p) => p.filter((r) => r.uid !== uid));

  // ---- Giá mặc định của PHÒNG (nguồn của ô "Tiền thuê" khi còn khoá) ----
  const selectedRoom = useMemo(
    () => rooms.find((r) => r.id === selectedRoomId),
    [rooms, selectedRoomId],
  );
  const roomDefaultRent = Number(selectedRoom?.rent_price ?? 0);

  const rentForDepositDefault = form.watch("rent_price") ?? 0;

  // ---- Reset form when dialog opens ----
  useEffect(() => {
    if (!open) return;

    if (contract) {
      // Edit mode: pre-populate
      const buildingId = contract.room?.building_id ?? "";
      setSelectedBuildingId(buildingId);
      setSelectedRoomId(contract.room_id ?? "");
      setDepositRows([]);
      // Sửa HĐ: cả 2 ô đều KHOÁ (xám) hiển thị giá đã ký — muốn đổi phải bấm
      // bút chì. Không auto-đồng bộ gì ở chế độ sửa.
      setRentUnlocked(false);
      setDepositUnlocked(false);

      form.reset({
        room_id: contract.room_id ?? "",
        signed_date: contract.signed_date?.split("T")[0] ?? "",
        start_date: contract.start_date?.split("T")[0] ?? "",
        end_date: contract.end_date?.split("T")[0] ?? "",
        rent_price: contract.rent_price ?? 0,
        total_deposit: contract.total_deposit ?? 0,
        deposit_paid: contract.deposit_paid ?? 0,
        deposit_account_id: null,
        payment_cycle: contract.payment_cycle ?? "MONTHLY",
        start_billing_date: contract.start_billing_date?.split("T")[0] ?? "",
        end_billing_date: contract.end_billing_date?.split("T")[0] ?? "",
        contract_template_id: contract.contract_template_id ?? null,
        invoice_template_id: contract.invoice_template_id ?? null,
        notes: contract.notes ?? "",
        discount_months: contract.discounts?.months ?? 0,
        discount_amount_per_month: contract.discounts?.amount_per_month ?? 0,
        deposit_debt_acknowledged:
          (contract as any).deposit_debt_acknowledged ?? false,
        deposit_debt_mode: (contract as any).deposit_debt_mode ?? undefined,
        deposit_debt_reason: (contract as any).deposit_debt_reason ?? "",
        deposit_topup_due_date:
          (contract as any).deposit_topup_due_date?.split("T")[0] ?? "",
      });

      // Pre-populate customers
      const customers: SelectedCustomer[] =
        contract.contract_customers?.map((cc) => ({
          id: cc.customer_id,
          full_name: cc.customer?.full_name ?? "",
          phone: cc.customer?.phone ?? "",
          id_number: cc.customer?.id_number ?? null,
          is_representative: cc.is_representative,
          notes: cc.notes ?? null,
        })) ?? [];
      setSelectedCustomers(customers);

      // Pre-populate services
      const services: SelectedService[] =
        contract.contract_services?.map((cs) => ({
          id: cs.service_id,
          name: cs.service?.name ?? "",
          unit_price: cs.unit_price,
          unit: cs.service?.unit ?? null,
          type: cs.service?.type ?? "",
          pricing_type: cs.service?.pricing_type ?? null,
          initial_reading: cs.initial_reading ?? 0,
          quantity: 1,
        })) ?? [];
      setSelectedServices(services);
      // HĐ đã có dịch vụ riêng → bật nút gạt; chưa có → dùng mặc định toà.
      setUseCustomServices(services.length > 0);
    } else {
      // Create mode: reset (áp prefill nếu mở từ flow Cọc giữ chỗ / Building map)
      setSelectedBuildingId(prefill?.buildingId ?? "");
      setSelectedRoomId(prefill?.roomId ?? "");
      setSelectedCustomers([]);
      setSelectedServices([]);
      setUseCustomServices(false);
      setDepositRows([]);
      setRentUnlocked(false);
      // prefill từ Cọc giữ chỗ: total_deposit theo cọc đã đưa → mở khoá sẵn ô
      // cọc để tiền thuê không auto đè. Phiếu giữ chỗ hiện ở dòng cọc cũ (xám).
      setDepositUnlocked(!!prefill?.depositAmount);
      form.reset({
        room_id: prefill?.roomId ?? "",
        signed_date: todayISO(),
        start_date: "",
        end_date: "",
        rent_price: 0,
        total_deposit: prefill?.depositAmount ?? 0,
        deposit_paid: 0,
        deposit_account_id: null,
        payment_cycle: "MONTHLY",
        start_billing_date: "",
        end_billing_date: "",
        contract_template_id: null,
        invoice_template_id: null,
        notes: "",
        discount_months: 0,
        discount_amount_per_month: 0,
        deposit_debt_acknowledged: false,
        deposit_debt_mode: undefined,
        deposit_debt_reason: "",
        deposit_topup_due_date: "",
      });
    }
  }, [open, contract, form, prefill]);

  // Hai effect "bám mặc định" phải khai báo SAU effect reset ở trên: React chạy
  // effect theo thứ tự khai báo, nên nếu đặt trước thì trong cùng một commit
  // `form.reset()` sẽ ghi đè giá vừa điền (ô Tiền thuê về 0) mà dependency
  // không đổi → hết cơ hội chạy lại. Ca dính: mở lại dialog cho ĐÚNG phòng vừa
  // mở (prefill từ Cọc giữ chỗ / Sơ đồ toà) — selectedRoomId chưa kịp đổi.

  // "Tiền thuê" mặc định = giá niêm yết của phòng, tự đổi theo phòng được chọn.
  // Chỉ ở chế độ TẠO MỚI: form sửa phải giữ nguyên giá đã ký của HĐ.
  useEffect(() => {
    if (isEditMode || !open) return;
    if (rentUnlocked) return;
    if ((form.getValues("rent_price") ?? 0) === roomDefaultRent) return;
    form.setValue("rent_price", roomDefaultRent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomDefaultRent, rentUnlocked, isEditMode, open]);

  // "Tiền cọc" mặc định = tiền thuê khi ô cọc CÒN KHOÁ (chỉ tạo mới).
  useEffect(() => {
    if (isEditMode || !open) return;
    if (depositUnlocked) return;
    if ((form.getValues("total_deposit") ?? 0) === (rentForDepositDefault ?? 0)) {
      return;
    }
    form.setValue("total_deposit", rentForDepositDefault ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rentForDepositDefault, depositUnlocked, isEditMode, open]);

  // Tiền cọc ghi vào SỔ QUỸ THẬT user chọn ở từng dòng "Đã đặt cọc" (sổ CỌC
  // chỉ là sổ ảo theo dõi, không nhận dòng tiền). RPC tạo các phiếu này cùng HĐ.

  // Auto-điền "Đến ngày" = ngày 5 tháng kế tiếp khi user chọn "Ngày BĐ tính tiền"
  // và chưa nhập "Đến ngày". User vẫn có thể chỉnh tay sau đó.
  const startBillingInput = form.watch("start_billing_date");
  const endBillingInput = form.watch("end_billing_date");
  useEffect(() => {
    if (!startBillingInput) return;
    if (endBillingInput) return;
    const d = new Date(startBillingInput);
    if (Number.isNaN(d.getTime())) return;
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 5);
    const yyyy = next.getFullYear();
    const mm = String(next.getMonth() + 1).padStart(2, "0");
    const dd = String(next.getDate()).padStart(2, "0");
    form.setValue("end_billing_date", `${yyyy}-${mm}-${dd}`);
  }, [startBillingInput, endBillingInput, form]);

  // Match create_contract_v2 exactly: date-only values, start falls back to
  // contract start, and an omitted end falls back to the effective start.
  const normalizedBillingPeriod = useMemo(
    () =>
      normalizeFirstBillingPeriod(
        startBillingInput,
        endBillingInput,
        startDateWatch,
      ),
    [startBillingInput, endBillingInput, startDateWatch],
  );
  const startBilling = normalizedBillingPeriod.start_date ?? "";
  const endBilling = normalizedBillingPeriod.end_date ?? "";

  // Khi số khách thay đổi → tự cập nhật "Số lượng" của các dịch vụ tính
  // theo người (pricing_type = DON_GIA_THEO_NGUOI). Vd Nước 100k/người,
  // 2 khách → Số lượng = 2. User vẫn có thể chỉnh tay sau (lần update
  // tay sẽ stick vì điều kiện `quantity !== customerCount` chỉ overwrite
  // khi giá trị chưa khớp). Cũng chạy khi user thêm dịch vụ mới sau
  // khi đã có khách → service mới (qty default 1) sẽ được bump lên N.
  const customerCount = selectedCustomers.length;
  const perPersonServiceIdsKey = useMemo(
    () =>
      selectedServices
        .filter((s) => s.pricing_type === "DON_GIA_THEO_NGUOI")
        .map((s) => s.id)
        .join("|"),
    [selectedServices],
  );
  useEffect(() => {
    if (customerCount <= 0) return;
    setSelectedServices((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (
          s.pricing_type === "DON_GIA_THEO_NGUOI" &&
          (s.quantity ?? 1) === 1 &&
          customerCount !== 1
        ) {
          changed = true;
          return { ...s, quantity: customerCount };
        }
        return s;
      });
      return changed ? next : prev;
    });
  }, [customerCount, perPersonServiceIdsKey]);

  // Tự sinh items hoá đơn cọc + tháng đầu khi inputs đổi. User chỉnh trực
  // tiếp trên bảng preview vẫn được — nhưng nếu họ đổi rent/dates/services
  // sau khi chỉnh thì preview bị tính lại đè lên (UX rõ ràng hơn là cố
  // giữ override mơ hồ).
  const rentPriceWatch = form.watch("rent_price") ?? 0;
  const totalDepositWatch = form.watch("total_deposit") ?? 0;
  const discountMonthsWatch = form.watch("discount_months") ?? 0;
  const discountAmtWatch = form.watch("discount_amount_per_month") ?? 0;

  // Cọc lệch tiền thuê → hint dưới ô cọc + dòng ghi chú "[Điều chỉnh cọc]" khi
  // lưu. Cùng một nguồn tính để 2 chỗ không bao giờ nói khác nhau.
  const depositAdjustment = useMemo(
    () => describeDepositAdjustment(rentPriceWatch, totalDepositWatch),
    [rentPriceWatch, totalDepositWatch],
  );
  // Giá ký khác giá niêm yết của phòng → nhắc, và trigger DB ghi lịch sử giá.
  const rentDiffersFromRoom =
    roomDefaultRent > 0 && Math.abs(rentPriceWatch - roomDefaultRent) >= 0.01;

  const invoiceServices = useCustomServices
    ? selectedServices
    : buildingServicesAsSelected;
  const servicesKey = useMemo(
    () =>
      invoiceServices
        .map((s) => `${s.id}:${s.unit_price}:${s.quantity}:${s.pricing_type}`)
        .join("|"),
    [invoiceServices],
  );
  useEffect(() => {
    if (!open) return;
    if (isEditMode) return; // edit mode không sinh hoá đơn tự động
    const items = buildFirstInvoiceItems({
      rent_price: rentPriceWatch,
      total_deposit: totalDepositWatch,
      // Only FIRST_INVOICE may carry a DEPOSIT item. The RPC rejects deposit
      // semantics in every other mode.
      deposit_paid: depositPaidTotal,
      include_deposit: depositShortfall && depositDebtMode === "FIRST_INVOICE",
      start_billing_date: startBilling || undefined,
      end_billing_date: endBilling || undefined,
      discount_months: discountMonthsWatch,
      discount_amount_per_month: discountAmtWatch,
      // Contract-specific services are persisted only when the toggle is ON,
      // but the first invoice still snapshots building defaults when it is OFF.
      services: invoiceServices.map((s) => ({
        service_id: s.id,
        name: s.name,
        unit_price: s.unit_price,
        quantity: s.quantity,
        pricing_type: s.pricing_type ?? null,
      })),
    });
    setInvoiceItems(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    isEditMode,
    rentPriceWatch,
    totalDepositWatch,
    depositPaidTotal,
    depositShortfall,
    depositDebtMode,
    startBilling,
    endBilling,
    discountMonthsWatch,
    discountAmtWatch,
    servicesKey,
  ]);

  const invoiceSubtotal = useMemo(
    () => invoiceItems.reduce((sum, it) => sum + it.unit_price * it.quantity, 0),
    [invoiceItems],
  );

  // Khuyến mãi tháng đầu — tách khỏi items để hiển thị riêng & lưu vào
  // invoices.discount_amount + discount_notes (slot 1/Y).
  const firstInvoiceDiscount = useMemo(
    () =>
      buildFirstInvoiceDiscount({
        rent_price: rentPriceWatch,
        total_deposit: totalDepositWatch,
        deposit_paid: depositPaidTotal,
        discount_months: discountMonthsWatch,
        discount_amount_per_month: discountAmtWatch,
        services: [],
      }, invoiceItems),
    [
      rentPriceWatch,
      totalDepositWatch,
      depositPaidTotal,
      discountMonthsWatch,
      discountAmtWatch,
      invoiceItems,
    ],
  );
  const invoiceTotal = Math.max(0, invoiceSubtotal - firstInvoiceDiscount.amount);

  const updateInvoiceItem = (
    id: string,
    field: "description" | "quantity" | "unit_price",
    value: string | number,
  ) => {
    setInvoiceItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        if (it.accounting_class === "DEPOSIT" && field !== "description") {
          return it;
        }
        return { ...it, [field]: value };
      }),
    );
  };

  const removeInvoiceItem = (id: string) => {
    setInvoiceItems((prev) =>
      prev.filter((it) => it.id !== id || it.accounting_class === "DEPOSIT"),
    );
  };

  const addInvoiceItem = () => {
    setInvoiceItems((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}-${prev.length}`,
        type: "OTHER",
        accounting_class: "REVENUE",
        description: "Khoản thu khác",
        unit_price: 0,
        quantity: 1,
      },
    ]);
  };

  // ---- Cascading handlers ----
  const handleBuildingChange = (buildingId: string) => {
    setSelectedBuildingId(buildingId);
    setSelectedRoomId("");
    form.setValue("room_id", "");
  };

  const handleRoomChange = (roomId: string) => {
    setSelectedRoomId(roomId);
    form.setValue("room_id", roomId);
  };

  // ---- Customer handlers ----
  const handleCustomersSelected = (customers: CustomerBasic[]) => {
    const newCustomers: SelectedCustomer[] = customers.map((c) => {
      const existing = selectedCustomers.find((sc) => sc.id === c.id);
      return existing ?? { ...c, is_representative: false, notes: null };
    });
    // Ensure at least one representative
    if (newCustomers.length > 0 && !newCustomers.some((c) => c.is_representative)) {
      newCustomers[0].is_representative = true;
    }
    setSelectedCustomers(newCustomers);
  };

  const handleRemoveCustomer = (customerId: string) => {
    setSelectedCustomers((prev) => {
      const next = prev.filter((c) => c.id !== customerId);
      // If removed the representative, assign first remaining
      if (next.length > 0 && !next.some((c) => c.is_representative)) {
        next[0].is_representative = true;
      }
      return next;
    });
  };

  const handleRepresentativeChange = (customerId: string) => {
    setSelectedCustomers((prev) =>
      prev.map((c) => ({
        ...c,
        is_representative: c.id === customerId,
      }))
    );
  };

  const handleCustomerNotesChange = (customerId: string, value: string) => {
    setSelectedCustomers((prev) =>
      prev.map((c) =>
        c.id === customerId ? { ...c, notes: value === "" ? null : value } : c
      )
    );
  };

  // ---- Service handlers ----
  // Bật/tắt "Dùng dịch vụ riêng". Lần đầu bật mà chưa có dịch vụ nào → seed
  // từ dịch vụ đang bật của toà để user chỉnh tiếp (thêm/bớt/sửa giá). Tắt
  // lại không xoá lựa chọn (giữ để bật lại không mất), chỉ không lưu khi save.
  const handleToggleCustomServices = (on: boolean) => {
    setUseCustomServices(on);
    if (on && selectedServices.length === 0 && buildingServicesAsSelected.length > 0) {
      setSelectedServices(buildingServicesAsSelected);
    }
  };

  const handleServicesSelected = (services: ServiceBasic[]) => {
    const newServices: SelectedService[] = services.map((s) => {
      const existing = selectedServices.find((ss) => ss.id === s.id);
      return existing ?? { ...s, initial_reading: 0, quantity: 1 };
    });
    setSelectedServices(newServices);
  };

  const handleRemoveService = (serviceId: string) => {
    setSelectedServices((prev) => prev.filter((s) => s.id !== serviceId));
  };

  const handleServiceFieldChange = (
    serviceId: string,
    field: "initial_reading" | "quantity" | "unit_price",
    value: number
  ) => {
    setSelectedServices((prev) =>
      prev.map((s) => (s.id === serviceId ? { ...s, [field]: value } : s))
    );
  };

  // Hiển thị toast cho mọi điều kiện chặn không lưu được (zod + business
  // rule). Người dùng cần thấy ngay vì sao bấm Lưu mà không lưu được.
  const FIELD_LABELS: Record<string, string> = {
    room_id: "Phòng",
    signed_date: "Ngày ký",
    start_date: "Ngày bắt đầu",
    end_date: "Hạn hợp đồng",
    rent_price: "Tiền thuê",
    total_deposit: "Tiền cọc",
    deposit_paid: "Đã đặt cọc",
    deposit_debt_acknowledged: "Xử lý thiếu cọc",
    deposit_debt_mode: "Cách xử lý thiếu cọc",
    deposit_debt_reason: "Lý do cho nợ cọc",
    deposit_topup_due_date: "Hẹn bổ sung cọc",
    payment_cycle: "Chu kỳ thanh toán",
    start_billing_date: "Ngày BĐ tính tiền",
    end_billing_date: "Đến ngày",
    discount_months: "Số tháng giảm",
    discount_amount_per_month: "Số tiền giảm/tháng",
  };
  const onInvalid = (errors: Record<string, any>) => {
    const entries = Object.entries(errors).filter(([k]) => k !== "root");
    if (entries.length === 0) return;
    const lines = entries.slice(0, 4).map(([key, err]) => {
      const label = FIELD_LABELS[key] || key;
      const msg = (err as any)?.message || "không hợp lệ";
      return `• ${label}: ${msg}`;
    });
    const extra = entries.length > 4 ? `\n(+${entries.length - 4} lỗi khác)` : "";
    toast.error("Không thể lưu hợp đồng", {
      description: lines.join("\n") + extra,
    });
    // Cuộn về đầu để user thấy chỗ lỗi đầu tiên.
    try {
      const el = document.querySelector('[data-slot="dialog-content"]');
      if (el) el.scrollTop = 0;
    } catch {}
  };

  return {
    isEditMode,
    // mutations (submit orchestration dùng)
    createContract,
    updateContract,
    syncCustomers,
    syncServices,
    isPending,
    // data
    buildings,
    rooms,
    filteredRooms,
    accounts,
    authUser,
    buildingActiveServices,
    buildingServicesAsSelected,
    orphanDepositVouchers,
    approvedOrphanTotal,
    typedDepositTotal,
    // state
    selectedBuildingId,
    selectedRoomId,
    selectedCustomers,
    selectedServices,
    customerDialogOpen,
    setCustomerDialogOpen,
    serviceDialogOpen,
    setServiceDialogOpen,
    useCustomServices,
    invoiceItems,
    depositRows,
    rentUnlocked,
    unlockRent: () => setRentUnlocked(true),
    depositUnlocked,
    unlockDeposit: () => setDepositUnlocked(true),
    commissionContractId,
    setCommissionContractId,
    // form
    form,
    // derived
    roomDefaultRent,
    rentDiffersFromRoom,
    depositAdjustment,
    depositDebtMode,
    depositPaidTotal,
    depositRemaining,
    depositShortfall,
    blockByDepositDebt,
    startBilling,
    endBilling,
    invoiceSubtotal,
    firstInvoiceDiscount,
    invoiceTotal,
    // handlers
    addDepositRow,
    updateDepositRow,
    removeDepositRow,
    updateInvoiceItem,
    removeInvoiceItem,
    addInvoiceItem,
    handleBuildingChange,
    handleRoomChange,
    handleCustomersSelected,
    handleRemoveCustomer,
    handleRepresentativeChange,
    handleCustomerNotesChange,
    handleToggleCustomServices,
    handleServicesSelected,
    handleRemoveService,
    handleServiceFieldChange,
    onInvalid,
  };
}

export type ContractFormState = ReturnType<typeof useContractFormState>;
