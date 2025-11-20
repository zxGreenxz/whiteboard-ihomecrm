import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUpdateDeposit, useDeleteDeposit, type DepositWithRelations } from "@/hooks/useDeposits";
import { useTenants } from "@/hooks/useTenants";
import { useRooms } from "@/hooks/useRooms";
import { useBeds } from "@/hooks/useBeds";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useState } from "react";

const depositSchema = z.object({
  tenant_id: z.string().min(1, "Phải chọn khách thuê"),
  room_id: z.string().min(1, "Phải chọn phòng"),
  bed_id: z.string().optional(),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  deposit_date: z.string().min(1, "Ngày đặt cọc là bắt buộc"),
  hold_until_date: z.string().min(1, "Ngày giữ phòng là bắt buộc"),
  status: z.enum(["PENDING", "CONFIRMED", "CONVERTED", "REFUNDED", "FORFEITED"]),
  notes: z.string().optional(),
});

type DepositFormValues = z.infer<typeof depositSchema>;

interface EditDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deposit: DepositWithRelations;
}

export function EditDepositDialog({ open, onOpenChange, deposit }: EditDepositDialogProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const updateDeposit = useUpdateDeposit();
  const deleteDeposit = useDeleteDeposit();
  const { data: tenants = [] } = useTenants();
  const { data: rooms = [] } = useRooms();
  const { data: beds = [] } = useBeds();

  const form = useForm<DepositFormValues>({
    resolver: zodResolver(depositSchema),
    defaultValues: {
      tenant_id: "",
      room_id: "",
      bed_id: undefined,
      amount: 0,
      deposit_date: "",
      hold_until_date: "",
      status: "PENDING",
      notes: "",
    },
  });

  useEffect(() => {
    if (deposit) {
      form.reset({
        tenant_id: deposit.tenant_id || "",
        room_id: deposit.room_id || "",
        bed_id: deposit.bed_id || undefined,
        amount: deposit.amount || 0,
        deposit_date: deposit.deposit_date || "",
        hold_until_date: deposit.hold_until_date || "",
        status: deposit.status || "PENDING",
        notes: deposit.notes || "",
      });
    }
  }, [deposit, form]);

  const onSubmit = async (data: DepositFormValues) => {
    try {
      await updateDeposit.mutateAsync({
        id: deposit.id,
        ...data,
        bed_id: data.bed_id || null,
        notes: data.notes || null,
      });
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to update deposit:", error);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteDeposit.mutateAsync(deposit.id);
      setShowDeleteDialog(false);
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to delete deposit:", error);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Chỉnh sửa phiếu đặt cọc</DialogTitle>
            <DialogDescription>
              Cập nhật thông tin phiếu đặt cọc
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="tenant_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Khách thuê *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn khách thuê" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {tenants.map((tenant) => (
                            <SelectItem key={tenant.id} value={tenant.id}>
                              {tenant.full_name} - {tenant.phone}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="room_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phòng *</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn phòng" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {rooms.map((room) => (
                              <SelectItem key={room.id} value={room.id}>
                                {room.name} {room.code && `(${room.code})`}
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
                    name="bed_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Giường (nếu có)</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn giường" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {beds.map((bed) => (
                              <SelectItem key={bed.id} value={bed.id}>
                                {bed.name} {bed.code && `(${bed.code})`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số tiền cọc *</FormLabel>
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
                    name="deposit_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Ngày đặt cọc *</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="hold_until_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Giữ phòng đến *</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Trạng thái *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn trạng thái" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="PENDING">Chờ xác nhận</SelectItem>
                          <SelectItem value="CONFIRMED">Đã xác nhận</SelectItem>
                          <SelectItem value="CONVERTED">Đã chuyển HĐ</SelectItem>
                          <SelectItem value="REFUNDED">Đã hoàn trả</SelectItem>
                          <SelectItem value="FORFEITED">Mất cọc</SelectItem>
                        </SelectContent>
                      </Select>
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
                        <Textarea {...field} className="min-h-[60px]" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-between gap-3 pt-4">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setShowDeleteDialog(true)}
                  >
                    Xóa
                  </Button>
                  <div className="flex gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => onOpenChange(false)}
                    >
                      Hủy
                    </Button>
                    <Button type="submit" disabled={updateDeposit.isPending}>
                      {updateDeposit.isPending ? "Đang lưu..." : "Lưu thay đổi"}
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
              Bạn có chắc chắn muốn xóa phiếu đặt cọc này? Hành động này không thể hoàn tác.
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
