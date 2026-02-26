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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Trash2, X } from "lucide-react";

import { contractFormSchema } from "@/lib/contractValidation";
import type { ContractFormData } from "@/lib/contractValidation";
import type { ContractWithRelations, PaymentCycle } from "@/types/contract";
import { PAYMENT_CYCLE_LABELS } from "@/types/contract";
import { useCreateContract, useUpdateContract } from "@/hooks/useContracts";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useBeds } from "@/hooks/useBeds";
import {
  CustomerSelectionDialog,
  type CustomerBasic,
} from "./CustomerSelectionDialog";
import {
  ServiceSelectionDialog,
  type ServiceBasic,
} from "./ServiceSelectionDialog";

interface ContractFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract?: ContractWithRelations;
}

// ---- Local state types for customers & services ----

interface SelectedCustomer extends CustomerBasic {
  is_representative: boolean;
}

interface SelectedService extends ServiceBasic {
  initial_reading: number;
  quantity: number;
}

function formatVND(amount: number): string {
  return new Intl.NumberFormat("vi-VN").format(amount) + " đ";
}

export function ContractFormDialog({
  open,
  onOpenChange,
  contract,
}: ContractFormDialogProps) {
  const isEditMode = !!contract;

  // Mutations
  const createContract = useCreateContract();
  const updateContract = useUpdateContract();
  const isPending = createContract.isPending || updateContract.isPending;

  // Data hooks
  const { data: buildings = [] } = useBuildings();

  // Cascading state
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>("");
  const [selectedRoomId, setSelectedRoomId] = useState<string>("");

  const { data: rooms = [] } = useRooms(selectedBuildingId || undefined);
  const { data: beds = [] } = useBeds(selectedRoomId || undefined);

  // Filtered rooms/beds for cascading
  const filteredRooms = useMemo(
    () => (selectedBuildingId ? rooms : []),
    [rooms, selectedBuildingId]
  );
  const filteredBeds = useMemo(
    () => (selectedRoomId ? beds : []),
    [beds, selectedRoomId]
  );

  // Customer & service local state
  const [selectedCustomers, setSelectedCustomers] = useState<SelectedCustomer[]>([]);
  const [selectedServices, setSelectedServices] = useState<SelectedService[]>([]);
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);

  // Form
  const form = useForm<ContractFormData>({
    resolver: zodResolver(contractFormSchema),
    defaultValues: {
      room_id: "",
      bed_id: null,
      signed_date: new Date().toISOString().split("T")[0],
      start_date: "",
      end_date: "",
      rent_price: 0,
      total_deposit: 0,
      deposit_paid: 0,
      payment_cycle: "MONTHLY" as PaymentCycle,
      start_billing_date: "",
      contract_template_id: null,
      invoice_template_id: null,
      notes: "",
      discount_months: 0,
      discount_amount_per_month: 0,
    },
  });

  const totalDeposit = form.watch("total_deposit") ?? 0;
  const depositPaid = form.watch("deposit_paid") ?? 0;
  const depositRemaining = Math.max(0, totalDeposit - depositPaid);

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
        bed_id: contract.bed_id ?? null,
        signed_date: contract.signed_date?.split("T")[0] ?? "",
        start_date: contract.start_date?.split("T")[0] ?? "",
        end_date: contract.end_date?.split("T")[0] ?? "",
        rent_price: contract.rent_price ?? 0,
        total_deposit: contract.total_deposit ?? 0,
        deposit_paid: contract.deposit_paid ?? 0,
        payment_cycle: contract.payment_cycle ?? "MONTHLY",
        start_billing_date: contract.start_billing_date?.split("T")[0] ?? "",
        contract_template_id: contract.contract_template_id ?? null,
        invoice_template_id: contract.invoice_template_id ?? null,
        notes: contract.notes ?? "",
        discount_months: contract.discounts?.months ?? 0,
        discount_amount_per_month: contract.discounts?.amount_per_month ?? 0,
      });

      // Pre-populate customers
      const customers: SelectedCustomer[] =
        contract.contract_customers?.map((cc) => ({
          id: cc.customer_id,
          full_name: cc.customer?.full_name ?? "",
          phone: cc.customer?.phone ?? "",
          id_number: cc.customer?.id_number ?? null,
          is_representative: cc.is_representative,
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
    } else {
      // Create mode: reset
      setSelectedBuildingId("");
      setSelectedRoomId("");
      setSelectedCustomers([]);
      setSelectedServices([]);
      form.reset({
        room_id: "",
        bed_id: null,
        signed_date: new Date().toISOString().split("T")[0],
        start_date: "",
        end_date: "",
        rent_price: 0,
        total_deposit: 0,
        deposit_paid: 0,
        payment_cycle: "MONTHLY",
        start_billing_date: "",
        contract_template_id: null,
        invoice_template_id: null,
        notes: "",
        discount_months: 0,
        discount_amount_per_month: 0,
      });
    }
  }, [open, contract, form]);

  // ---- Cascading handlers ----
  const handleBuildingChange = (buildingId: string) => {
    setSelectedBuildingId(buildingId);
    setSelectedRoomId("");
    form.setValue("room_id", "");
    form.setValue("bed_id", null);
  };

  const handleRoomChange = (roomId: string) => {
    setSelectedRoomId(roomId);
    form.setValue("room_id", roomId);
    form.setValue("bed_id", null);
  };

  const handleBedChange = (bedId: string) => {
    form.setValue("bed_id", bedId || null);
  };

  // ---- Customer handlers ----
  const handleCustomersSelected = (customers: CustomerBasic[]) => {
    const newCustomers: SelectedCustomer[] = customers.map((c) => {
      const existing = selectedCustomers.find((sc) => sc.id === c.id);
      return existing ?? { ...c, is_representative: false };
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

  // ---- Service handlers ----
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

  // ---- Submit handler ----
  const onSubmit = (data: ContractFormData) => {
    const customers = selectedCustomers.map((c) => ({
      customer_id: c.id,
      is_representative: c.is_representative,
    }));

    const services = selectedServices.map((s) => ({
      service_id: s.id,
      unit_price: s.unit_price,
      initial_reading: s.initial_reading || undefined,
    }));

    if (isEditMode && contract) {
      // Edit mode: update contract fields
      const updates: Record<string, any> = {
        room_id: data.room_id,
        bed_id: data.bed_id || null,
        signed_date: data.signed_date,
        start_date: data.start_date,
        end_date: data.end_date,
        rent_price: data.rent_price,
        total_deposit: data.total_deposit,
        deposit_paid: data.deposit_paid ?? 0,
        payment_cycle: data.payment_cycle,
        start_billing_date: data.start_billing_date || null,
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
        { onSuccess: () => onOpenChange(false) }
      );
    } else {
      // Create mode
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
            bed_id: data.bed_id || undefined,
            signed_date: data.signed_date,
            start_date: data.start_date,
            end_date: data.end_date,
            rent_price: data.rent_price,
            total_deposit: data.total_deposit,
            deposit_paid: data.deposit_paid,
            payment_cycle: data.payment_cycle,
            start_billing_date: data.start_billing_date || undefined,
            contract_template_id: data.contract_template_id || undefined,
            invoice_template_id: data.invoice_template_id || undefined,
            notes: data.notes || undefined,
            discounts,
          },
          customers,
          services,
        },
        { onSuccess: () => onOpenChange(false) }
      );
    }
  };

  return (
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
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
                            {filteredRooms.map((r: any) => (
                              <SelectItem key={r.id} value={r.id}>
                                {r.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Giường */}
                  <FormField
                    control={form.control}
                    name="bed_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Giường</FormLabel>
                        <Select
                          value={field.value ?? ""}
                          onValueChange={(val) => {
                            handleBedChange(val);
                            field.onChange(val || null);
                          }}
                          disabled={!selectedRoomId}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn giường" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {filteredBeds.map((b: any) => (
                              <SelectItem key={b.id} value={b.id}>
                                {b.name}
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
                          <Input type="date" {...field} />
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
                          <Input type="date" {...field} />
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
                          <Input type="date" {...field} />
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
                        <div
                          key={customer.id}
                          className="flex items-center gap-3 px-4 py-3"
                        >
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
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Tiền thuê */}
                  <FormField
                    control={form.control}
                    name="rent_price"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tiền thuê</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number(e.target.value))
                            }
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
                          <Input type="date" {...field} />
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
                          <Input
                            type="number"
                            min={0}
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number(e.target.value))
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Đã đặt cọc (readonly) */}
                  <FormField
                    control={form.control}
                    name="deposit_paid"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Đã đặt cọc</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            readOnly
                            className="bg-muted"
                            {...field}
                            onChange={(e) =>
                              field.onChange(Number(e.target.value))
                            }
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

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Số tháng giảm */}
                  <FormField
                    control={form.control}
                    name="discount_months"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số tháng giảm</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            {...field}
                            value={field.value ?? 0}
                            onChange={(e) =>
                              field.onChange(Number(e.target.value))
                            }
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
                          <Input
                            type="number"
                            min={0}
                            {...field}
                            value={field.value ?? 0}
                            onChange={(e) =>
                              field.onChange(Number(e.target.value))
                            }
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
                <div className="flex items-center justify-between border-b pb-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    Tiền phí dịch vụ
                  </h3>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setServiceDialogOpen(true)}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Thêm dịch vụ
                  </Button>
                </div>

                {selectedServices.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Chưa chọn dịch vụ nào
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
                              <Input
                                type="number"
                                min={0}
                                className="w-24 h-8 text-right ml-auto"
                                value={service.initial_reading}
                                onChange={(e) =>
                                  handleServiceFieldChange(
                                    service.id,
                                    "initial_reading",
                                    Number(e.target.value)
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min={1}
                                className="w-20 h-8 text-right ml-auto"
                                value={service.quantity}
                                onChange={(e) =>
                                  handleServiceFieldChange(
                                    service.id,
                                    "quantity",
                                    Number(e.target.value)
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min={0}
                                className="w-28 h-8 text-right ml-auto"
                                value={service.unit_price}
                                onChange={(e) =>
                                  handleServiceFieldChange(
                                    service.id,
                                    "unit_price",
                                    Number(e.target.value)
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
                <Button type="submit" disabled={isPending}>
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
  );
}
