import { useMemo } from "react";
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
import { useCreateBed } from "@/hooks/useBeds";
import { useRooms } from "@/hooks/useRooms";
import { useBuildings } from "@/hooks/useBuildings";

const bedSchema = z.object({
  room_id: z.string().min(1, "Phòng là bắt buộc"),
  name: z.string().min(1, "Tên giường là bắt buộc"),
  code: z.string().optional(),
  rent_price: z.string().min(1, "Giá thuê là bắt buộc"),
  deposit_amount: z.string().min(1, "Tiền cọc là bắt buộc"),
  status: z.enum(["AVAILABLE", "OCCUPIED", "RESERVED", "MAINTENANCE", "UNAVAILABLE"]).default("AVAILABLE"),
  description: z.string().optional(),
});

type BedFormValues = z.infer<typeof bedSchema>;

interface CreateBedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateBedDialog({ open, onOpenChange }: CreateBedDialogProps) {
  const createBed = useCreateBed();
  const { data: allRooms } = useRooms();
  const { data: buildings } = useBuildings();

  // Filter rooms to only show DORMITORY or SLEEPBOX types
  const dormitoryRooms = useMemo(() => {
    if (!allRooms || !buildings) return [];
    
    const dormitoryBuildingIds = new Set(
      buildings
        .filter(b => b.type === "DORMITORY" || b.type === "SLEEPBOX")
        .map(b => b.id)
    );
    
    return allRooms.filter(room => dormitoryBuildingIds.has(room.building_id));
  }, [allRooms, buildings]);

  const form = useForm<BedFormValues>({
    resolver: zodResolver(bedSchema),
    defaultValues: {
      room_id: "",
      name: "",
      code: "",
      rent_price: "",
      deposit_amount: "",
      status: "AVAILABLE",
      description: "",
    },
  });

  const onSubmit = async (data: BedFormValues) => {
    try {
      await createBed.mutateAsync({
        room_id: data.room_id,
        name: data.name,
        code: data.code || null,
        rent_price: parseFloat(data.rent_price),
        deposit_amount: parseFloat(data.deposit_amount),
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
          <DialogTitle>Tạo Giường mới</DialogTitle>
          <DialogDescription>
            Nhập thông tin giường cho ký túc xá hoặc sleepbox
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Room Selection */}
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
                        {dormitoryRooms?.map((room) => (
                          <SelectItem key={room.id} value={room.id}>
                            {room.name} {room.building?.name && `- ${room.building.name}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Chỉ hiển thị phòng từ Ký túc xá và Sleepbox
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Basic Info */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên giường *</FormLabel>
                      <FormControl>
                        <Input placeholder="Ví dụ: Giường A1" {...field} />
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
                      <FormLabel>Mã giường</FormLabel>
                      <FormControl>
                        <Input placeholder="B-A1" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Pricing */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="rent_price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Giá thuê (VNĐ/tháng) *</FormLabel>
                      <FormControl>
                        <Input type="number" placeholder="1500000" {...field} />
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
                        <Input type="number" placeholder="3000000" {...field} />
                      </FormControl>
                      <FormDescription>
                        Tiền đặt cọc khi thuê
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Status & Description */}
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
                        placeholder="Mô tả chi tiết về giường..."
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
                <Button type="submit" disabled={createBed.isPending}>
                  {createBed.isPending ? "Đang tạo..." : "Tạo giường"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
