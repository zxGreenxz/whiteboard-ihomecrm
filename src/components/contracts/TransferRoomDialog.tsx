import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

import { transferRoomFormSchema } from "@/lib/contractValidation";
import type { TransferRoomFormData } from "@/lib/contractValidation";
import type { ContractWithRelations } from "@/types/contract";
import { useTransferRoom } from "@/hooks/useContractOperations";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { todayISO } from '@/lib/collect';

interface TransferRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contract: ContractWithRelations;
}

export function TransferRoomDialog({
  open,
  onOpenChange,
  contract,
}: TransferRoomDialogProps) {
  const transferRoom = useTransferRoom();

  // Data for cascading dropdowns
  const { data: buildingsData } = useBuildings();
  const buildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []),
    [buildingsData]
  );

  const { data: roomsData } = useRooms();
  const allRooms = useMemo(
    () => (Array.isArray(roomsData) ? roomsData : []),
    [roomsData]
  );

  const form = useForm<TransferRoomFormData>({
    resolver: zodResolver(transferRoomFormSchema),
    defaultValues: {
      new_room_id: "",
      new_rent_price: undefined,
      transfer_date: todayISO(),
      notes: "",
    },
  });

  // Local state for building selection (not part of form schema)
  const selectedBuildingId = form.watch("_building_id" as any) as string | undefined;

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      form.reset({
        new_room_id: "",
        new_rent_price: undefined,
        transfer_date: todayISO(),
        notes: "",
      });
      // Clear building selection
      form.setValue("_building_id" as any, "");
    }
  }, [open, contract, form]);

  // Cascading: filter rooms by selected building, only AVAILABLE
  const availableRooms = useMemo(() => {
    if (!selectedBuildingId) return [];
    return allRooms.filter(
      (r: any) => r.building_id === selectedBuildingId && r.status === "AVAILABLE"
    );
  }, [allRooms, selectedBuildingId]);

  // Reset room when building changes
  const handleBuildingChange = (buildingId: string) => {
    form.setValue("_building_id" as any, buildingId);
    form.setValue("new_room_id", "");
  };

  const handleRoomChange = (roomId: string) => {
    form.setValue("new_room_id", roomId);
    form.trigger("new_room_id");
  };

  const onSubmit = (data: TransferRoomFormData) => {
    transferRoom.mutate(
      {
        contractId: contract.id,
        newRoomId: data.new_room_id,
        newRentPrice: data.new_rent_price,
        transferDate: data.transfer_date,
        notes: data.notes,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      }
    );
  };

  // Current contract info for display
  const currentBuilding = contract.room?.building?.name || "—";
  const currentRoom = contract.room?.name || "—";
  const representativeCustomer = contract.contract_customers?.find(
    (cc) => cc.is_representative
  );
  const currentCustomer = representativeCustomer?.customer?.full_name || "—";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Chuyển phòng</DialogTitle>
        </DialogHeader>

        {/* Current contract info */}
        <div className="rounded-md border p-3 bg-muted/50 space-y-1 text-sm">
          <p>
            <span className="font-medium">Khách hàng:</span> {currentCustomer}
          </p>
          <p>
            <span className="font-medium">Toà nhà:</span> {currentBuilding}
          </p>
          <p>
            <span className="font-medium">Phòng:</span> {currentRoom}
          </p>
          <p>
            <span className="font-medium">Giá thuê hiện tại:</span>{" "}
            {contract.rent_price?.toLocaleString("vi-VN")} đ
          </p>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* New building (cascading trigger, not in schema) */}
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Toà nhà mới <span className="text-red-500">*</span>
              </label>
              <Select
                value={selectedBuildingId || ""}
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

            {/* New room (AVAILABLE only) */}
            <FormField
              control={form.control}
              name="new_room_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Phòng mới <span className="text-red-500">*</span>
                  </FormLabel>
                  <Select
                    value={field.value || ""}
                    onValueChange={handleRoomChange}
                    disabled={!selectedBuildingId}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={
                          !selectedBuildingId
                            ? "Chọn toà nhà trước"
                            : availableRooms.length === 0
                            ? "Không có phòng trống"
                            : "Chọn phòng"
                        } />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {availableRooms.map((r: any) => (
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

            {/* New rent price */}
            <FormField
              control={form.control}
              name="new_rent_price"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Giá thuê mới</FormLabel>
                  <FormControl>
                    <CurrencyInput
                      placeholder="Giữ nguyên nếu không thay đổi"
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

            {/* Transfer date */}
            <FormField
              control={form.control}
              name="transfer_date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Ngày chuyển <span className="text-red-500">*</span>
                  </FormLabel>
                  <FormControl>
                    <DateInput
                      value={field.value || ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Ghi chú chuyển phòng..."
                      rows={3}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button type="submit" disabled={transferRoom.isPending}>
                {transferRoom.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Chuyển phòng
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
