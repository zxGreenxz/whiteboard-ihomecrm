import { useEffect, useState, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { contractFormSchema } from "@/lib/contractValidation";
import type { ContractFormData } from "@/lib/contractValidation";
import { PREVIOUS_DEBT_ROUND_THRESHOLD } from "@/lib/invoiceHelpers";
import type { ContractWithRelations, PaymentCycle } from "@/types/contract";
import { PAYMENT_CYCLE_LABELS } from "@/types/contract";
import {
  useCreateContract,
  useSyncContractCustomers,
  useSyncContractServices,
  useUpdateContract,
} from "@/hooks/useContracts";
import { formatCurrency } from "@/lib/utils";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useBuildingServices } from "@/hooks/useBuildingServices";
import type { BuildingServiceWithDetails } from "@/types/building";
import {
  CustomerSelectionDialog,
  type CustomerBasic,
} from "./CustomerSelectionDialog";
import {
  ServiceSelectionDialog,
  type ServiceBasic,
} from "./ServiceSelectionDialog";
import { CommissionVoucherModal } from "./CommissionVoucherModal";
import {
  buildFirstInvoiceItems,
  buildFirstInvoiceDiscount,
  type FirstInvoiceItem,
} from "@/lib/firstInvoiceBuilder";
import { useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useOrphanDepositVouchers } from "@/hooks/useDeposits";
import { useCreateIncomeExpense } from "@/hooks/useIncomeExpenses";
import { useAccounts } from "@/hooks/useAccounts";
import { useAuth } from "@/hooks/useAuth";
import AttachmentUpload from "@/components/income-expenses/AttachmentUpload";

/**
 * Prefill khi mở form từ flow khác (Cọc giữ chỗ → HĐ, Building map → HĐ).
 * Parent PHẢI memo object này (useMemo) để tránh reset form lặp vô hạn.
 */
export interface ContractPrefill {
  buildingId?: string;
  roomId?: string;
  /** Phiếu giữ chỗ (bảng deposits) — flip CONVERTED + gắn contract_id SAU khi HĐ tạo thành công. */
  depositId?: string;
  /** Tiền cọc đã ghi trên phiếu giữ chỗ — prefill "Đã đặt cọc". */
  depositAmount?: number;
}

interface ContractFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract?: ContractWithRelations;
  prefill?: ContractPrefill;
  /** Gọi sau khi TẠO HĐ thành công (không gọi ở edit mode). */
  onCreated?: (contractId: string) => void;
}

// ---- Local state types for customers & services ----

interface SelectedCustomer extends CustomerBasic {
  is_representative: boolean;
  notes: string | null;
}

interface SelectedService extends ServiceBasic {
  initial_reading: number;
  quantity: number;
}

const formatVND = (amount: number) => formatCurrency(amount);

