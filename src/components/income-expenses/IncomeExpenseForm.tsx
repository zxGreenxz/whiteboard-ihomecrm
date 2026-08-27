import { useState, useEffect, useRef, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { DateSegmentInput } from '@/components/ui/date-segment-input';
import { MonthInput } from '@/components/ui/month-input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Plus, Trash2, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import { useVoucherSlotWarning } from '@/hooks/useVoucherSlotWarning';
import {
  incomeExpenseFormSchema,
  type IncomeExpenseFormValues,
} from '@/lib/incomeExpenseValidation';
import { addCycle, type RepeatCycle } from '@/lib/recurring';
import {
  dateToMonth,
  monthToStartDate,
  monthToEndDate,
  currentMonth,
} from '@/lib/monthPeriod';
import {
  useCreateIncomeExpense,
  useUpdateIncomeExpense,
  type IncomeExpenseWithRelations,
} from '@/hooks/useIncomeExpenses';
import {
  forfeitKqkdGate,
  forfeitKqkdReasonValid,
  FORFEIT_KQKD_REASON_MIN,
} from '@/lib/financeV2VoucherState';
import { useSetForfeitVoucherKqkd } from '@/hooks/income-expenses/forfeitKqkd';
import { useIsCompanyOwner } from '@/hooks/useIsCompanyOwner';
import {
  useIncomeExpenseFormBuildings,
  useIncomeExpenseFormRooms,
} from '@/hooks/useIncomeExpenseFormScope';
import { useAccounts } from '@/hooks/useAccounts';
import { useMyCashbookAccessV2 } from '@/hooks/income-expenses/financeV2Mutations';
import { useContractsLegacy } from '@/hooks/useContracts';
import { useIncomeExpenseTypes, type IncomeExpenseType } from '@/hooks/useIncomeExpenseTypes';
import IncomeExpenseItemSelector from './IncomeExpenseItemSelector';
import AttachmentUpload from './AttachmentUpload';
import BankSelect from './BankSelect';
import { matchRecipientBankCode, RECIPIENT_BANKS } from '@/lib/vietqrDeeplink';
import { useAuth } from '@/hooks/useAuth';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { useIsMobile } from '@/hooks/use-mobile';
import { todayISO } from '@/lib/collect';

interface IncomeExpenseFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucher?: IncomeExpenseWithRelations | null;
  /**
   * "Tạo bản sao" từ phiếu đã HUỶ: mở form ở chế độ TẠO MỚI nhưng prefill
   * toàn bộ thông tin phiếu cũ (kể cả hình ảnh đính kèm — copy URL, không
   * duplicate file). Nhân viên sửa lại chỗ sai rồi Lưu thành phiếu mới.
   * Bỏ qua khi `voucher` (chế độ sửa) đang set.
   */
  copyFrom?: IncomeExpenseWithRelations | null;
  defaultType?: 'INCOME' | 'EXPENSE';
  /**
   * Khi mở dialog ở chế độ "tạo mới" (không có voucher), prefill các field
   * này để rút ngắn thao tác cho user. Vẫn cho phép user sửa lại trước khi
   * lưu — chỉ là giá trị khởi tạo.
   */
  defaultPrefill?: {
    building_id?: string;
    room_id?: string | null;
    name?: string;
    items?: Array<{
      income_expense_type_id: string;
      type_name: string;
      quantity: number;
      unit_price: number;
      description?: string | null;
    }>;
    /**
     * Kỳ áp dụng mặc định cho MỌI item (items prefill + item thêm mới trong
     * form), 'yyyy-MM-dd' ngày đầu/cuối tháng. Không truyền → tháng hiện tại
     * (hành vi cũ). Chỉ dùng ở chế độ tạo mới — vd trang báo cáo tháng 06 tạo
     * phiếu bù thì kỳ item phải là 06 chứ không phải tháng hiện tại.
     */
    period?: { start_date: string; end_date: string };
  };
  /**
   * Callback sau khi tạo mới phiếu thành công (không gọi khi edit).
   * Param `totalAmount` là tổng items đã lưu, để caller cập nhật UI ngoài.
   */
  onSaved?: (totalAmount: number) => void;
}

/** Shape prefill cho caller bên ngoài (trang báo cáo…) khai state đúng kiểu. */
export type IncomeExpensePrefill = NonNullable<IncomeExpenseFormProps['defaultPrefill']>;

interface FormItemRow {
  income_expense_type_id: string;
  type_name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  start_date: string;
  end_date: string;
}

/** Nhãn tiếng Việt cho contracts.status thô (dùng hiển thị trong dropdown HĐ). */
const CONTRACT_STATUS_VI: Record<string, string> = {
  ACTIVE: 'Đang hiệu lực',
  EXTENDED: 'Đã gia hạn',
  TRANSFERRED: 'Đã nhượng',
  TERMINATED: 'Đã thanh lý',
  EXPIRED: 'Quá hạn',
  DRAFT: 'Nháp',
};

