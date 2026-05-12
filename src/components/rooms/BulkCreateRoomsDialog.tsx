import { useState } from "react";
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
import { CurrencyInput } from "@/components/ui/currency-input";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useBulkCreateRooms } from "@/hooks/useRooms";
import { useBuildings } from "@/hooks/useBuildings";
import { Card, CardContent } from "@/components/ui/card";

const bulkRoomSchema = z.object({
  building_id: z.string().min(1, "Tòa nhà là bắt buộc"),
  start_floor: z.string().min(0, "Tầng bắt đầu không hợp lệ"),
  end_floor: z.string().min(0, "Tầng kết thúc không hợp lệ"),
  rooms_per_floor: z.string().min(1, "Số căn hộ/tầng là bắt buộc"),
  name_pattern: z.string().min(1, "Mẫu tên là bắt buộc"),
  rent_price: z.string().min(1, "Giá thuê là bắt buộc"),
  deposit_amount: z.string().min(1, "Tiền cọc là bắt buộc"),
  area: z.string().optional(),
  max_occupants: z.string().optional(),
});

type BulkRoomFormValues = z.infer<typeof bulkRoomSchema>;

interface BulkCreateRoomsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BulkCreateRoomsDialog({ open, onOpenChange }: BulkCreateRoomsDialogProps) {
  const bulkCreateRooms = useBulkCreateRooms();
  const { data: buildings } = useBuildings();
  const [preview, setPreview] = useState<string[]>([]);

  const form = useForm<BulkRoomFormValues>({
    resolver: zodResolver(bulkRoomSchema),
    defaultValues: {
      building_id: "",
      start_floor: "1",
      end_floor: "5",
      rooms_per_floor: "10",
      name_pattern: "{floor}{room}",
      rent_price: "",
      deposit_amount: "",
      area: "",
      max_occupants: "2",
    },
  });

  const generatePreview = (data: BulkRoomFormValues) => {
    const startFloor = parseInt(data.start_floor);
    const endFloor = parseInt(data.end_floor);
    const roomsPerFloor = parseInt(data.rooms_per_floor);
    const pattern = data.name_pattern;

    const roomNames: string[] = [];

    for (let floor = startFloor; floor <= endFloor; floor++) {
      for (let room = 1; room <= roomsPerFloor; room++) {
        const roomNum = room.toString().padStart(2, "0");
        const floorStr = floor.toString();
        
        let name = pattern
          .replace("{floor}", floorStr)
          .replace("{room}", roomNum);
        
        roomNames.push(name);
      }
    }

    return roomNames;
  };

  const handlePreview = () => {
    const data = form.getValues();
    const names = generatePreview(data);
    setPreview(names);
  };

  const onSubmit = async (data: BulkRoomFormValues) => {
    const startFloor = parseInt(data.start_floor);
    const endFloor = parseInt(data.end_floor);
    const roomsPerFloor = parseInt(data.rooms_per_floor);
    const pattern = data.name_pattern;
    const rentPrice = parseFloat(data.rent_price);
    const depositAmount = parseFloat(data.deposit_amount);
    const area = data.area ? parseFloat(data.area) : null;
    const maxOccupants = data.max_occupants ? parseInt(data.max_occupants) : null;

    const rooms = [];

    for (let floor = startFloor; floor <= endFloor; floor++) {
      for (let room = 1; room <= roomsPerFloor; room++) {
        const roomNum = room.toString().padStart(2, "0");
        const floorStr = floor.toString();
        
        let name = pattern
          .replace("{floor}", floorStr)
          .replace("{room}", roomNum);

        rooms.push({
          building_id: data.building_id,
          name,
          floor,
          rent_price: rentPrice,
          deposit_amount: depositAmount,
          area,
          max_occupants: maxOccupants,
          status: "AVAILABLE" as const,
        });
      }
    }

    try {
      await bulkCreateRooms.mutateAsync(rooms);
      form.reset();
      setPreview([]);
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Tạo căn hộ hàng loạt</DialogTitle>
          <DialogDescription>
            Tạo nhiều căn hộ cùng lúc với cấu hình tương tự
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)] pr-4">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Building Selection */}
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

