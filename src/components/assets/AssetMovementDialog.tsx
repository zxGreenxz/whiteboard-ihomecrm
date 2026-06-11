import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useCreateAssetMovement } from "@/hooks/useAssets";
import { useAssets } from "@/hooks/useAssets";
import { useRooms } from "@/hooks/useRooms";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";

const movementSchema = z.object({
  asset_id: z.string().min(1, "Phải chọn tài sản"),
  from_room_id: z.string().optional(),
  to_room_id: z.string().min(1, "Phải chọn căn hộ đích"),
  quantity: z.number().min(1, "Số lượng phải >= 1"),
  movement_date: z.string().min(1, "Ngày di chuyển là bắt buộc"),
  reason: z.string().optional(),
});

type MovementFormValues = z.infer<typeof movementSchema>;

interface AssetMovementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssetMovementDialog({ open, onOpenChange }: AssetMovementDialogProps) {
  const createMovement = useCreateAssetMovement();
  const { data: assets = [] } = useAssets();
  const { data: rooms = [] } = useRooms();

  const form = useForm<MovementFormValues>({
    resolver: zodResolver(movementSchema),
    defaultValues: {
      asset_id: "",
      from_room_id: undefined,
      to_room_id: "",
      quantity: 1,
      movement_date: new Date().toISOString().split('T')[0],
      reason: "",
    },
  });

  const selectedAssetId = form.watch("asset_id");
  const selectedAsset = assets.find(a => a.id === selectedAssetId);

  const onSubmit = async (data: MovementFormValues) => {
    try {
      const user = await getSessionUser();
      if (!user) throw new Error('Not authenticated');

      await createMovement.mutateAsync({
        asset_id: data.asset_id,
        from_room_id: data.from_room_id || null,
        to_room_id: data.to_room_id,
        quantity: data.quantity,
        movement_date: data.movement_date,
        from_location: selectedAsset?.room?.name || null,
        to_location: rooms.find(r => r.id === data.to_room_id)?.name || null,
        reason: data.reason || null,
        user_id: user.id,
      });
      form.reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create movement:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Di chuyển tài sản</DialogTitle>
          <DialogDescription>Ghi nhận di chuyển tài sản giữa các căn hộ</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="asset_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tài sản *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn tài sản" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {assets.map((asset) => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {asset.code ? `[${asset.code}] ` : ""}{asset.name}
                          {asset.room && ` - ${asset.room.name}`}
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
                name="from_room_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Từ căn hộ</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={selectedAsset?.room?.name || "Kho/Khác"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {rooms.map((room) => (
                          <SelectItem key={room.id} value={room.id}>
                            {room.building?.name} - {room.name}
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
                name="to_room_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Đến căn hộ *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn căn hộ" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {rooms.map((room) => (
                          <SelectItem key={room.id} value={room.id}>
                            {room.building?.name} - {room.name}
                          </SelectItem>
                        ))}
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
                name="quantity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số lượng *</FormLabel>
                    <FormControl>
                      <NumberInput
                        min={1}
                        value={field.value}
                        onChange={(v) => field.onChange(v || 1)}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="movement_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày di chuyển *</FormLabel>
                    <FormControl>
                      <DateInput
                        value={field.value || ''}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lý do</FormLabel>
                  <FormControl>
                    <Textarea {...field} placeholder="Lý do di chuyển..." className="min-h-[60px]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Hủy
              </Button>
              <Button type="submit" disabled={createMovement.isPending}>
                {createMovement.isPending ? "Đang ghi nhận..." : "Ghi nhận di chuyển"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