const IncomeExpenseForm = ({
  open,
  onOpenChange,
  voucher,
  copyFrom,
  defaultType,
  defaultPrefill,
  onSaved,
}: IncomeExpenseFormProps) => {
  const isEditing = !!voucher;
  // Nguồn dữ liệu đổ vào form: phiếu đang SỬA, hoặc phiếu gốc khi TẠO BẢN SAO.
  // isEditing vẫn chỉ theo `voucher` → copy mode submit qua đường TẠO MỚI.
  const populateSource = voucher ?? copyFrom ?? null;
  const createMutation = useCreateIncomeExpense();
  const updateMutation = useUpdateIncomeExpense();
  const { data: authUser } = useAuth();
  const { data: isAdmin = false } = useIsAdmin();
  // Chủ công ty KHÁC chủ tổ chức: xem đầu useIsCompanyOwner (vai "Chủ công ty"
  // có system_key NULL nên is_org_owner_self_v1 bỏ sót chính chủ doanh nghiệp).
  const { data: isCompanyOwner = false } = useIsCompanyOwner();
  const forfeitKqkdMutation = useSetForfeitVoucherKqkd();
  // Lý do sửa — chỉ dùng cho cửa đổi KQKD của phiếu bỏ cọc. Không đưa vào zod
  // schema của phiếu vì nó không phải một trường của phiếu, nó là bằng chứng
  // cho MỘT thao tác.
  const [forfeitReason, setForfeitReason] = useState('');
  const isMobile = useIsMobile();

  // Cascade dropdown state
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | undefined>(undefined);
  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(undefined);
  // Dropdown HĐ mặc định CHỈ hiện HĐ đang hiệu lực (ACTIVE); bật cờ này để hiện
  // thêm HĐ đã thanh lý/nhượng/hết hạn khi cần gắn phiếu vào HĐ cũ.
  const [showInactiveContracts, setShowInactiveContracts] = useState(false);

  // Item selector dialog
  const [isItemSelectorOpen, setIsItemSelectorOpen] = useState(false);

  // Item rows with type_name for display (not part of Zod schema)
  const [itemRows, setItemRows] = useState<FormItemRow[]>([]);

  // Cascade data hooks — RPC riêng cho form thu chi: mặc định chỉ toà quản lý,
  // có quyền income_expenses.all_buildings → mọi toà của chủ (managed xếp đầu).
  // Tòa "Chung" (ảo) cho chi/thu chung công ty cũng nằm trong kết quả.
  const { data: buildings = [] } = useIncomeExpenseFormBuildings();
  const { data: rooms = [] } = useIncomeExpenseFormRooms(selectedBuildingId);

  // Tách toà quản lý (xếp lên đầu) vs toà mở rộng (qua quyền all_buildings).
  // Chỉ chia nhóm khi có cả hai → tránh hiện nhãn nhóm thừa cho user thường.
  const managedBuildings = buildings.filter((b) => b.managed);
  const otherBuildings = buildings.filter((b) => !b.managed);
  const showBuildingGroups = managedBuildings.length > 0 && otherBuildings.length > 0;
  const { data: accounts = [] } = useAccounts();
  const { data: myAccess } = useMyCashbookAccessV2();
  // Danh sách HĐ trên phòng đã chọn — để link phiếu cọc đúng HĐ.
  const { data: roomContracts = [] } = useContractsLegacy(
    selectedRoomId ? { room_id: selectedRoomId } : undefined,
  );
  // Lookup is_deposit cho từng type_id → biết phiếu có cọc hay không.
  const { data: incomeTypes = [] } = useIncomeExpenseTypes('income');
  const { data: expenseTypes = [] } = useIncomeExpenseTypes('expense');

  // Tập type_id thuộc hạng mục "cọc" (is_deposit) — gồm cả thu (Tiền cọc) lẫn
  // chi (Hoàn cọc thanh lý) → dùng để tự suy mặc định cờ "Hạch toán KQKD".
  const depositTypeIds = new Set(
    [...incomeTypes, ...expenseTypes]
      .filter((t) => t.is_deposit)
      .map((t) => t.id),
  );

  // Kỳ áp dụng mặc định cho item (prefill + thêm mới): ưu tiên kỳ caller truyền
  // qua defaultPrefill.period (vd tháng đang xem của báo cáo), fallback tháng
  // hiện tại. Guard !voucher → chế độ SỬA giữ nguyên hành vi cũ (tháng hiện tại).
  const prefillPeriodStart =
    (!voucher && defaultPrefill?.period?.start_date) || monthToStartDate(currentMonth());
  const prefillPeriodEnd =
    (!voucher && defaultPrefill?.period?.end_date) || monthToEndDate(currentMonth());

  const form = useForm<IncomeExpenseFormValues>({
    resolver: zodResolver(incomeExpenseFormSchema),
    defaultValues: {
      type: defaultType ?? 'INCOME',
      name: '',
      building_id: '',
      room_id: null,
      tenant_id: null,
      contract_id: null,
      payer_name: '',
      receive_bank_account: '',
      receive_bank_name: '',
      account_id: '',
      voucher_date: todayISO(),
      business_result_accounting: null,
      repeat_cycle: 'NONE',
      repeat_infinity: false,
      repeat_count: 0,
      repeat_auto_approve: true,
      attachments: [],
      items: [],
    },
  });

  const voucherType = form.watch('type');

  // ── Cảnh báo trùng ô ────────────────────────────────────────────────
  // Ô = (toà, loại phiếu, kỳ chồng lấn). Bấm đôi đã bị chặn từ trước (RPC bắt
  // buộc idempotency key + REVOKE INSERT thẳng bảng); phần CÒN HỞ là HAI NGƯỜI
  // cùng trả một tháng cách nhau nhiều ngày — ca thật 405PVB: PC2607077
  // 52.500.000đ do "NG TÂM" tạo 02/07, rồi PC2607063 cùng số tiền do "NATHAN"
  // tạo 11/07. Không khoá nào bắt được, chỉ có cách cho người ta THẤY.
  // Chỉ CẢNH BÁO, không chặn: 20/24 ô trùng trên prod có số tiền KHÁC nhau và
  // đều hợp lệ.
  // Lấy khoảng kỳ RỘNG NHẤT trong các dòng hạng mục để phiếu nhiều kỳ vẫn soi
  // được; chưa khai kỳ thì hook tự tắt (không có gì để so).
  const slotPeriod = useMemo(() => {
    const starts = itemRows.map((r) => r.start_date).filter(Boolean).sort();
    const ends = itemRows.map((r) => r.end_date).filter(Boolean).sort();
    if (!starts.length || !ends.length) return { start: null, end: null };
    return { start: starts[0], end: ends[ends.length - 1] };
  }, [itemRows]);

  const slotWarning = useVoucherSlotWarning({
    buildingId: selectedBuildingId,
    typeIds: itemRows.map((r) => r.income_expense_type_id),
    start: slotPeriod.start,
    end: slotPeriod.end,
    type: voucherType === 'INCOME' ? 'INCOME' : 'EXPENSE',
    excludeId: voucher?.id ?? null,
  });
  const slotHits = slotWarning.data ?? [];
  // §12.6 (V2): chọn sổ theo VAI TRÒ — Phiếu chi: chỉ sổ mình GIỮ (CUSTODIAN);
  // Phiếu thu: sổ GIỮ + sổ BIẾT (KNOWER). RPC lỗi → fail-open giữ list cũ;
  // user chưa có binding nào → legacy list (ngoài ma trận, server vẫn chặn §9.2).
  const selectableAccounts = useMemo(() => {
    if (!Array.isArray(myAccess)) return accounts;
    const wanted = voucherType === 'EXPENSE'
      ? new Set(myAccess.filter((b) => b.possession_kind === 'CUSTODIAN').map((b) => b.cashbook_id))
      : new Set(myAccess.filter((b) => b.possession_kind === 'CUSTODIAN' || b.possession_kind === 'KNOWER').map((b) => b.cashbook_id));
    if (wanted.size === 0) return accounts;
    return accounts.filter((a) => wanted.has(a.id) || a.is_virtual);
  }, [accounts, myAccess, voucherType]);

  // When voucher type changes, reset items (income types differ from expense types)
  useEffect(() => {
    // Only reset items when type changes in create mode (not during initial load)
    if (!voucher && open && form.formState.isDirty) {
      setItemRows([]);
      form.setValue('items', [], { shouldValidate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voucherType]);

  // Populate form when editing/copying or reset when adding
  useEffect(() => {
    if (!open) return;

    if (populateSource) {
      // Chế độ SỬA (voucher) hoặc TẠO BẢN SAO (copyFrom): đổ toàn bộ dữ liệu
      // phiếu nguồn vào form — bản sao giữ nguyên cả attachments (copy URL).
      const src = populateSource;
      setSelectedBuildingId(src.building_id);
      setSelectedRoomId(src.room_id ?? undefined);

      // Kỳ áp dụng mặc định (chỉ dùng khi item cũ chưa có start/end) = tháng hiện tại.
      // KHÔNG ghi đè giá trị có sẵn của item — chỉ fallback khi null.
      const defPeriodStart = monthToStartDate(currentMonth());
      const defPeriodEnd = monthToEndDate(currentMonth());

      form.reset({
        type: src.type,
        name: src.name,
        building_id: src.building_id,
        room_id: src.room_id ?? null,
        tenant_id: src.tenant_id ?? null,
        contract_id: src.contract_id ?? null,
        payer_name: src.payer_name ?? '',
        receive_bank_account: src.receive_bank_account ?? '',
        // Bank cũ là text gõ tay ("VIETTINBANK") → chuẩn hoá về shortName
        // trong danh sách dropdown; không nhận diện được thì giữ nguyên.
        receive_bank_name: (() => {
          const legacy = src.receive_bank_name ?? '';
          const code = matchRecipientBankCode(legacy);
          return code
            ? RECIPIENT_BANKS.find((b) => b.code === code)!.shortName
            : legacy;
        })(),
        account_id: src.account_id ?? '',
        voucher_date: src.voucher_date,
        business_result_accounting: src.business_result_accounting ?? null,
        repeat_cycle: (src.repeat_cycle as any) ?? 'NONE',
        repeat_infinity: src.repeat_infinity ?? false,
        repeat_count: src.repeat_count ?? 0,
        repeat_auto_approve: (src as any).repeat_auto_approve ?? true,
        attachments: src.attachments ?? [],
        items: src.items.map((item) => ({
          income_expense_type_id: item.income_expense_type_id,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? defPeriodStart,
          end_date: item.end_date ?? defPeriodEnd,
        })),
      });

      setItemRows(
        src.items.map((item) => ({
          income_expense_type_id: item.income_expense_type_id,
          type_name: item.type_name,
          description: item.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          start_date: item.start_date ?? defPeriodStart,
          end_date: item.end_date ?? defPeriodEnd,
        }))
      );
    } else {
      const prefillBuilding = defaultPrefill?.building_id;
      const prefillRoom = defaultPrefill?.room_id ?? null;
      setSelectedBuildingId(prefillBuilding ?? undefined);
      setSelectedRoomId(prefillRoom ?? undefined);

      const today = todayISO();
      // Kỳ áp dụng mặc định cho hạng mục: theo defaultPrefill.period nếu có,
      // fallback tháng hiện tại (prefillPeriodStart/End khai ở trên).
      const prefillItemsForm = (defaultPrefill?.items ?? []).map((it) => ({
        income_expense_type_id: it.income_expense_type_id,
        description: it.description ?? null,
        quantity: it.quantity,
        unit_price: it.unit_price,
        start_date: prefillPeriodStart,
        end_date: prefillPeriodEnd,
      }));
      const prefillItemsRows = (defaultPrefill?.items ?? []).map((it) => ({
        income_expense_type_id: it.income_expense_type_id,
        type_name: it.type_name,
        description: it.description ?? null,
        quantity: it.quantity,
        unit_price: it.unit_price,
        start_date: prefillPeriodStart,
        end_date: prefillPeriodEnd,
      }));

      form.reset({
        type: defaultType ?? 'INCOME',
        name: defaultPrefill?.name ?? '',
        building_id: prefillBuilding ?? '',
        room_id: prefillRoom,
        tenant_id: null,
        contract_id: null,
        payer_name: '',
        receive_bank_account: '',
        receive_bank_name: '',
        account_id: '',
        voucher_date: today,
        business_result_accounting: null,
        repeat_cycle: 'NONE',
        repeat_infinity: false,
        repeat_count: 0,
        repeat_auto_approve: true,
        attachments: [],
        items: prefillItemsForm,
      });
      setItemRows(prefillItemsRows);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [populateSource, open, defaultType, defaultPrefill, form]);

  // Cascade: when building changes → clear room, tenant, contract
  const handleBuildingChange = (buildingId: string) => {
    setSelectedBuildingId(buildingId);
    setSelectedRoomId(undefined);
    setShowInactiveContracts(false);
    form.setValue('building_id', buildingId);
    form.setValue('room_id', null);
    form.setValue('tenant_id', null);
    form.setValue('contract_id', null);
    autoLinkedContractIdRef.current = null;
  };

  // Cascade: when room changes → clear tenant + contract
  const handleRoomChange = (roomId: string) => {
    const value = roomId === '__none__' ? null : roomId;
    setSelectedRoomId(value ?? undefined);
    setShowInactiveContracts(false);
    form.setValue('room_id', value);
    form.setValue('tenant_id', null);
    form.setValue('contract_id', null);
    autoLinkedContractIdRef.current = null;
  };

  // Phiếu có phải "phiếu cọc" hay không (có ít nhất 1 item is_deposit)?
  const hasDepositItem = itemRows.some((r) =>
    depositTypeIds.has(r.income_expense_type_id),
  );

  // HĐ do effect dưới TỰ gắn (phân biệt với user tự chọn trong dropdown) —
  // chỉ giá trị auto mới được phép tự gỡ lại khi phiếu chuyển thành phiếu cọc.
  const autoLinkedContractIdRef = useRef<string | null>(null);

  // Auto-prefill contract_id khi:
  //  • Đang tạo mới (chưa có voucher)
  //  • Đã pick room
  //  • Có đúng 1 HĐ ACTIVE trên phòng đó
  // Tránh ghi đè khi user đang edit phiếu cũ hoặc đã chọn HĐ rồi.
  // NGOẠI LỆ phiếu CỌC: HĐ active đã đóng ĐỦ cọc → tiền cọc mới gần như chắc
  // là của khách KẾ TIẾP (giữ chỗ) → mặc định "-- Không gắn HĐ --" để phiếu
  // là cọc mồ côi, trigger DB tự link khi HĐ mới được tạo. Gắn nhầm vào HĐ
  // active làm phồng deposit_paid của khách cũ + form tạo HĐ mới báo thiếu
  // cọc (vụ PT2607014). HĐ active còn THIẾU cọc thì vẫn auto-gắn (thu bổ
  // sung cọc của chính khách đó).
  useEffect(() => {
    if (voucher || copyFrom) return; // edit/copy mode → giữ value cũ/đã copy
    const activeContracts = roomContracts.filter(
      (c: any) => c.status === 'ACTIVE',
    );
    if (activeContracts.length !== 1) return;
    const active = activeContracts[0] as any;
    const activeFullyDeposited =
      Number(active.deposit_paid ?? 0) >= Number(active.total_deposit ?? 0);
    const currentValue = form.getValues('contract_id');

    if (hasDepositItem && activeFullyDeposited) {
      // Gỡ lại giá trị đã auto-gắn trước khi user thêm item cọc; giá trị do
      // user tự chọn thì tôn trọng, không đụng.
      if (currentValue && currentValue === autoLinkedContractIdRef.current) {
        form.setValue('contract_id', null);
        autoLinkedContractIdRef.current = null;
      }
      return;
    }
    if (!currentValue) {
      form.setValue('contract_id', active.id);
      autoLinkedContractIdRef.current = active.id;
    }
  }, [roomContracts, voucher, form, hasDepositItem]);
  // Giá trị "tự động" của cờ KQKD (khi business_result_accounting = null).
  const autoBusinessResult = !hasDepositItem;

  const handleAccountChange = (accountId: string) => {
    form.setValue('account_id', accountId);
  };

  // Item selector callback
  const handleItemsSelected = (types: IncomeExpenseType[]) => {
    const existingIds = new Set(itemRows.map((r) => r.income_expense_type_id));
    // Kỳ áp dụng mặc định khi thêm hạng mục: theo defaultPrefill.period (tạo
    // mới từ trang báo cáo), fallback tháng hiện tại.
    const newRows: FormItemRow[] = [];

    for (const t of types) {
      if (!existingIds.has(t.id)) {
        newRows.push({
          income_expense_type_id: t.id,
          type_name: t.name,
          description: null,
          quantity: 1,
          unit_price: 0,
          start_date: prefillPeriodStart,
          end_date: prefillPeriodEnd,
        });
      }
    }

    // Remove items that were unchecked
    const selectedIds = new Set(types.map((t) => t.id));
    const kept = itemRows.filter((r) => selectedIds.has(r.income_expense_type_id));

    const merged = [...kept, ...newRows];
    setItemRows(merged);
    syncItemsToForm(merged);
  };

  const syncItemsToForm = (rows: FormItemRow[]) => {
    form.setValue(
      'items',
      rows.map((r) => ({
        income_expense_type_id: r.income_expense_type_id,
        description: r.description,
        quantity: r.quantity,
        unit_price: r.unit_price,
        start_date: r.start_date,
        end_date: r.end_date,
      })),
      { shouldValidate: form.formState.isSubmitted }
    );
  };

  const handleItemDescriptionChange = (index: number, value: string) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], description: value || null };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleItemQuantityChange = (index: number, value: number) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], quantity: value };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleItemPriceChange = (index: number, value: number) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], unit_price: value };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleItemStartDateChange = (index: number, value: string) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], start_date: value };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleItemEndDateChange = (index: number, value: string) => {
    const updated = [...itemRows];
    updated[index] = { ...updated[index], end_date: value };
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const handleRemoveItem = (index: number) => {
    const updated = itemRows.filter((_, i) => i !== index);
    setItemRows(updated);
    syncItemsToForm(updated);
  };

  const onSubmit = async (data: IncomeExpenseFormValues) => {
    try {
      // Cửa hẹp phiếu bỏ cọc: KHÔNG đụng updateMutation. Đường thường sẽ chết ở
      // trigger writer thanh lý, và nó cũng sẽ ghi cả những cột ta cố ý không
      // cho sửa. Ở đây gửi đúng một cờ + lý do.
      if (forfeitKqkdMode && voucher) {
        if (!forfeitKqkdChanged) {
          onOpenChange(false);
          return;
        }
        await forfeitKqkdMutation.mutateAsync({
          voucherId: voucher.id,
          kqkd: forfeitKqkdNext,
          reason: forfeitReason.trim(),
        });
        onOpenChange(false);
        return;
      }
      if (isEditing && voucher) {
        await updateMutation.mutateAsync({ id: voucher.id, data });
      } else {
        await createMutation.mutateAsync(data);
        // Báo cho caller (vd ContractFormDialog) biết phiếu vừa tạo có tổng
        // bao nhiêu để cập nhật field "Đã đặt cọc" ngay tại form HĐ.
        const total = data.items.reduce(
          (sum, it) => sum + (it.quantity ?? 0) * (it.unit_price ?? 0),
          0,
        );
        onSaved?.(total);
      }
      onOpenChange(false);
    } catch {
      // Errors handled by mutation hooks (toast)
    }
  };

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    forfeitKqkdMutation.isPending;
  // Phiếu Nháp (UNAPPROVED): cho phép sửa.
  // Phiếu đã ghi nhận/đã huỷ: chỉ xem (read-only) — TRỪ Super Admin.
  // Super Admin: edit được mọi phiếu (lẻ hoặc trong đợt) ở mọi trạng thái,
  // của bất kỳ ai. Khớp với RLS bypass ở DB (xem 20260506000002).
  // Tạo mới: edit được.
  const isUnapprovedDraft = voucher?.approval_status === 'UNAPPROVED';

  // ── Cặp bút toán bỏ cọc: một cửa RẤT hẹp ───────────────────────────────
  // Trigger guard_termination_forfeit_voucher_v1 chặn MỌI ghi lên hai chân của
  // cặp nếu transaction không giữ năng lực "writer thanh lý" — nó không nhìn
  // user, nên super admin bấm Lưu ở đường thường cũng nhận đúng câu
  // "Bút toán bỏ cọc chỉ được tạo hoặc sửa bởi writer thanh lý". Vì thế:
  //   · KHOÁ hẳn đường sửa thường cho cả hai chân (đỡ mời người dùng làm việc
  //     chắc chắn hỏng),
  //   · và mở đúng MỘT ô — cờ KQKD trên chân doanh thu — đi qua RPC riêng
  //     set_forfeit_voucher_kqkd_v1, chỉ cho chủ công ty / super admin.
  const { isForfeitLeg, forfeitKqkdMode, canEditNormally } = forfeitKqkdGate(
    voucher,
    { isAdmin, isCompanyOwner },
  );

  const canEdit = canEditNormally;
  const isViewing = !!voucher && !canEdit && !forfeitKqkdMode;
  const isAdminOverride =
    !!voucher && !isUnapprovedDraft && isAdmin && !isForfeitLeg;

  // Giá trị cờ KQKD đang hiển thị vs giá trị gốc của phiếu. `null` nghĩa là
  // "tự động", nên phải so ở mức HIỆU LỰC chứ không so thẳng null với boolean.
  const forfeitKqkdWatched = form.watch('business_result_accounting');
  const forfeitKqkdNext =
    forfeitKqkdWatched === null || forfeitKqkdWatched === undefined
      ? autoBusinessResult
      : !!forfeitKqkdWatched;
  const forfeitKqkdOriginal =
    voucher?.business_result_accounting ?? autoBusinessResult;
  const forfeitKqkdChanged =
    forfeitKqkdMode && forfeitKqkdNext !== forfeitKqkdOriginal;
  const forfeitReasonOk = forfeitKqkdReasonValid(forfeitReason);

  const totalAmount = itemRows.reduce(
    (sum, item) => sum + item.quantity * item.unit_price,
    0
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={
            isMobile
              ? "max-w-full w-full h-[100dvh] !top-0 !left-0 !translate-x-0 !translate-y-0 rounded-none p-4 overflow-y-auto"
              : "sm:max-w-[800px] max-h-[90vh] overflow-y-auto"
          }
        >
          <DialogHeader>
            <DialogTitle>
              {forfeitKqkdMode
                ? 'HẠCH TOÁN KQKD — PHIẾU BỎ CỌC'
                : isAdminOverride
                ? 'SỬA PHIẾU (SUPER ADMIN)'
                : isUnapprovedDraft
                ? 'SỬA PHIẾU CHỜ DUYỆT'
                : isViewing
                ? 'CHI TIẾT PHIẾU'
                : 'THÊM PHIẾU THU/CHI'}
            </DialogTitle>
          </DialogHeader>

          {forfeitKqkdMode && (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 space-y-1">
              <p>
                Đây là <b>bút toán bỏ cọc</b> — một chân của cặp phiếu do luồng
                thanh lý sinh ra. Số tiền, sổ quỹ, hạng mục và hợp đồng{' '}
                <b>không sửa được</b>: sửa lệch một chân là cặp phiếu kẹt vĩnh
                viễn (không duyệt lại, không huỷ được).
              </p>
              <p>
                Thứ duy nhất đổi được ở đây là <b>hạch toán kết quả kinh doanh</b>.
                Nó <b>không</b> làm đổi tồn quỹ hay dòng tiền — cặp phiếu này chạy
                trên sổ nội bộ, không có bút toán tiền. Thứ đổi là{' '}
                <b>báo cáo lợi nhuận</b> của toà trong tháng phát sinh, kéo theo
                số đem chia cho cổ đông.
              </p>
            </div>
          )}
          {isForfeitLeg && !forfeitKqkdMode && (
            <p className="text-sm text-muted-foreground">
              Đây là <b>bút toán bỏ cọc</b> do luồng thanh lý sinh ra — chỉ xem.
              Muốn đổi cách hạch toán khoản này vào lợi nhuận, cần{' '}
              <b>chủ công ty</b> hoặc <b>super admin</b>.
            </p>
          )}

          {isAdminOverride && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              Bạn đang chỉnh sửa phiếu <b>đã ghi nhận/đã huỷ</b> với quyền{' '}
              <b>Super Admin</b>. Thay đổi sẽ ảnh hưởng trực tiếp đến tồn quỹ
              và lịch sử kế toán — hãy cân nhắc kỹ trước khi lưu.
            </p>
          )}
          {!isAdminOverride && isUnapprovedDraft && (
            <p className="text-sm text-muted-foreground">
              Phiếu đang ở trạng thái <b>Chờ duyệt</b>. Bạn có thể chỉnh sửa nội
              dung, sau đó ấn <b>Lưu</b> để cập nhật. Phiếu chỉ tính vào tồn
              quỹ khi đã được duyệt.
            </p>
          )}
          {isViewing && (
            <p className="text-sm text-muted-foreground">
              Phiếu đã được ghi nhận. Để bỏ ghi nhận, hãy đóng dialog này và
              ấn nút <b>Huỷ phiếu</b> trên dòng phiếu.
            </p>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Step 1: Voucher type tab toggle */}
              <Tabs
                value={form.watch('type')}
                onValueChange={(value) => form.setValue('type', value as 'INCOME' | 'EXPENSE')}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger
                    value="INCOME"
                    disabled={!canEdit}
                    className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    <ArrowUp className="h-4 w-4 mr-1" />
                    Phiếu thu
                  </TabsTrigger>
                  <TabsTrigger
                    value="EXPENSE"
                    disabled={!canEdit}
                    className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                  >
                    <ArrowDown className="h-4 w-4 mr-1" />
                    Phiếu chi
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {/* Step 2: Thông tin chung - Grid layout */}
              {/* Row 1: Tòa nhà, Phòng, Sổ quỹ */}
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="building_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tòa nhà *</FormLabel>
                      <FormControl>
                        <SearchableSelect
                          value={field.value || undefined}
                          onValueChange={handleBuildingChange}
                          disabled={!canEdit}
                          placeholder="Chọn tòa nhà"
                          searchPlaceholder="Tìm tòa nhà..."
                          options={
                            showBuildingGroups
                              ? [
                                  ...managedBuildings.map((b) => ({
                                    value: b.id,
                                    label: b.name ?? '',
                                    group: 'Toà quản lý',
                                  })),
                                  ...otherBuildings.map((b) => ({
                                    value: b.id,
                                    label: b.name ?? '',
                                    group: 'Toà khác',
                                  })),
                                ]
                              : buildings.map((b) => ({
                                  value: b.id,
                                  label: b.name ?? '',
                                }))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="room_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phòng</FormLabel>
                      <FormControl>
                        <SearchableSelect
                          value={field.value ?? '__none__'}
                          onValueChange={handleRoomChange}
                          disabled={!canEdit || !selectedBuildingId}
                          placeholder="Chọn phòng"
                          searchPlaceholder="Tìm phòng..."
                          options={[
                            { value: '__none__', label: '-- Không chọn --' },
                            ...rooms.map((r) => ({
                              value: r.id,
                              label: r.name ?? '',
                            })),
                          ]}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="account_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sổ quỹ *</FormLabel>
                      <FormControl>
                        <SearchableSelect
                          value={field.value || undefined}
                          onValueChange={handleAccountChange}
                          disabled={!canEdit}
                          placeholder="Chọn sổ quỹ"
                          searchPlaceholder="Tìm sổ quỹ..."
                          options={selectableAccounts.map((a) => ({
                            value: a.id,
                            label: `${a.name}${a.bank_name ? ` (${a.bank_name})` : ''}`,
                          }))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Row 1.5: Hợp đồng — chỉ hiển thị khi có room đã chọn + có HĐ
                  trên phòng đó. Phiếu cọc nên gắn HĐ để hệ thống tự đồng bộ
                  contracts.deposit_paid. Cọc trước khi có HĐ thì để trống —
                  trigger DB sẽ tự link khi HĐ được tạo cho cùng phòng. */}
              {selectedRoomId && roomContracts.length > 0 && (
                <FormField
                  control={form.control}
                  name="contract_id"
                  render={({ field }) => {
                    // Mặc định CHỈ hiện HĐ đang hiệu lực (ACTIVE). HĐ đã thanh lý/
                    // nhượng/hết hạn chỉ hiện khi tick "Hiện HĐ đã thanh lý". Luôn
                    // giữ HĐ đang chọn trong danh sách (vd phiếu cũ gắn HĐ thanh lý)
                    // để Select hiển thị đúng giá trị.
                    const inactiveContracts = roomContracts.filter(
                      (c: any) => c.status !== 'ACTIVE',
                    );
                    const visibleContracts = roomContracts.filter(
                      (c: any) =>
                        c.status === 'ACTIVE' ||
                        showInactiveContracts ||
                        c.id === field.value,
                    );
                    return (
                    <FormItem>
                      <div className="flex items-center justify-between gap-2">
                        <FormLabel>
                          Hợp đồng {hasDepositItem ? '(cọc)' : '(tuỳ chọn)'}
                        </FormLabel>
                        {inactiveContracts.length > 0 && (
                          <label className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground cursor-pointer select-none">
                            <Checkbox
                              checked={showInactiveContracts}
                              onCheckedChange={(v) =>
                                setShowInactiveContracts(v === true)
                              }
                            />
                            Hiện HĐ đã thanh lý
                          </label>
                        )}
                      </div>
                      <Select
                        onValueChange={(v) => {
                          // User tự tay chọn → không còn là giá trị auto-gắn,
                          // effect auto-link không được phép gỡ nữa.
                          autoLinkedContractIdRef.current = null;
                          field.onChange(v === '__none__' ? null : v);
                        }}
                        value={field.value ?? '__none__'}
                        disabled={!canEdit}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn hợp đồng" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">
                            -- Không gắn HĐ --
                          </SelectItem>
                          {visibleContracts.map((c: any) => {
                            const isActive = c.status === 'ACTIVE';
                            const statusVi =
                              CONTRACT_STATUS_VI[c.status] ?? c.status;
                            return (
                              <SelectItem
                                key={c.id}
                                value={c.id}
                                className={isActive ? undefined : 'opacity-60'}
                              >
                                {c.contract_number}
                                {c.tenant?.full_name
                                  ? ` · ${c.tenant.full_name}`
                                  : ''}
                                {statusVi ? ` · ${statusVi}` : ''}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      {hasDepositItem && !field.value && (
                        <p className="text-xs text-amber-600">
                          Phiếu cọc chưa gắn HĐ — sẽ tự link khi HĐ được tạo
                          trên phòng này.
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                    );
                  }}
                />
              )}

              {/* Row 2: Người gửi (INCOME) / Tên người nhận (EXPENSE) + Ngày — luôn cùng 1 dòng */}
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="payer_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {voucherType === 'EXPENSE' ? 'Tên người nhận' : 'Người gửi'}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={
                            voucherType === 'EXPENSE'
                              ? 'Nhập tên người nhận'
                              : 'Nhập tên người gửi'
                          }
                          {...field}
                          value={field.value ?? ''}
                          disabled={!canEdit}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="voucher_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {voucherType === 'EXPENSE' ? 'Ngày thực chi' : 'Ngày thực thu'} *
                      </FormLabel>
                      <FormControl>
                        <DateSegmentInput
                          value={field.value || ''}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          disabled={!canEdit}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Row 2b: (chỉ EXPENSE) STK + ngân hàng người nhận — phục vụ QR chi tiền */}
              {voucherType === 'EXPENSE' && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="receive_bank_account"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số TK người nhận</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Số tài khoản"
                            inputMode="numeric"
                            {...field}
                            value={field.value ?? ''}
                            disabled={!canEdit}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="receive_bank_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngân hàng người nhận</FormLabel>
                        <FormControl>
                          <BankSelect
                            value={field.value}
                            onChange={field.onChange}
                            disabled={!canEdit}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}

              {/* Row 3: Tên phiếu (textarea lớn — gộp tên + ghi chú) */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {voucherType === 'EXPENSE' ? 'Tên phiếu chi' : 'Tên phiếu thu'} *
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder={
                          voucherType === 'EXPENSE'
                            ? 'VD: Chi tiền điện tháng 7 — ghi chú thêm...'
                            : 'VD: Thu tiền phòng tháng 7 — ghi chú thêm...'
                        }
                        {...field}
                        disabled={!canEdit}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Step 3: Items */}
              <div className="space-y-3">
                {/* Business result accounting toggle (hybrid: auto theo hạng mục + override) */}
                <FormField
                  control={form.control}
                  name="business_result_accounting"
                  render={({ field }) => {
                    const isAuto = field.value === null || field.value === undefined;
                    const effective = isAuto ? autoBusinessResult : !!field.value;
                    return (
                      <FormItem className="flex items-center justify-between rounded-lg border p-3">
                        <div className="space-y-0.5">
                          <FormLabel className="text-sm font-medium">
                            Hạch toán kết quả kinh doanh?
                          </FormLabel>
                          <p className="text-xs text-muted-foreground">
                            {isAuto
                              ? hasDepositItem
                                ? 'Tự động: có hạng mục cọc → không tính vào lợi nhuận'
                                : 'Tự động: tính vào lợi nhuận'
                              : effective
                                ? 'Ép tính vào lợi nhuận (override)'
                                : 'Ép loại khỏi lợi nhuận (override)'}
                          </p>
                        </div>
                        <FormControl>
                          <Switch
                            checked={effective}
                            onCheckedChange={(v) => field.onChange(v)}
                            disabled={!canEdit && !forfeitKqkdMode}
                            data-testid="kqkd-switch"
                          />
                        </FormControl>
                      </FormItem>
                    );
                  }}
                />

                {/* Lý do — bắt buộc, và server cũng bắt (≥ 8 ký tự). Chỉ hiện khi
                    người dùng THẬT SỰ đã gạt công tắc, để không bày một ô trống
                    bắt điền cho người chỉ vào xem. */}
                {forfeitKqkdChanged && (
                  <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                    <label
                      htmlFor="forfeit-kqkd-reason"
                      className="text-sm font-medium"
                    >
                      Lý do đổi hạch toán <span className="text-destructive">*</span>
                    </label>
                    <Textarea
                      id="forfeit-kqkd-reason"
                      data-testid="forfeit-kqkd-reason"
                      value={forfeitReason}
                      onChange={(e) => setForfeitReason(e.target.value)}
                      placeholder="Vì sao khoản bỏ cọc này không tính (hoặc có tính) vào lợi nhuận?"
                      rows={2}
                    />
                    <p className="text-xs text-muted-foreground">
                      {forfeitReasonOk
                        ? 'Lý do sẽ được ghi vào nhật ký phiếu cùng người sửa và thời điểm.'
                        : `Cần ít nhất ${FORFEIT_KQKD_REASON_MIN} ký tự — đây là bằng chứng đối soát về sau.`}
                    </p>
                  </div>
                )}

                {/* Cảnh báo trùng ô — CHỈ thông báo, không chặn nút Lưu. Đặt ngay
                    trên bảng hạng mục để đọc được trước khi gõ số tiền. */}
                {slotHits.length > 0 && (
                  <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm"
                       data-testid="voucher-slot-warning">
                    <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      Toà này đã có {slotHits.length} phiếu cùng hạng mục cho kỳ đang chọn
                    </div>
                    <ul className="mt-2 space-y-1">
                      {slotHits.slice(0, 5).map((h) => (
                        <li key={h.voucherId} className="text-muted-foreground">
                          <span className="font-medium text-foreground">{h.code}</span>
                          {' · '}
                          <span className="tabular-nums">
                            {Math.round(h.matchedAmount).toLocaleString('vi-VN')}đ
                          </span>
                          {h.matchedAmount !== h.totalAmount && (
                            <> {'(cả phiếu '}
                              <span className="tabular-nums">
                                {Math.round(h.totalAmount).toLocaleString('vi-VN')}đ
                              </span>)
                            </>
                          )}
                          {' · '}{h.typeNames}
                          {' · '}{h.creatorName}
                          {h.voucherDate ? ` · ${h.voucherDate}` : ''}
                          {h.approvalStatus === 'UNAPPROVED' && (
                            <span className="ml-1 text-amber-700 dark:text-amber-400">
                              (đang chờ duyệt)
                            </span>
                          )}
                        </li>
                      ))}
                      {slotHits.length > 5 && (
                        <li className="text-muted-foreground">…và {slotHits.length - 5} phiếu nữa</li>
                      )}
                    </ul>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Kiểm tra xem khoản này đã được trả chưa. Nếu đây là khoản khác thì cứ tạo
                      bình thường — hệ thống không chặn.
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <FormLabel>Hạng mục</FormLabel>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setIsItemSelectorOpen(true)}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Thêm hạng mục
                    </Button>
                  )}
                </div>

                {/* Items validation error */}
                {form.formState.errors.items?.message && (
                  <p className="text-sm text-destructive">
                    {form.formState.errors.items.message}
                  </p>
                )}

                {itemRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2 text-center border rounded-lg">
                    Chưa có hạng mục nào. Ấn "Thêm hạng mục" để bắt đầu.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {/* Header row */}
                    <div className="grid grid-cols-[1fr_120px_120px_120px_36px] gap-2 text-xs text-muted-foreground font-medium px-1">
                      <span>Hạng mục</span>
                      <span>Số tiền</span>
                      <span>Từ tháng</span>
                      <span>Đến tháng</span>
                      <span></span>
                    </div>
                    {itemRows.map((item, index) => (
                      <div
                        key={`${item.income_expense_type_id}-${index}`}
                        className="grid grid-cols-[1fr_120px_120px_120px_36px] gap-2 items-center rounded-lg border p-2"
                      >
                        <p className="text-sm font-medium truncate">
                          {item.type_name}
                        </p>
                        <CurrencyInput
                          value={item.unit_price}
                          onChange={(v) => handleItemPriceChange(index, v)}
                          disabled={!canEdit}
                          className="h-8"
                          placeholder="Số tiền"
                        />
                        <MonthInput
                          value={dateToMonth(item.start_date)}
                          onChange={(m) =>
                            handleItemStartDateChange(index, monthToStartDate(m))
                          }
                          disabled={!canEdit}
                          className="h-8"
                        />
                        <MonthInput
                          value={dateToMonth(item.end_date)}
                          onChange={(m) =>
                            handleItemEndDateChange(index, monthToEndDate(m))
                          }
                          disabled={!canEdit}
                          className="h-8"
                        />
                        {canEdit && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0 h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => handleRemoveItem(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    ))}

                    {/* Total */}
                    <div className="flex justify-end pt-2 border-t">
                      <p className="text-sm font-semibold">
                        Tổng cộng:{' '}
                        <span className={voucherType === 'INCOME' ? 'text-green-600' : 'text-red-600'}>
                          {totalAmount.toLocaleString('vi-VN')} đ
                        </span>
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Cài đặt lặp lại — mirror Resident */}
              <div className="rounded-lg border border-zinc-200 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <FormLabel className="text-sm font-semibold">
                    Cài đặt lặp lại
                  </FormLabel>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <FormField
                    control={form.control}
                    name="repeat_cycle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Chu kỳ</FormLabel>
                        <Select
                          onValueChange={(v) => {
                            field.onChange(v);
                            // Tránh bẫy "cấu hình chết": chọn chu kỳ thì gợi ý
                            // số lần lặp = 1; chọn "Không lặp lại" thì reset.
                            if (v === 'NONE') {
                              form.setValue('repeat_count', 0);
                              form.setValue('repeat_infinity', false);
                            } else if (
                              !form.getValues('repeat_infinity') &&
                              (form.getValues('repeat_count') ?? 0) < 1
                            ) {
                              form.setValue('repeat_count', 1, {
                                shouldValidate: true,
                              });
                            }
                          }}
                          value={field.value ?? 'NONE'}
                          disabled={!canEdit}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="NONE">Không lặp lại</SelectItem>
                            <SelectItem value="WEEK">Hàng tuần</SelectItem>
                            <SelectItem value="MONTH">Hàng tháng</SelectItem>
                            <SelectItem value="QUARTER">Hàng quý</SelectItem>
                            <SelectItem value="YEAR">Hàng năm</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="repeat_count"
                    render={({ field }) => {
                      const cycle = form.watch('repeat_cycle');
                      const inf = form.watch('repeat_infinity');
                      const disabled = !canEdit || cycle === 'NONE' || inf;
                      return (
                        <FormItem>
                          <FormLabel>Số lần lặp</FormLabel>
                          <FormControl>
                            <NumberInput
                              value={field.value}
                              onChange={field.onChange}
                              onBlur={field.onBlur}
                              name={field.name}
                              min={0}
                              max={240}
                              disabled={disabled}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      );
                    }}
                  />

                  <FormField
                    control={form.control}
                    name="repeat_infinity"
                    render={({ field }) => {
                      const cycle = form.watch('repeat_cycle');
                      const disabled = !canEdit || cycle === 'NONE';
                      return (
                        <FormItem className="flex items-end justify-between rounded-md border p-2">
                          <FormLabel className="text-xs">Lặp vô hạn</FormLabel>
                          <FormControl>
                            <Switch
                              checked={!!field.value}
                              onCheckedChange={field.onChange}
                              disabled={disabled}
                            />
                          </FormControl>
                        </FormItem>
                      );
                    }}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="repeat_auto_approve"
                  render={({ field }) => {
                    const cycle = form.watch('repeat_cycle');
                    const disabled = !canEdit || cycle === 'NONE';
                    return (
                      <FormItem className="flex items-center justify-between rounded-md border p-2">
                        <div className="pr-3">
                          <FormLabel className="text-xs">Phiếu sinh ra tự động duyệt</FormLabel>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            Tắt = phiếu con sinh dạng <b>CHỜ DUYỆT, sổ quỹ trống</b> — thanh toán
                            (chọn sổ + ảnh CK) và duyệt tại trang Đóng tiền tập trung.
                          </p>
                        </div>
                        <FormControl>
                          <Switch
                            checked={field.value !== false}
                            onCheckedChange={field.onChange}
                            disabled={disabled}
                          />
                        </FormControl>
                      </FormItem>
                    );
                  }}
                />
                {(() => {
                  const cycle = form.watch('repeat_cycle');
                  const vDate = form.watch('voucher_date');
                  if (cycle && cycle !== 'NONE' && vDate) {
                    return (
                      <p className="text-xs text-muted-foreground">
                        Phiếu kế tiếp dự kiến:{' '}
                        <b>{addCycle(vDate, cycle as RepeatCycle, 1)}</b>
                      </p>
                    );
                  }
                  return null;
                })()}
                <p className="text-xs text-muted-foreground">
                  Phiếu hiện tại là kỳ đầu. Hệ thống <b>tự động</b> sinh các phiếu
                  kỳ tiếp theo mỗi ngày lúc 01:00 theo chu kỳ. "Số lần lặp" = số
                  phiếu sinh thêm ngoài phiếu này. Bấm{' '}
                  <b>Sinh phiếu lặp lại</b> trên thanh công cụ để chạy ngay.
                </p>
              </div>

              {/* Đính kèm */}
              <FormField
                control={form.control}
                name="attachments"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Đính kèm</FormLabel>
                    <FormControl>
                      <AttachmentUpload
                        attachments={field.value ?? []}
                        onChange={field.onChange}
                        disabled={!canEdit}
                        userId={authUser?.id ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Action buttons */}
              <div
                className={
                  isMobile
                    ? "sticky bottom-0 -mx-4 -mb-4 px-4 py-3 bg-white border-t border-zinc-200 flex gap-2 items-center"
                    : "flex justify-end gap-3 pt-4"
                }
                style={
                  isMobile
                    ? { paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }
                    : undefined
                }
              >
                <Button
                  type="button"
                  variant="outline"
                  className={isMobile ? "flex-1" : ""}
                  onClick={() => onOpenChange(false)}
                >
                  {isViewing ? 'Đóng' : 'Huỷ bỏ'}
                </Button>
                {(canEdit || forfeitKqkdMode) && (
                  <Button
                    type="submit"
                    // Cửa bỏ cọc: chưa gạt công tắc thì không có gì để lưu; gạt
                    // rồi thì phải có lý do — cùng ngưỡng với server để người
                    // dùng không bấm rồi mới ăn 22023.
                    disabled={
                      isPending ||
                      (forfeitKqkdMode && (!forfeitKqkdChanged || !forfeitReasonOk))
                    }
                    className={isMobile ? "flex-1" : ""}
                    data-testid="ie-form-save"
                  >
                    {isPending ? 'Đang lưu...' : 'Lưu'}
                  </Button>
                )}
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Item selector dialog */}
      <IncomeExpenseItemSelector
        open={isItemSelectorOpen}
        onOpenChange={setIsItemSelectorOpen}
        voucherType={voucherType}
        onSelect={handleItemsSelected}
        selectedTypeIds={itemRows.map((r) => r.income_expense_type_id)}
      />
    </>
  );
};

export default IncomeExpenseForm;
