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
  FormDescription,
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
import { useCreateRoom } from "@/hooks/useRooms";
import { useBuildings } from "@/hooks/useBuildings";

const roomSchema = z.object({
  building_id: z.string().min(1, "Tòa nhà là bắt buộc"),
  name: z.string().min(1, "Tên phòng là bắt buộc"),
  code: z.string().optional(),
  floor: z.string().min(0, "Tầng không hợp lệ"),
  area: z.string().optional(),
  rent_price: z.string().min(1, "Giá thuê là bắt buộc"),
  deposit_amount: z.string().min(1, "Tiền cọc là bắt buộc"),
  max_occupants: z.string().optional(),
  status: z.enum(["AVAILABLE", "OCCUPIED", "RESERVED", "MAINTENANCE", "UNAVAILABLE"]).default("AVAILABLE"),
  description: z.string().optional(),
});

type RoomFormValues = z.infer<typeof roomSchema>;

interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateRoomDialog({ open, onOpenChange }: CreateRoomDialogProps) {
  const createRoom = useCreateRoom();
  const { data: buildings } = useBuildings();

  const form = useForm<RoomFormValues>({
    resolver: zodResolver(roomSchema),
    defaultValues: {
      building_id: "",
      name: "",
      code: "",
      floor: "0",
      area: "",
      rent_price: "",
      deposit_amount: "",
      max_occupants: "",
      status: "AVAILABLE",
      description: "",
    },
  });

  const onSubmit = async (data: RoomFormValues) => {
    try {
      await createRoom.mutateAsync({
        building_id: data.building_id,
        name: data.name,
        code: data.code || null,
        floor: parseInt(data.floor),
        area: data.area ? parseFloat(data.area) : null,
        rent_price: parseFloat(data.rent_price),
        deposit_amount: parseFloat(data.deposit_amount),
        max_occupants: data.max_occupants ? parseInt(data.max_occupants) : null,
        status: data.status,
        description: data.description || null,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Tạo Phòng mới</DialogTitle>
          <DialogDescription>
            Nhập thông tin phòng để quản lý thuê và khách thuê
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Basic Info */}
              <div className="space-y-4">
                <h3 className="font-semibold text-sm">Thông tin cơ bản</h3>
                
                <FormField
                  control={form.control}
                  name="building_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tòa nhà *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn tòa nhà" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {buildings?.map((building) => (
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

                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tên phòng *</FormLabel>
                        <FormControl>
                          <Input placeholder="Ví dụ: P101" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mã phòng</FormLabel>
                        <FormControl>
                          <Input placeholder="R-101" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <FormField
                    control={form.control}
                    name="floor"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tầng *</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="1" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="area"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Diện tích (m²)</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.01" placeholder="25" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="max_occupants"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số người tối đa</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="2" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Pricing */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Giá thuê</h3>
                
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="rent_price"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Giá thuê (VNĐ/tháng) *</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="3000000" {...field} />
                        </FormControl>
                        <FormDescription>
                          Giá thuê hàng tháng
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="deposit_amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tiền cọc (VNĐ) *</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="6000000" {...field} />
                        </FormControl>
                        <FormDescription>
                          Tiền đặt cọc khi thuê
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Status & Description */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Trạng thái & Mô tả</h3>
                
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
                          <SelectItem value="AVAILABLE">Trống</SelectItem>
                          <SelectItem value="OCCUPIED">Đã thuê</SelectItem>
                          <SelectItem value="RESERVED">Đã đặt</SelectItem>
                          <SelectItem value="MAINTENANCE">Bảo trì</SelectItem>
                          <SelectItem value="UNAVAILABLE">Không khả dụng</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mô tả</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Mô tả chi tiết về phòng, tiện nghi..."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={createRoom.isPending}>
                  {createRoom.isPending ? "Đang tạo..." : "Tạo phòng"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
