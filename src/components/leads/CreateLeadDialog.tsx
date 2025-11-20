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
import { useCreateLead } from "@/hooks/useLeads";
import { useRooms } from "@/hooks/useRooms";
import { useBeds } from "@/hooks/useBeds";

const leadSchema = z.object({
  customer_name: z.string().min(1, "Tên khách hàng là bắt buộc"),
  phone: z.string().min(1, "Số điện thoại là bắt buộc"),
  email: z.string().email("Email không hợp lệ").optional().or(z.literal("")),
  source: z.enum(["WEBSITE", "FACEBOOK", "ZALO", "REFERRAL", "WALK_IN", "OTHER"]),
  room_id: z.string().optional(),
  bed_id: z.string().optional(),
  appointment_date: z.string().optional(),
  status: z.enum(["NEW", "CONTACTED", "VIEWED", "DEPOSITED", "FAILED"]),
  notes: z.string().optional(),
});

type LeadFormValues = z.infer<typeof leadSchema>;

interface CreateLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateLeadDialog({ open, onOpenChange }: CreateLeadDialogProps) {
  const createLead = useCreateLead();
  const { data: rooms = [] } = useRooms();
  const { data: beds = [] } = useBeds();

  const form = useForm<LeadFormValues>({
    resolver: zodResolver(leadSchema),
    defaultValues: {
      customer_name: "",
      phone: "",
      email: "",
      source: "WEBSITE",
      room_id: undefined,
      bed_id: undefined,
      appointment_date: "",
      status: "NEW",
      notes: "",
    },
  });

  const onSubmit = async (data: LeadFormValues) => {
    try {
      await createLead.mutateAsync({
        ...data,
        email: data.email || null,
        room_id: data.room_id || null,
        bed_id: data.bed_id || null,
        appointment_date: data.appointment_date || null,
        notes: data.notes || null,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create lead:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Tạo khách hẹn mới</DialogTitle>
          <DialogDescription>
            Nhập thông tin khách hàng tiềm năng
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Customer Info */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="customer_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên khách hàng *</FormLabel>
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
                      <FormLabel>Số điện thoại *</FormLabel>
                      <FormControl>
                        <Input placeholder="0912345678" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

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

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="source"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nguồn *</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn nguồn" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="WEBSITE">Website</SelectItem>
                          <SelectItem value="FACEBOOK">Facebook</SelectItem>
                          <SelectItem value="ZALO">Zalo</SelectItem>
                          <SelectItem value="REFERRAL">Giới thiệu</SelectItem>
                          <SelectItem value="WALK_IN">Khách đến trực tiếp</SelectItem>
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
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn trạng thái" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="NEW">Khách mới</SelectItem>
                          <SelectItem value="CONTACTED">Đã liên hệ</SelectItem>
                          <SelectItem value="VIEWED">Đã xem phòng</SelectItem>
                          <SelectItem value="DEPOSITED">Đã đặt cọc</SelectItem>
                          <SelectItem value="FAILED">Không thành công</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Property Interest */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="room_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phòng quan tâm</FormLabel>
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
                      <FormLabel>Giường quan tâm</FormLabel>
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

              <FormField
                control={form.control}
                name="appointment_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày hẹn</FormLabel>
                    <FormControl>
                      <Input type="datetime-local" {...field} />
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
                      <Textarea
                        placeholder="Ghi chú về khách hàng..."
                        className="min-h-[80px]"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={createLead.isPending}>
                  {createLead.isPending ? "Đang tạo..." : "Tạo khách hẹn"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
