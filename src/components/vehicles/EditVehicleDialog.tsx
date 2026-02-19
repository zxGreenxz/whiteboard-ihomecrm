import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useUpdateVehicle, useDeleteVehicle, type VehicleWithRelations } from "@/hooks/useVehicles";
import { useTenantsLegacy } from "@/hooks/useTenants";
import { useContractsLegacy } from "@/hooks/useContracts";

const vehicleSchema = z.object({
  tenant_id: z.string().min(1, "Phải chọn khách thuê"),
  contract_id: z.string().optional(),
  vehicle_type: z.enum(["MOTORBIKE", "CAR", "BICYCLE", "ELECTRIC_BIKE", "OTHER"]),
  license_plate: z.string().min(1, "Biển số là bắt buộc"),
  brand: z.string().optional(),
  model: z.string().optional(),
  color: z.string().optional(),
  parking_fee: z.number().min(0, "Phí gửi xe phải >= 0"),
  notes: z.string().optional(),
});

type VehicleFormValues = z.infer<typeof vehicleSchema>;

interface EditVehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicle: VehicleWithRelations;
}

export function EditVehicleDialog({ open, onOpenChange, vehicle }: EditVehicleDialogProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const updateVehicle = useUpdateVehicle();
  const deleteVehicle = useDeleteVehicle();
  const { data: tenants = [] } = useTenantsLegacy();
  const { data: contracts = [] } = useContractsLegacy();

  const form = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
    defaultValues: {
      tenant_id: "",
      contract_id: undefined,
      vehicle_type: "MOTORBIKE",
      license_plate: "",
      brand: "",
      model: "",
      color: "",
      parking_fee: 0,
      notes: "",
    },
  });

  useEffect(() => {
    if (vehicle) {
      form.reset({
        tenant_id: vehicle.tenant_id || "",
        contract_id: vehicle.contract_id || undefined,
        vehicle_type: vehicle.vehicle_type || "MOTORBIKE",
        license_plate: vehicle.license_plate || "",
        brand: vehicle.brand || "",
        model: vehicle.model || "",
        color: vehicle.color || "",
        parking_fee: vehicle.parking_fee || 0,
        notes: vehicle.notes || "",
      });
    }
  }, [vehicle, form]);

  const selectedTenantId = form.watch("tenant_id");
  const tenantContracts = contracts.filter(
    (c) => c.tenant_id === selectedTenantId && c.status === "ACTIVE"
  );

  const onSubmit = async (data: VehicleFormValues) => {
    try {
      await updateVehicle.mutateAsync({
        id: vehicle.id,
        ...data,
        contract_id: data.contract_id || null,
        brand: data.brand || null,
        model: data.model || null,
        color: data.color || null,
        notes: data.notes || null,
      });
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to update vehicle:", error);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteVehicle.mutateAsync(vehicle.id);
      setShowDeleteDialog(false);
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to delete vehicle:", error);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Chỉnh sửa phương tiện</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="tenant_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Khách thuê *</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {tenants.map((tenant) => (
                              <SelectItem key={tenant.id} value={tenant.id}>
                                {tenant.full_name} {tenant.phone && `(${tenant.phone})`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="contract_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Hợp đồng</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn hợp đồng" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {tenantContracts.length === 0 ? (
                              <SelectItem value="none" disabled>
                                Không có hợp đồng
                              </SelectItem>
                            ) : (
                              tenantContracts.map((contract) => (
                                <SelectItem key={contract.id} value={contract.id}>
                                  {contract.contract_number} - {contract.room?.name}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="vehicle_type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Loại xe *</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="MOTORBIKE">🏍️ Xe máy</SelectItem>
                            <SelectItem value="CAR">🚗 Ô tô</SelectItem>
                            <SelectItem value="BICYCLE">🚲 Xe đạp</SelectItem>
                            <SelectItem value="ELECTRIC_BIKE">⚡ Xe điện</SelectItem>
                            <SelectItem value="OTHER">🚛 Khác</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="license_plate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Biển số xe *</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="brand"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Hãng xe</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Model</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="color"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Màu sắc</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="parking_fee"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phí gửi xe (VNĐ/tháng) *</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          {...field}
                          onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ghi chú</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-between gap-3 pt-4">
                  <Button type="button" variant="destructive" onClick={() => setShowDeleteDialog(true)}>
                    Xóa
                  </Button>
                  <div className="flex gap-3">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                      Hủy
                    </Button>
                    <Button type="submit" disabled={updateVehicle.isPending}>
                      {updateVehicle.isPending ? "Đang lưu..." : "Lưu"}
                    </Button>
                  </div>
                </div>
              </form>
            </Form>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xóa</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn xóa phương tiện <strong>{vehicle.license_plate}</strong>?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Xóa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
