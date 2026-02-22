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
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";

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
  notes: z.string().optional(),
});

type LeadFormValues = z.infer<typeof leadSchema>;

interface CreateLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateLeadDialog({ open, onOpenChange }: CreateLeadDialogProps) {
  const createLead = useCreateLead();
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
      notes: "",
    },
  });

  const selectedBuildingId = form.watch("building_id");
  const filteredRooms = selectedBuildingId
    ? rooms.filter((r: any) => r.building_id === selectedBuildingId)
    : rooms;

  const onSubmit = async (data: LeadFormValues) => {
    try {
      await createLead.mutateAsync({
        ...data,
        email: data.email || null,
        building_id: data.building_id || null,
        room_id: data.room_id || null,
        appointment_date: data.appointment_date || null,
        assigned_staff_id: data.assigned_staff_id || null,
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
            Nhập thông tin khách hẹn xem căn hộ
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
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
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
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
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
