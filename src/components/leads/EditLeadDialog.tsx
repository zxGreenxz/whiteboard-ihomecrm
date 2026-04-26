import { useEffect, useState } from "react";
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
import { useUpdateLead, useDeleteLead, type LeadWithRelations } from "@/hooks/useLeads";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
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

const leadSchema = z.object({
  customer_name: z.string().min(1, "Tên khách hàng là bắt buộc"),
  phone: z.string().min(1, "Số điện thoại là bắt buộc"),
  email: z.string().email("Email không hợp lệ").optional().or(z.literal("")),
  source: z.enum(["FACEBOOK", "ZALO", "PHONE", "REFERRAL", "WALK_IN", "WEBSITE", "OTHER"]),
  building_id: z.string().optional(),
  room_id: z.string().optional(),
  appointment_date: z.string().optional(),
  assigned_staff_id: z.string().optional(),
  status: z.enum(["B1_LEAD", "B2_APPOINTMENT", "B3_CONSULTATION", "CONVERTED", "FAILED"]),
  referrer_name: z.string().optional(),
  ctv_name: z.string().optional(),
  finder_name: z.string().optional(),
  notes: z.string().optional(),
});

type LeadFormValues = z.infer<typeof leadSchema>;

interface EditLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadWithRelations;
}

export function EditLeadDialog({ open, onOpenChange, lead }: EditLeadDialogProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const updateLead = useUpdateLead();
  const deleteLead = useDeleteLead();
  const { data: buildings = [] } = useBuildings();
  const { data: rooms = [] } = useRooms();

  const form = useForm<LeadFormValues>({
    resolver: zodResolver(leadSchema),
    defaultValues: {
      customer_name: "",
      phone: "",
      email: "",
      source: "PHONE",
      building_id: undefined,
      room_id: undefined,
      appointment_date: "",
      assigned_staff_id: undefined,
      status: "B1_LEAD",
      referrer_name: "",
      ctv_name: "",
      finder_name: "",
      notes: "",
    },
  });

  const selectedBuildingId = form.watch("building_id");
  const filteredRooms = selectedBuildingId
    ? rooms.filter((r: any) => r.building_id === selectedBuildingId)
    : rooms;

  useEffect(() => {
    if (lead) {
      form.reset({
        customer_name: lead.customer_name || "",
        phone: lead.phone || "",
        email: lead.email || "",
        source: (lead.source as any) || "PHONE",
        building_id: lead.building_id || undefined,
        room_id: lead.room_id || undefined,
        appointment_date: lead.appointment_date || "",
        assigned_staff_id: lead.assigned_staff_id || undefined,
        status: (lead.status as any) || "B1_LEAD",
        referrer_name: (lead as any).referrer_name || "",
        ctv_name: (lead as any).ctv_name || "",
        finder_name: (lead as any).finder_name || "",
        notes: lead.notes || "",
      });
    }
  }, [lead, form]);

  const onSubmit = async (data: LeadFormValues) => {
    try {
      await updateLead.mutateAsync({
        id: lead.id,
        ...data,
        email: data.email || null,
        building_id: data.building_id || null,
        room_id: data.room_id || null,
        appointment_date: data.appointment_date || null,
        assigned_staff_id: data.assigned_staff_id || null,
        referrer_name: data.referrer_name || null,
        ctv_name: data.ctv_name || null,
        finder_name: data.finder_name || null,
        notes: data.notes || null,
      } as any);
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to update lead:", error);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteLead.mutateAsync(lead.id);
      setShowDeleteDialog(false);
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to delete lead:", error);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Chỉnh sửa khách hẹn</DialogTitle>
            <DialogDescription>
              Cập nhật thông tin khách hẹn
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                {/* Tên & SĐT */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="customer_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tên *</FormLabel>
                        <FormControl>
                          <Input placeholder="Nguyễn Văn A" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>SĐT *</FormLabel>
                        <FormControl>
                          <Input placeholder="0912345678" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Email */}
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="example@email.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Nguồn & Trạng thái */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="source"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nguồn *</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn nguồn" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="FACEBOOK">Facebook</SelectItem>
                            <SelectItem value="ZALO">Zalo</SelectItem>
                            <SelectItem value="PHONE">Điện thoại</SelectItem>
                            <SelectItem value="REFERRAL">Giới thiệu</SelectItem>
                            <SelectItem value="WALK_IN">Khách đến trực tiếp</SelectItem>
                            <SelectItem value="WEBSITE">Website</SelectItem>
                            <SelectItem value="OTHER">Khác</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

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
                            <SelectItem value="B1_LEAD">Mới</SelectItem>
                            <SelectItem value="B2_APPOINTMENT">Đã hẹn</SelectItem>
                            <SelectItem value="B3_CONSULTATION">Đang tư vấn</SelectItem>
                            <SelectItem value="CONVERTED">Đã chuyển đổi</SelectItem>
                            <SelectItem value="FAILED">Thất bại</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Toà nhà & Căn hộ quan tâm */}
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="building_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Toà nhà</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn toà nhà" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {buildings.map((building) => (
                              <SelectItem key={building.id} value={building.id}>
                                {building.name}
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
                    name="room_id"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Căn hộ quan tâm</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn căn hộ" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {filteredRooms.map((room) => (
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
                </div>

                {/* Thời gian hẹn */}
                <FormField
                  control={form.control}
                  name="appointment_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Thời gian hẹn</FormLabel>
                      <FormControl>
                        <Input type="datetime-local" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Người giới thiệu / CTV / Người tìm khách */}
                <div className="grid grid-cols-3 gap-3">
                  <FormField
                    control={form.control}
                    name="referrer_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Người giới thiệu</FormLabel>
                        <FormControl>
                          <Input placeholder="Tên" {...field} value={field.value ?? ""} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="ctv_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>CTV</FormLabel>
                        <FormControl>
                          <Input placeholder="Cộng tác viên" {...field} value={field.value ?? ""} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="finder_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Người tìm khách</FormLabel>
                        <FormControl>
                          <Input placeholder="Sale" {...field} value={field.value ?? ""} />
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
                          placeholder="Ghi chú về khách hẹn..."
                          className="min-h-[80px]"
                          {...field}
                        />
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
                    <Button type="submit" disabled={updateLead.isPending}>
                      {updateLead.isPending ? "Đang lưu..." : "Lưu thay đổi"}
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
              Bạn có chắc chắn muốn xóa khách hẹn này? Hành động này không thể hoàn tác.
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