export function ContractFormDialog({
  open,
  onOpenChange,
  contract,
  prefill,
  onCreated,
}: ContractFormDialogProps) {
  const isEditMode = !!contract;
  const queryClient = useQueryClient();

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
        quantity: 1,
      })),
    [buildingActiveServices],
  );

  // Invoice preview (hoá đơn cọc + tháng đầu) — items được tự sinh từ
  // rent/cọc/services, user có thể chỉnh trực tiếp; khi lưu HĐ items này
  // được dùng làm nội dung hoá đơn. Reset khi inputs đổi (xem useEffect).
  const [invoiceItems, setInvoiceItems] = useState<FirstInvoiceItem[]>([]);

  // Phiếu thu cọc — auto-tạo sau khi lưu HĐ thành công nếu user đã nhập
  // "Đã đặt cọc". Lookup id của type "Tiền cọc" và default account.
  const { data: incomeTypes = [] } = useIncomeExpenseTypes("income");
  const depositIncomeType = useMemo(
    () =>
      incomeTypes.find(
        (t) => t.name.trim().toLowerCase() === "tiền cọc",
      ),
    [incomeTypes],
  );
  const { data: accounts = [] } = useAccounts();
  const createDepositVoucher = useCreateIncomeExpense();
  const { data: authUser } = useAuth();

  // Ảnh đính kèm cho phiếu thu cọc — upload trực tiếp tại form HĐ, sẽ được
  // gửi kèm khi auto-tạo phiếu thu sau lúc lưu HĐ.
  const [depositAttachments, setDepositAttachments] = useState<string[]>([]);

  // Commission voucher modal — open after successful create (not edit)
  const [commissionContractId, setCommissionContractId] = useState<string | null>(null);

  // Form
  const form = useForm<ContractFormData>({
    resolver: zodResolver(contractFormSchema),
    defaultValues: {
      room_id: "",
      signed_date: new Date().toISOString().split("T")[0],
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
  const depositPaid = form.watch("deposit_paid") ?? 0;
  const depositRemaining = Math.max(0, totalDeposit - depositPaid);
  const depositDebtMode = form.watch("deposit_debt_mode");
  // Chặn ký khi thiếu cọc (chênh ≥ ngưỡng làm tròn) mà chưa chọn cách xử lý
  // (Nợ cọc / Đóng đủ trong hoá đơn). Chỉ áp dụng lúc tạo mới — edit không khoá.
  const depositShortfall = depositRemaining >= PREVIOUS_DEBT_ROUND_THRESHOLD;
  const blockByDepositDebt = !isEditMode && depositShortfall && !depositDebtMode;

  // ---- Cọc giữ chỗ đã thu (phiếu IE mồ côi của phòng) ----
  // Trigger trg_contract_link_orphan_deposits sẽ TỰ GẮN các phiếu này vào HĐ
  // khi INSERT, và recompute deposit_paid = Σ phiếu APPROVED. Vì vậy:
  // - "Đã đặt cọc" phải là TỔNG cọc khách đã đưa (gồm cả giữ chỗ);
  // - phiếu thu auto-tạo lúc lưu chỉ ghi PHẦN CHÊNH (typed − orphan) —
  //   nếu ghi toàn bộ sẽ double-count deposit_paid (bug cũ).
  const startDateWatch = form.watch("start_date");
  const { data: orphanDepositVouchers = [] } = useOrphanDepositVouchers(
    !isEditMode && open ? selectedRoomId || undefined : undefined,
    startDateWatch || undefined,
  );
  const orphanDepositTotal = useMemo(
    () =>
      orphanDepositVouchers.reduce(
        (sum, v) => sum + (Number(v.total_amount) || 0),
        0,
      ),
    [orphanDepositVouchers],
  );
  // Khi phòng đã có cọc giữ chỗ mà user chưa nhập gì → tự điền tổng đã thu
  // (user vẫn chỉnh tay được; nhập THÊM nếu thu thêm lúc ký).
  useEffect(() => {
    if (isEditMode || !open) return;
    if (orphanDepositTotal <= 0) return;
    const current = form.getValues("deposit_paid") ?? 0;
    if (current < orphanDepositTotal) {
      form.setValue("deposit_paid", orphanDepositTotal);
      const total = form.getValues("total_deposit") ?? 0;
      if (total < orphanDepositTotal) {
        form.setValue("total_deposit", orphanDepositTotal);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphanDepositTotal, isEditMode, open]);

  // ---- Reset form when dialog opens ----
  useEffect(() => {
    if (!open) return;

    if (contract) {
      // Edit mode: pre-populate
      const buildingId = contract.room?.building_id ?? "";
      setSelectedBuildingId(buildingId);
      setSelectedRoomId(contract.room_id ?? "");

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
      setDepositAttachments([]);
      form.reset({
        room_id: prefill?.roomId ?? "",
        signed_date: new Date().toISOString().split("T")[0],
        start_date: "",
        end_date: "",
        rent_price: 0,
        total_deposit: prefill?.depositAmount ?? 0,
        deposit_paid: prefill?.depositAmount ?? 0,
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

  // Tiền cọc luôn ghi vào sổ "CỌC (giữ hộ khách)" chung (mọi toà) — không còn
  // cho chọn sổ thu cọc. Sổ CỌC được resolve qua RPC get_or_create_deposit_account
  // khi tạo phiếu thu cọc lúc lưu HĐ (xem onSuccess bên dưới).

  // Auto-điền "Đến ngày" = ngày 5 tháng kế tiếp khi user chọn "Ngày BĐ tính tiền"
  // và chưa nhập "Đến ngày". User vẫn có thể chỉnh tay sau đó.
  const startBilling = form.watch("start_billing_date");
  const endBilling = form.watch("end_billing_date");
  useEffect(() => {
    if (!startBilling) return;
    if (endBilling) return;
    const d = new Date(startBilling);
    if (Number.isNaN(d.getTime())) return;
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 5);
    const yyyy = next.getFullYear();
    const mm = String(next.getMonth() + 1).padStart(2, "0");
    const dd = String(next.getDate()).padStart(2, "0");
    form.setValue("end_billing_date", `${yyyy}-${mm}-${dd}`);
  }, [startBilling, endBilling, form]);

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
  const depositPaidWatch = form.watch("deposit_paid") ?? 0;
  const discountMonthsWatch = form.watch("discount_months") ?? 0;
  const discountAmtWatch = form.watch("discount_amount_per_month") ?? 0;
  const servicesKey = useMemo(
    () =>
      selectedServices
        .map((s) => `${s.id}:${s.unit_price}:${s.quantity}`)
        .join("|"),
    [selectedServices],
  );
  useEffect(() => {
    if (!open) return;
    if (isEditMode) return; // edit mode không sinh hoá đơn tự động
    const items = buildFirstInvoiceItems({
      rent_price: rentPriceWatch,
      total_deposit: totalDepositWatch,
      deposit_paid: depositPaidWatch,
      start_billing_date: startBilling || undefined,
      end_billing_date: endBilling || undefined,
      discount_months: discountMonthsWatch,
      discount_amount_per_month: discountAmtWatch,
      // Toggle OFF (dùng dịch vụ toà) → không đưa service vào hoá đơn đầu
      // (giống HĐ chưa cấu hình dịch vụ); ON → dùng dịch vụ riêng của HĐ.
      services: (useCustomServices ? selectedServices : []).map((s) => ({
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
    depositPaidWatch,
    startBilling,
    endBilling,
    discountMonthsWatch,
    discountAmtWatch,
    servicesKey,
    useCustomServices,
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
        deposit_paid: depositPaidWatch,
        discount_months: discountMonthsWatch,
        discount_amount_per_month: discountAmtWatch,
        services: [],
      }),
    [
      rentPriceWatch,
      totalDepositWatch,
      depositPaidWatch,
      discountMonthsWatch,
      discountAmtWatch,
    ],
  );
  const invoiceTotal = Math.max(0, invoiceSubtotal - firstInvoiceDiscount.amount);

  const updateInvoiceItem = (
    id: string,
    field: "description" | "quantity" | "unit_price",
    value: string | number,
  ) => {
    setInvoiceItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, [field]: value } : it)),
    );
  };

  const removeInvoiceItem = (id: string) => {
    setInvoiceItems((prev) => prev.filter((it) => it.id !== id));
  };

  const addInvoiceItem = () => {
    setInvoiceItems((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}-${prev.length}`,
        type: "OTHER",
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

  // ---- Submit handler ----
  const onSubmit = (data: ContractFormData) => {
    // Resident requires at least one customer (representative tenant) on a
    // contract — fail fast in the UI rather than letting Postgres throw a
    // confusing NOT NULL violation on tenant_id.
    if (selectedCustomers.length === 0) {
      toast.error("Không thể lưu hợp đồng", {
        description: "Vui lòng chọn ít nhất một khách hàng cho hợp đồng.",
      });
      try {
        const el = document.querySelector('[data-slot="dialog-content"]');
        if (el) el.scrollTop = 0;
      } catch {}
      return;
    }

    // Make sure exactly one customer is flagged as representative; if none,
    // promote the first.
    const hasRep = selectedCustomers.some((c) => c.is_representative);
    if (!hasRep) {
      selectedCustomers[0].is_representative = true;
    }

    const customers = selectedCustomers.map((c) => ({
      customer_id: c.id,
      is_representative: c.is_representative,
      notes: c.notes,
    }));

    // Chỉ lưu contract_services khi user bật "Dùng dịch vụ riêng". OFF → lưu
    // rỗng để hoá đơn fallback đơn giá toà (đúng ý: chưa cấu hình → theo toà).
    const services = (useCustomServices ? selectedServices : []).map((s) => ({
      service_id: s.id,
      unit_price: s.unit_price,
      initial_reading: s.initial_reading || undefined,
    }));

    if (isEditMode && contract) {
      // Edit mode: update contract fields
      const updates: Record<string, any> = {
        room_id: data.room_id,
        signed_date: data.signed_date,
        start_date: data.start_date,
        end_date: data.end_date,
        rent_price: data.rent_price,
        total_deposit: data.total_deposit,
        deposit_paid: data.deposit_paid ?? 0,
        payment_cycle: data.payment_cycle,
        start_billing_date: data.start_billing_date || null,
        end_billing_date: data.end_billing_date || null,
        contract_template_id: data.contract_template_id || null,
        invoice_template_id: data.invoice_template_id || null,
        notes: data.notes || null,
        discounts:
          data.discount_months && data.discount_amount_per_month
            ? {
                months: data.discount_months,
                amount_per_month: data.discount_amount_per_month,
              }
            : null,
      };

      updateContract.mutate(
        { id: contract.id, updates },
        {
          onSuccess: async () => {
            // Luồng update không tự đụng contract_customers / contract_services
            // → phải sync tay sau khi update HĐ. Đồng bộ cả khách (đại diện +
            // ghi chú) lẫn dịch vụ (đổi loại điện, đơn giá, chỉ số đầu). Chỉ
            // đóng dialog khi cả hai thành công; lỗi sẽ giữ dialog mở + toast.
            try {
              await Promise.all([
                syncCustomers.mutateAsync({ contractId: contract.id, customers }),
                syncServices.mutateAsync({ contractId: contract.id, services }),
              ]);
              onOpenChange(false);
            } catch (e) {
              console.error("Sync khách hàng/dịch vụ HĐ thất bại:", e);
              toast.error("Đã cập nhật HĐ nhưng đồng bộ khách hàng/dịch vụ thất bại", {
                description: "Vui lòng thử lại.",
              });
            }
          },
        }
      );
    } else {
      // Create mode

      // Chặn ký khi khách chưa đóng đủ cọc, trừ khi chọn cách xử lý. Cọc thiếu
      // vẫn vào hoá đơn cọc+tháng đầu như flow gốc; lựa chọn chỉ quyết định
      // có nhắc bổ sung sau hay không.
      const remaining =
        (data.total_deposit || 0) - (data.deposit_paid || 0);
      if (remaining >= PREVIOUS_DEBT_ROUND_THRESHOLD) {
        if (!data.deposit_debt_mode) {
          form.setError("deposit_debt_mode", {
            type: "manual",
            message:
              "Khách chưa đóng đủ cọc — chọn cách xử lý (Nợ cọc / Đóng đủ trong hoá đơn).",
          });
          toast.error("Không thể lưu hợp đồng", {
            description: `Khách còn thiếu ${formatCurrency(remaining)} tiền cọc. Chọn "Nợ cọc" hoặc "Đóng đủ trong hoá đơn" để tiếp tục.`,
          });
          return;
        }
        if (data.deposit_debt_mode === "DEBT" && !data.deposit_debt_reason?.trim()) {
          form.setError("deposit_debt_reason", {
            type: "manual",
            message: "Nhập lý do cho nợ cọc.",
          });
          toast.error("Không thể lưu hợp đồng", {
            description: "Vui lòng nhập lý do cho nợ cọc.",
          });
          return;
        }
      }

      const discounts =
        data.discount_months && data.discount_amount_per_month
          ? {
              months: data.discount_months,
              amount_per_month: data.discount_amount_per_month,
            }
          : undefined;

      createContract.mutate(
        {
          contract: {
            room_id: data.room_id,
            signed_date: data.signed_date,
            start_date: data.start_date,
            end_date: data.end_date,
            rent_price: data.rent_price,
            total_deposit: data.total_deposit,
            deposit_paid: data.deposit_paid,
            payment_cycle: data.payment_cycle,
            start_billing_date: data.start_billing_date || undefined,
            end_billing_date: data.end_billing_date || undefined,
            contract_template_id: data.contract_template_id || undefined,
            invoice_template_id: data.invoice_template_id || undefined,
            notes: data.notes || undefined,
            discounts,
            // Xử lý thiếu cọc — chỉ ý nghĩa khi còn thiếu cọc; ngược lại null.
            // mode DEBT giữ lý do + hẹn ngày để nhắc; FIRST_INVOICE bỏ qua.
            deposit_debt_acknowledged: !!data.deposit_debt_mode,
            deposit_debt_mode: data.deposit_debt_mode ?? null,
            deposit_debt_reason:
              data.deposit_debt_mode === "DEBT"
                ? data.deposit_debt_reason?.trim() || null
                : null,
            deposit_topup_due_date:
              data.deposit_debt_mode === "DEBT"
                ? data.deposit_topup_due_date || null
                : null,
          },
          customers,
          services,
          // Items hoá đơn cọc + tháng đầu — đã được user xem trước/chỉnh
          // trong section preview, gửi xuống đúng những gì user thấy.
          invoiceItems: invoiceItems.map((it) => ({
            type: it.type,
            description: it.description,
            unit_price: it.unit_price,
            quantity: it.quantity,
            service_id: it.service_id ?? null,
            from_date: it.from_date ?? null,
            to_date: it.to_date ?? null,
          })),
          firstInvoiceDiscount:
            firstInvoiceDiscount.amount > 0
              ? {
                  amount: firstInvoiceDiscount.amount,
                  notes: firstInvoiceDiscount.notes,
                }
              : undefined,
        },
        {
          onSuccess: async (contract) => {
            // Auto-tạo phiếu thu cọc, LUÔN ghi vào sổ "CỌC (giữ hộ khách)"
            // chung (resolve qua RPC get_or_create_deposit_account).
            // CHỈ tạo cho PHẦN CHÊNH so với cọc giữ chỗ đã thu: các phiếu IE
            // mồ côi của phòng đã được trigger tự gắn vào HĐ và tính vào
            // deposit_paid — tạo phiếu cho toàn bộ sẽ double-count (bug cũ).
            const depositAmount = Math.max(
              0,
              (data.deposit_paid ?? 0) - orphanDepositTotal,
            );
            const building = (buildings as any[])?.find(
              (b) => b.id === selectedBuildingId,
            );
            const buildingName: string = building?.name ?? "";
            if (depositAmount > 0 && depositIncomeType && selectedBuildingId) {
              let depositAccountId: string | null = null;
              const { data: depAcc, error: depErr } = await (
                supabase as any
              ).rpc("get_or_create_deposit_account");
              if (!depErr && depAcc) depositAccountId = depAcc as string;

              if (depositAccountId) {
                const room = (rooms as any[])?.find(
                  (r) => r.id === selectedRoomId,
                );
                const roomName = room?.name ?? "";
                const voucherName =
                  roomName && buildingName
                    ? `Cọc giữ phòng ${roomName} Toà nhà ${buildingName}`
                    : roomName
                      ? `Cọc giữ phòng ${roomName}`
                      : "Cọc giữ phòng";
                const today = new Date().toISOString().split("T")[0];
                try {
                  await createDepositVoucher.mutateAsync({
                    type: "INCOME",
                    name: voucherName,
                    building_id: selectedBuildingId,
                    room_id: selectedRoomId || null,
                    tenant_id: null,
                    contract_id: contract?.id ?? null,
                    payer_name: null,
                    account_id: depositAccountId,
                    voucher_date: data.signed_date || today,
                    // null = tự động; hạng mục "Tiền cọc" (is_deposit) đã tự loại
                    // khoản này khỏi báo cáo Lợi nhuận.
                    business_result_accounting: null,
                    repeat_cycle: "NONE",
                    repeat_infinity: false,
                    repeat_count: 0,
                    attachments: depositAttachments,
                    items: [
                      {
                        income_expense_type_id: depositIncomeType.id,
                        description: null,
                        quantity: 1,
                        unit_price: depositAmount,
                        start_date: data.signed_date || today,
                        end_date: data.signed_date || today,
                      },
                    ],
                  });
                } catch (voucherErr) {
                  console.error("Tạo phiếu thu cọc thất bại:", voucherErr);
                  toast.error(
                    "HĐ đã lưu nhưng phiếu thu cọc TẠO THẤT BẠI",
                    {
                      duration: 15000,
                      description: `Số cọc ${formatCurrency(depositAmount)} đang KHÔNG có chứng từ trong sổ quỹ. Vào Thu chi tạo phiếu thu loại "Tiền cọc" cho phòng ${roomName}, hệ thống sẽ tự tính lại cọc của HĐ.`,
                    },
                  );
                }
              } else {
                toast.error(
                  "HĐ đã lưu nhưng chưa tạo phiếu thu cọc: không lấy được sổ CỌC.",
                  {
                    duration: 15000,
                    description: `Số cọc ${formatCurrency(depositAmount)} đang KHÔNG có chứng từ. Vào Thu chi tạo phiếu thu loại "Tiền cọc" gắn phòng này.`,
                  },
                );
              }
            } else if (depositAmount > 0 && !depositIncomeType) {
              toast.error(
                'HĐ đã lưu nhưng chưa tạo phiếu thu cọc: thiếu loại thu "Tiền cọc".',
                {
                  duration: 15000,
                  description: `Tạo loại thu "Tiền cọc" trong Cài đặt rồi tạo phiếu thu ${formatCurrency(depositAmount)} gắn phòng này.`,
                },
              );
            }

            // Flow Cọc giữ chỗ → HĐ: flip phiếu giữ chỗ SAU khi HĐ đã tạo
            // thành công (trước đây flip TRƯỚC khi tạo → HĐ fail là phòng mất
            // RESERVED + lộ ra trang Phòng trống công khai).
            if (prefill?.depositId && contract?.id) {
              const { error: depUpdateErr } = await supabase
                .from("deposits")
                .update({
                  status: "CONVERTED",
                  contract_id: contract.id,
                } as any)
                .eq("id", prefill.depositId);
              if (depUpdateErr) {
                console.error("Flip deposit CONVERTED thất bại:", depUpdateErr);
                toast.warning(
                  "HĐ đã tạo nhưng phiếu giữ chỗ chưa chuyển trạng thái — cập nhật tay trong trang Đặt cọc.",
                );
              }
              queryClient.invalidateQueries({ queryKey: ["deposits"] });
            }

            // Đóng dialog HĐ trước rồi mở modal tạo phiếu chi hoa hồng
            onOpenChange(false);
            if (contract?.id) {
              onCreated?.(contract.id);
              setCommissionContractId(contract.id);
            }
          },
        }
      );
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>
            {isEditMode ? "Cập nhật hợp đồng" : "Tạo hợp đồng mới"}
            {isEditMode && contract?.contract_number && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({contract.contract_number})
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] px-6 pb-6">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit, onInvalid)}
              onKeyDown={(e) => {
                // Chặn Enter submit ngoài ý muốn — chỉ cho Enter trong
                // <textarea> (để xuống dòng) và button submit (click thật sự).
                if (e.key !== 'Enter') return;
                const target = e.target as HTMLElement;
                const tag = target.tagName;
                if (tag === 'TEXTAREA') return;
                if (tag === 'BUTTON' && (target as HTMLButtonElement).type === 'submit') return;
                e.preventDefault();
              }}
              className="space-y-6"
            >
              {/* ===== Section 1: Thông tin chung ===== */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-foreground border-b pb-2">
                  Thông tin chung
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Toà nhà */}
                  <div className="space-y-2">
                    <Label>
                      Toà nhà <span className="text-destructive">*</span>
                    </Label>
                    <Select
                      value={selectedBuildingId}
                      onValueChange={handleBuildingChange}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn toà nhà" />
                      </SelectTrigger>
                      <SelectContent>
                        {buildings.map((b: any) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Phòng */}
                  <FormField
                    control={form.control}
                    name="room_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Phòng <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={(val) => {
                            handleRoomChange(val);
                            field.onChange(val);
                          }}
                          disabled={!selectedBuildingId}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn phòng" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {/* Phòng RESERVED (đã cọc giữ chỗ) VẪN chọn được để ký HĐ cho
                                người đã cọc — chỉ gắn nhãn "Đã cọc" để nhận biết. */}
                            {filteredRooms.map((r: any) => (
                              <SelectItem key={r.id} value={r.id}>
                                {r.name}
                                {r.status === "RESERVED" ? " · Đã cọc" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Ngày ký */}
                  <FormField
                    control={form.control}
                    name="signed_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngày ký</FormLabel>
                        <FormControl>
                          <DateInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Ngày bắt đầu */}
                  <FormField
                    control={form.control}
                    name="start_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Ngày bắt đầu <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <DateInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Hạn hợp đồng */}
                  <FormField
                    control={form.control}
                    name="end_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Hạn hợp đồng <span className="text-destructive">*</span>
                        </FormLabel>
                        <FormControl>
                          <DateInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Ghi chú */}
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ghi chú</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Ghi chú hợp đồng..."
                          rows={2}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* ===== Section 2: Khách hàng ===== */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b pb-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Khách hàng
                  </h3>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCustomerDialogOpen(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Thêm khách hàng
                  </Button>
                </div>

                {selectedCustomers.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Chưa chọn khách hàng nào
                  </p>
                ) : (
                  <div className="border rounded-md divide-y">
                    <RadioGroup
                      value={
                        selectedCustomers.find((c) => c.is_representative)?.id ?? ""
                      }
                      onValueChange={handleRepresentativeChange}
                    >
                      {selectedCustomers.map((customer) => (
                        <div key={customer.id} className="px-4 py-3 space-y-2">
                          <div className="flex items-center gap-3">
                            <RadioGroupItem
                              value={customer.id}
                              id={`rep-${customer.id}`}
                            />
                            <Label
                              htmlFor={`rep-${customer.id}`}
                              className="flex-1 cursor-pointer"
                            >
                              <span className="text-sm font-medium">
                                {customer.full_name}
                              </span>
                              <span className="text-xs text-muted-foreground ml-2">
                                {customer.phone}
                                {customer.id_number && ` · ${customer.id_number}`}
                              </span>
                              {customer.is_representative && (
                                <span className="ml-2 text-xs bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                                  Đại diện
                                </span>
                              )}
                            </Label>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={() => handleRemoveCustomer(customer.id)}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                          <Textarea
                            placeholder={
                              customer.is_representative
                                ? "Ghi chú cho người đại diện..."
                                : "Ghi chú riêng cho khách này..."
                            }
                            value={customer.notes ?? ""}
                            onChange={(e) =>
                              handleCustomerNotesChange(customer.id, e.target.value)
                            }
                            rows={2}
                            className="text-sm"
                          />
                        </div>
                      ))}
                    </RadioGroup>
                  </div>
                )}
              </div>

              {/* ===== Section 3: Tiền thuê & Tiền cọc ===== */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-foreground border-b pb-2">
                  Tiền thuê & Tiền cọc
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {/* Tiền thuê */}
                  <FormField
                    control={form.control}
                    name="rent_price"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tiền thuê</FormLabel>
                        <FormControl>
                          <CurrencyInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Chu kỳ thanh toán */}
                  <FormField
                    control={form.control}
                    name="payment_cycle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Chu kỳ thanh toán</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn chu kỳ" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {(
                              Object.entries(PAYMENT_CYCLE_LABELS) as [
                                PaymentCycle,
                                string,
                              ][]
                            ).map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Ngày bắt đầu tính tiền */}
                  <FormField
                    control={form.control}
                    name="start_billing_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngày BĐ tính tiền</FormLabel>
                        <FormControl>
                          <DateInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Đến ngày (mặc định ngày 5 tháng kế tiếp) */}
                  <FormField
                    control={form.control}
                    name="end_billing_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Đến ngày</FormLabel>
                        <FormControl>
                          <DateInput
                            value={field.value ?? ""}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Tiền cọc */}
                  <FormField
                    control={form.control}
                    name="total_deposit"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tiền cọc</FormLabel>
                        <FormControl>
                          <CurrencyInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Đã đặt cọc — user nhập tay; khi lưu HĐ sẽ auto-tạo
                      phiếu thu cọc với số tiền + ảnh đính kèm bên dưới. */}
                  <FormField
                    control={form.control}
                    name="deposit_paid"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Đã đặt cọc</FormLabel>
                        <FormControl>
                          <CurrencyInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Tiền cọc phải đóng (calculated readonly) */}
                  <div className="space-y-2">
                    <Label>Tiền cọc phải đóng</Label>
                    <Input
                      type="text"
                      readOnly
                      className="bg-muted"
                      value={formatVND(depositRemaining)}
                    />
                  </div>
                </div>

                {/* Xử lý thiếu cọc — chặn ký khi khách chưa đóng đủ cọc. Chọn
                    "Nợ cọc" (theo dõi + nhắc) hoặc "Đóng đủ trong hoá đơn"
                    (thu đủ ngay ở hoá đơn đầu). Cọc thiếu vẫn vào hoá đơn
                    cọc+tháng đầu như flow gốc. Chỉ hiện khi tạo mới & thiếu cọc. */}
                {!isEditMode && depositShortfall && (
                  <Alert variant="destructive" className="space-y-3">
                    <AlertDescription className="space-y-3">
                      <div>
                        <p className="font-medium">
                          Khách chưa đóng đủ cọc — còn thiếu{" "}
                          {formatCurrency(depositRemaining)}
                        </p>
                        <p className="text-xs">
                          Phần còn thiếu vẫn được tính vào hoá đơn cọc + tháng
                          đầu. Chọn cách xử lý để lưu hợp đồng.
                        </p>
                      </div>

                      <FormField
                        control={form.control}
                        name="deposit_debt_mode"
                        render={({ field }) => (
                          <FormItem className="space-y-2">
                            <FormControl>
                              <RadioGroup
                                value={field.value ?? ""}
                                onValueChange={field.onChange}
                                className="gap-2"
                              >
                                <label className="flex items-start gap-2 cursor-pointer">
                                  <RadioGroupItem value="DEBT" className="mt-0.5" />
                                  <span className="text-sm">
                                    <span className="font-medium">Nợ cọc</span>{" "}
                                    — theo dõi &amp; nhắc khách bổ sung cọc sau.
                                  </span>
                                </label>
                                <label className="flex items-start gap-2 cursor-pointer">
                                  <RadioGroupItem
                                    value="FIRST_INVOICE"
                                    className="mt-0.5"
                                  />
                                  <span className="text-sm">
                                    <span className="font-medium">
                                      Đóng đủ trong hoá đơn
                                    </span>{" "}
                                    — khách thanh toán đủ ngay ở hoá đơn cọc +
                                    tháng đầu, không nhắc bổ sung sau.
                                  </span>
                                </label>
                              </RadioGroup>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      {depositDebtMode === "DEBT" && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <FormField
                            control={form.control}
                            name="deposit_debt_reason"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Lý do cho nợ cọc</FormLabel>
                                <FormControl>
                                  <Textarea
                                    rows={2}
                                    placeholder="VD: khách hẹn bổ sung sau khi nhận lương"
                                    value={field.value ?? ""}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    name={field.name}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={form.control}
                            name="deposit_topup_due_date"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>Hẹn bổ sung cọc</FormLabel>
                                <FormControl>
                                  <DateInput
                                    value={field.value ?? ""}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    name={field.name}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Cọc giữ chỗ đã thu trước — các phiếu IE mồ côi của phòng sẽ
                    TỰ GẮN vào HĐ khi lưu (trigger trg_contract_link_orphan_deposits).
                    Báo rõ để user không nhập trùng; phiếu thu mới chỉ tạo cho
                    phần chênh. */}
                {!isEditMode && orphanDepositTotal > 0 && (
                  <Alert className="border-amber-300 bg-amber-50">
                    <AlertDescription className="text-amber-900 space-y-1">
                      <p className="font-medium">
                        Phòng này đã thu cọc giữ chỗ{" "}
                        {formatCurrency(orphanDepositTotal)} (
                        {orphanDepositVouchers.length} phiếu) — sẽ tự gắn vào
                        HĐ khi lưu.
                      </p>
                      <ul className="text-xs list-disc pl-4">
                        {orphanDepositVouchers.map((v) => (
                          <li key={v.id}>
                            {v.code ? `${v.code} — ` : ""}
                            {v.name} ({formatCurrency(v.total_amount)},{" "}
                            {v.approval_status === "APPROVED"
                              ? "đã duyệt"
                              : "chưa duyệt"}
                            )
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs">
                        Ô <strong>“Đã đặt cọc”</strong> = TỔNG cọc khách đã đưa
                        (gồm cả giữ chỗ). Phiếu thu mới chỉ tạo cho phần thu
                        thêm lúc ký:{" "}
                        <strong>
                          {formatCurrency(
                            Math.max(0, depositPaid - orphanDepositTotal),
                          )}
                        </strong>
                        . Nếu có phiếu cọc không thuộc khách này, hãy huỷ phiếu
                        đó trong Thu chi trước khi lưu HĐ.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}

                {/* Tiền cọc luôn ghi vào sổ "CỌC (giữ hộ khách)" chung — không
                    còn cho chọn sổ. Sổ CỌC quản lý toàn bộ cọc mọi toà; khi thanh
                    lý sẽ chi trả khách + chuyển phần cấn nợ sang sổ vận hành. */}
                {!isEditMode && (form.watch("deposit_paid") ?? 0) > 0 && (
                  <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                    Tiền cọc sẽ được ghi vào sổ quỹ{" "}
                    <strong>“CỌC (giữ hộ khách)”</strong> chung (quản lý cọc mọi
                    toà). Khi thanh lý, hệ thống tự chi trả khách phần ròng và
                    chuyển phần cấn nợ sang sổ vận hành của toà.
                  </div>
                )}

                {/* Ảnh đã cọc — đính kèm cho phiếu thu cọc auto-tạo khi
                    lưu HĐ. Chỉ hiển thị khi tạo mới (edit không auto-tạo
                    lại phiếu, tránh trùng). */}
                {!isEditMode && authUser?.id && (
                  <div className="space-y-2">
                    <Label>Ảnh đã cọc</Label>
                    <AttachmentUpload
                      attachments={depositAttachments}
                      onChange={setDepositAttachments}
                      userId={authUser.id}
                    />
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Số tháng giảm */}
                  <FormField
                    control={form.control}
                    name="discount_months"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số tháng giảm</FormLabel>
                        <FormControl>
                          <NumberInput
                            min={0}
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Số tiền giảm/tháng */}
                  <FormField
                    control={form.control}
                    name="discount_amount_per_month"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số tiền giảm/tháng</FormLabel>
                        <FormControl>
                          <CurrencyInput
                            value={field.value}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* ===== Section 4: Tiền phí dịch vụ ===== */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b pb-2 gap-3">
                  <h3 className="text-sm font-semibold text-foreground shrink-0">
                    Tiền phí dịch vụ
                  </h3>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        id="use-custom-services"
                        checked={useCustomServices}
                        onCheckedChange={handleToggleCustomServices}
                      />
                      <Label
                        htmlFor="use-custom-services"
                        className="text-xs font-normal cursor-pointer text-muted-foreground"
                      >
                        Dùng dịch vụ riêng cho HĐ
                      </Label>
                    </div>
                    {useCustomServices && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setServiceDialogOpen(true)}
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Thêm dịch vụ
                      </Button>
                    )}
                  </div>
                </div>

                {!useCustomServices ? (
                  /* OFF: dùng dịch vụ mặc định của toà — hiển thị mờ, chỉ xem.
                     Hoá đơn sẽ tự lấy đơn giá toà cho HĐ này. */
                  buildingActiveServices.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      {selectedBuildingId
                        ? "Toà chưa cấu hình dịch vụ mặc định. Bật \"Dùng dịch vụ riêng\" để thêm dịch vụ cho HĐ."
                        : "Chọn toà nhà để xem dịch vụ mặc định."}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <div className="border rounded-md overflow-x-auto opacity-60 pointer-events-none select-none">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b bg-muted/50">
                              <th className="text-left px-3 py-2 font-medium">
                                Tên dịch vụ
                              </th>
                              <th className="text-left px-3 py-2 font-medium">
                                Đơn vị
                              </th>
                              <th className="text-right px-3 py-2 font-medium">
                                Đơn giá (toà)
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {buildingServicesAsSelected.map((s) => (
                              <tr key={s.id}>
                                <td className="px-3 py-2">{s.name}</td>
                                <td className="px-3 py-2 text-muted-foreground">
                                  {s.unit ?? "—"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                  {formatVND(s.unit_price)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        HĐ đang dùng dịch vụ mặc định theo toà. Bật{" "}
                        <span className="font-medium">"Dùng dịch vụ riêng cho HĐ"</span>{" "}
                        để chỉnh đơn giá/loại điện riêng cho hợp đồng này.
                      </p>
                    </div>
                  )
                ) : selectedServices.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Chưa chọn dịch vụ nào — bấm "Thêm dịch vụ" để chọn.
                  </p>
                ) : (
                  <div className="border rounded-md overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          <th className="text-left px-3 py-2 font-medium">
                            Tên dịch vụ
                          </th>
                          <th className="text-left px-3 py-2 font-medium">
                            Đồng hồ
                          </th>
                          <th className="text-right px-3 py-2 font-medium">
                            Chỉ số đầu
                          </th>
                          <th className="text-right px-3 py-2 font-medium">
                            Số lượng
                          </th>
                          <th className="text-right px-3 py-2 font-medium">
                            Đơn giá
                          </th>
                          <th className="w-10"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {selectedServices.map((service) => (
                          <tr key={service.id}>
                            <td className="px-3 py-2">{service.name}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {service.pricing_type === "METERED" ? "Có" : "—"}
                            </td>
                            <td className="px-3 py-2">
                              <NumberInput
                                allowDecimal
                                min={0}
                                className="w-24 h-8 text-right ml-auto"
                                value={service.initial_reading}
                                onChange={(v) =>
                                  handleServiceFieldChange(
                                    service.id,
                                    "initial_reading",
                                    v
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <NumberInput
                                min={1}
                                className="w-20 h-8 text-right ml-auto"
                                value={service.quantity}
                                onChange={(v) =>
                                  handleServiceFieldChange(
                                    service.id,
                                    "quantity",
                                    v
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <CurrencyInput
                                suffix={false}
                                className="w-32 h-8 text-right ml-auto"
                                value={service.unit_price}
                                onChange={(v) =>
                                  handleServiceFieldChange(
                                    service.id,
                                    "unit_price",
                                    v
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => handleRemoveService(service.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ===== Section 5: Xem trước hoá đơn cọc + tháng đầu ===== */}
              {!isEditMode && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b pb-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      Xem trước hoá đơn cọc + tháng đầu
                    </h3>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addInvoiceItem}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Thêm dòng
                    </Button>
                  </div>

                  {invoiceItems.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      Chưa có dữ liệu — hãy nhập tiền thuê / tiền cọc / ngày tính tiền để xem trước hoá đơn.
                    </p>
                  ) : (
                    <>
                      {/* Mobile layout: stacked cards */}
                      <div className="md:hidden space-y-3">
                        {invoiceItems.map((it) => (
                          <div
                            key={it.id}
                            className="border rounded-md p-3 space-y-2 bg-card"
                          >
                            <div className="flex items-start gap-2">
                              <div className="flex-1 min-w-0 space-y-1">
                                <Label className="text-xs text-muted-foreground">
                                  Mô tả
                                </Label>
                                <Input
                                  className="h-9 text-sm"
                                  value={it.description}
                                  onChange={(e) =>
                                    updateInvoiceItem(it.id, "description", e.target.value)
                                  }
                                />
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 mt-5 text-destructive hover:text-destructive shrink-0"
                                onClick={() => removeInvoiceItem(it.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">
                                  SL
                                </Label>
                                <NumberInput
                                  min={1}
                                  className="w-full h-9 text-right"
                                  value={it.quantity}
                                  onChange={(v) =>
                                    updateInvoiceItem(it.id, "quantity", v || 1)
                                  }
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">
                                  Đơn giá
                                </Label>
                                <CurrencyInput
                                  suffix={false}
                                  className="w-full h-9 text-right"
                                  value={it.unit_price}
                                  onChange={(v) =>
                                    updateInvoiceItem(it.id, "unit_price", v)
                                  }
                                />
                              </div>
                            </div>
                            <div className="flex items-center justify-between pt-1 border-t">
                              <span className="text-xs text-muted-foreground">
                                Thành tiền
                              </span>
                              <span className="text-sm font-semibold tabular-nums">
                                {formatVND(it.unit_price * it.quantity)}
                              </span>
                            </div>
                          </div>
                        ))}
                        <div className="flex items-center justify-between px-3 py-2 border rounded-md bg-slate-50">
                          <span className="text-sm">Tạm tính</span>
                          <span className="text-sm tabular-nums">
                            {formatVND(invoiceSubtotal)}
                          </span>
                        </div>
                        {firstInvoiceDiscount.amount > 0 && (
                          <div
                            className="flex items-center justify-between px-3 py-2 border rounded-md bg-amber-50 border-amber-200"
                            title={firstInvoiceDiscount.notes}
                          >
                            <div className="flex flex-col">
                              <span className="text-sm text-amber-900">Giảm trừ</span>
                              <span className="text-[11px] text-amber-700 leading-tight">
                                {firstInvoiceDiscount.notes}
                              </span>
                            </div>
                            <span className="text-sm tabular-nums text-amber-900">
                              −{formatVND(firstInvoiceDiscount.amount)}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-between px-3 py-2 border rounded-md bg-muted/40">
                          <span className="text-sm font-semibold">Tổng cộng</span>
                          <span className="text-sm font-semibold tabular-nums">
                            {formatVND(invoiceTotal)}
                          </span>
                        </div>
                      </div>

                      {/* Desktop layout: table */}
                      <div className="hidden md:block border rounded-md overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b bg-muted/50">
                              <th className="text-left px-3 py-2 font-medium">Mô tả</th>
                              <th className="text-right px-3 py-2 font-medium w-20">SL</th>
                              <th className="text-right px-3 py-2 font-medium w-36">Đơn giá</th>
                              <th className="text-right px-3 py-2 font-medium w-36">Thành tiền</th>
                              <th className="w-10"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {invoiceItems.map((it) => (
                              <tr key={it.id}>
                                <td className="px-3 py-2">
                                  <Input
                                    className="h-8 text-sm"
                                    value={it.description}
                                    onChange={(e) =>
                                      updateInvoiceItem(it.id, "description", e.target.value)
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  <NumberInput
                                    min={1}
                                    className="w-16 h-8 text-right ml-auto"
                                    value={it.quantity}
                                    onChange={(v) =>
                                      updateInvoiceItem(it.id, "quantity", v || 1)
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  <CurrencyInput
                                    suffix={false}
                                    className="w-32 h-8 text-right ml-auto"
                                    value={it.unit_price}
                                    onChange={(v) =>
                                      updateInvoiceItem(it.id, "unit_price", v)
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2 text-right font-medium tabular-nums">
                                  {formatVND(it.unit_price * it.quantity)}
                                </td>
                                <td className="px-3 py-2">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-destructive hover:text-destructive"
                                    onClick={() => removeInvoiceItem(it.id)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t bg-slate-50">
                              <td colSpan={3} className="px-3 py-2 text-right">
                                Tạm tính
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {formatVND(invoiceSubtotal)}
                              </td>
                              <td></td>
                            </tr>
                            {firstInvoiceDiscount.amount > 0 && (
                              <tr
                                className="bg-amber-50 border-amber-200"
                                title={firstInvoiceDiscount.notes}
                              >
                                <td colSpan={3} className="px-3 py-2 text-right text-amber-900">
                                  <div className="flex flex-col items-end leading-tight">
                                    <span>Giảm trừ</span>
                                    <span className="text-[11px] text-amber-700">
                                      {firstInvoiceDiscount.notes}
                                    </span>
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right text-amber-900 tabular-nums">
                                  −{formatVND(firstInvoiceDiscount.amount)}
                                </td>
                                <td></td>
                              </tr>
                            )}
                            <tr className="bg-muted/40">
                              <td colSpan={3} className="px-3 py-2 text-right font-semibold">
                                Tổng cộng
                              </td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums">
                                {formatVND(invoiceTotal)}
                              </td>
                              <td></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ===== Footer buttons ===== */}
              <div className="flex justify-end gap-3 pt-4 border-t">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isPending}
                >
                  Hủy
                </Button>
                <Button
                  type="submit"
                  disabled={isPending || blockByDepositDebt}
                  title={
                    blockByDepositDebt
                      ? "Khách chưa đóng đủ cọc — tích \"Đồng ý cho nợ cọc\" để lưu"
                      : undefined
                  }
                >
                  {isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {isEditMode ? "Cập nhật" : "Lưu"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>

        {/* Sub-dialogs */}
        <CustomerSelectionDialog
          open={customerDialogOpen}
          onOpenChange={setCustomerDialogOpen}
          selectedCustomerIds={selectedCustomers.map((c) => c.id)}
          onSelect={handleCustomersSelected}
        />
        <ServiceSelectionDialog
          open={serviceDialogOpen}
          onOpenChange={setServiceDialogOpen}
          selectedServiceIds={selectedServices.map((s) => s.id)}
          onSelect={handleServicesSelected}
          buildingId={selectedBuildingId || undefined}
        />
      </DialogContent>
    </Dialog>

    {/* Modal tạo phiếu chi hoa hồng — chỉ mở sau khi tạo HĐ thành công */}
    <CommissionVoucherModal
      open={!!commissionContractId}
      contractId={commissionContractId}
      onOpenChange={(o) => {
        if (!o) setCommissionContractId(null);
      }}
    />

    </>
  );
}
