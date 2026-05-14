import { useEffect, useMemo, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useAssignBuildingsToArea, useUpdateArea } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import type { Database } from "@/integrations/supabase/types";

type Area = Database["public"]["Tables"]["areas"]["Row"];

const areaSchema = z.object({
  name: z.string().min(1, "Tên khu vực là bắt buộc"),
  code: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

type AreaFormValues = z.infer<typeof areaSchema>;

interface EditAreaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  area: Area;
}

export function EditAreaDialog({ open, onOpenChange, area }: EditAreaDialogProps) {
  const updateArea = useUpdateArea();
  const assignBuildings = useAssignBuildingsToArea();
  const { data: buildings = [] } = useBuildings();

  const form = useForm<AreaFormValues>({
    resolver: zodResolver(areaSchema),
    defaultValues: {
      name: area.name,
      code: area.code || "",
      description: area.description || "",
      status: area.status as "ACTIVE" | "INACTIVE",
    },
  });

  const [selectedBuildingIds, setSelectedBuildingIds] = useState<Set<string>>(
    new Set(),
  );

  const initialBuildingIds = useMemo(
    () =>
      new Set(
        buildings.filter((b) => b.area_id === area.id).map((b) => b.id),
      ),
    [buildings, area.id],
  );

  useEffect(() => {
    if (open && area) {
      form.reset({
        name: area.name,
        code: area.code || "",
        description: area.description || "",
        status: area.status as "ACTIVE" | "INACTIVE",
      });
      setSelectedBuildingIds(new Set(initialBuildingIds));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, area, initialBuildingIds]);

  const toggleBuilding = (id: string, checked: boolean) => {
    setSelectedBuildingIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onSubmit = async (data: AreaFormValues) => {
    try {
      await updateArea.mutateAsync({
        id: area.id,
        updates: {
          name: data.name,
          code: data.code || null,
          description: data.description || null,
          status: data.status,
        },
      });

      const toAddIds = Array.from(selectedBuildingIds).filter(
        (id) => !initialBuildingIds.has(id),
      );
      const toRemoveIds = Array.from(initialBuildingIds).filter(
        (id) => !selectedBuildingIds.has(id),
      );
      if (toAddIds.length > 0 || toRemoveIds.length > 0) {
        await assignBuildings.mutateAsync({
          areaId: area.id,
          toAddIds,
          toRemoveIds,
        });
      }

      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const isPending = updateArea.isPending || assignBuildings.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa Khu vực</DialogTitle>
          <DialogDescription>
            Cập nhật thông tin khu vực
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên khu vực *</FormLabel>
                  <FormControl>
                    <Input placeholder="Ví dụ: Khu vực Quận 1" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mã khu vực</FormLabel>
                    <FormControl>
                      <Input placeholder="KV-01" {...field} />
                    </FormControl>
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
                        <SelectItem value="ACTIVE">Hoạt động</SelectItem>
                        <SelectItem value="INACTIVE">Không hoạt động</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-2">
              <Label>Tòa nhà sử dụng *</Label>
              <div className="max-h-48 overflow-y-auto rounded-md border p-2 space-y-1">
                {buildings.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2 text-center">
                    Chưa có tòa nhà nào
                  </p>
                ) : (
                  buildings.map((b) => {
                    const checked = selectedBuildingIds.has(b.id);
                    const inOtherArea =
                      !!b.area_id && b.area_id !== area.id;
                    return (
                      <label
                        key={b.id}
                        className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/50 cursor-pointer text-sm"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) =>
                            toggleBuilding(b.id, v === true)
                          }
                        />
                        <span className="flex-1">{b.name}</span>
                        {inOtherArea && b.area && (
                          <span className="text-xs text-muted-foreground">
                            (đang thuộc {b.area.name})
                          </span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Mô tả chi tiết về khu vực..."
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
              <Button type="submit" disabled={isPending}>
                {isPending ? "Đang cập nhật..." : "Cập nhật"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