              {/* Floor Range */}
              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="start_floor"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tầng bắt đầu *</FormLabel>
                      <FormControl>
                        <NumberInput
                          min={0}
                          value={field.value ? parseInt(field.value, 10) : null}
                          onChange={(v) => field.onChange(v ? String(v) : "")}
                          onBlur={field.onBlur}
                          name={field.name}
                          placeholder="1"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="end_floor"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tầng kết thúc *</FormLabel>
                      <FormControl>
                        <NumberInput
                          min={0}
                          value={field.value ? parseInt(field.value, 10) : null}
                          onChange={(v) => field.onChange(v ? String(v) : "")}
                          onBlur={field.onBlur}
                          name={field.name}
                          placeholder="5"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="rooms_per_floor"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số căn hộ/tầng *</FormLabel>
                      <FormControl>
                        <NumberInput
                          min={1}
                          value={field.value ? parseInt(field.value, 10) : null}
                          onChange={(v) => field.onChange(v ? String(v) : "")}
                          onBlur={field.onBlur}
                          name={field.name}
                          placeholder="10"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Naming Pattern */}
              <FormField
                control={form.control}
                name="name_pattern"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mẫu tên căn hộ *</FormLabel>
                    <FormControl>
                      <Input placeholder="{floor}{room}" {...field} />
                    </FormControl>
                    <FormDescription>
                      Sử dụng {"{floor}"} cho số tầng và {"{room}"} cho số căn hộ.
                      Ví dụ: {"{floor}{room}"} → 101, 102... hoặc P{"{floor}"}.{"{room}"} → P1.01
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Default Pricing */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="rent_price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Giá thuê mặc định (VNĐ/tháng) *</FormLabel>
                      <FormControl>
                        <CurrencyInput
                          value={field.value ? parseFloat(field.value) : null}
                          onChange={(v) => field.onChange(v ? String(v) : "")}
                          onBlur={field.onBlur}
                          name={field.name}
                          placeholder="3000000"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="deposit_amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tiền cọc mặc định (VNĐ) *</FormLabel>
                      <FormControl>
                        <CurrencyInput
                          value={field.value ? parseFloat(field.value) : null}
                          onChange={(v) => field.onChange(v ? String(v) : "")}
                          onBlur={field.onBlur}
                          name={field.name}
                          placeholder="6000000"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Additional Info */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="area"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Diện tích mặc định (m²)</FormLabel>
                      <FormControl>
                        <NumberInput
                          allowDecimal
                          min={0}
                          value={field.value ? parseFloat(field.value) : null}
                          onChange={(v) => field.onChange(v ? String(v) : "")}
                          onBlur={field.onBlur}
                          name={field.name}
                          placeholder="25"
                        />
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
                        <NumberInput
                          min={1}
                          value={field.value ? parseInt(field.value, 10) : null}
                          onChange={(v) => field.onChange(v ? String(v) : "")}
                          onBlur={field.onBlur}
                          name={field.name}
                          placeholder="2"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Preview Button */}
              <div className="pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handlePreview}
                  className="w-full"
                >
                  Xem trước danh sách căn hộ
                </Button>
              </div>

              {/* Preview */}
              {preview.length > 0 && (
                <Card>
                  <CardContent className="pt-6">
                    <h4 className="font-semibold mb-2">
                      Danh sách căn hộ sẽ tạo ({preview.length} căn hộ):
                    </h4>
                    <ScrollArea className="h-40 rounded border p-2">
                      <div className="grid grid-cols-5 gap-2">
                        {preview.map((name, idx) => (
                          <div key={idx} className="text-sm bg-muted px-2 py-1 rounded">
                            {name}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>
              )}

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Hủy
                </Button>
                <Button type="submit" disabled={bulkCreateRooms.isPending || preview.length === 0}>
                  {bulkCreateRooms.isPending ? "Đang tạo..." : `Tạo ${preview.length} căn hộ`}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
