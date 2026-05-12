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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
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
import { useUpdateBuilding } from "@/hooks/useBuildings";
import { useAreas } from "@/hooks/useAreas";
import type { Database } from "@/integrations/supabase/types";
import { CommissionTiersField } from "./CommissionTiersField";
import { DEFAULT_COMMISSION_TIERS, type CommissionTier } from "@/types/building";

type Building = Database["public"]["Tables"]["buildings"]["Row"];

const commissionTierSchema = z.object({
  min_months: z.number().min(0),
  max_months: z.number().min(0),
  rate_percent: z.number().min(0).max(100),
}).refine((d) => d.min_months <= d.max_months, {
  message: "Tháng bắt đầu phải <= tháng kết thúc",
});

const buildingSchema = z.object({
  area_id: z.string().optional(),
  name: z.string().min(1, "Tên tòa nhà là bắt buộc"),
  code: z.string().optional(),
  type: z.enum(["APARTMENT", "DORMITORY", "HOUSE", "OFFICE", "SLEEPBOX", "HOMESTAY"]),
  status: z.enum(["ACTIVE", "INACTIVE", "MAINTENANCE"]),
  province: z.string().min(1, "Tỉnh/Thành phố là bắt buộc"),
  district: z.string().min(1, "Quận/Huyện là bắt buộc"),
  ward: z.string().min(1, "Phường/Xã là bắt buộc"),
  street_address: z.string().optional(),
  total_floors: z.string().optional(),
  description: z.string().optional(),
  commission_tiers: z.array(commissionTierSchema).default(DEFAULT_COMMISSION_TIERS),
});

type BuildingFormValues = z.infer<typeof buildingSchema>;

interface EditBuildingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  building: Building;
}

export function EditBuildingDialog({
  open,
  onOpenChange,
  building,
}: EditBuildingDialogProps) {
  const updateBuilding = useUpdateBuilding();
  const { data: areasData } = useAreas();
  const areas = Array.isArray(areasData) ? areasData.filter(a => a.status === 'ACTIVE') : [];

  const form = useForm<BuildingFormValues>({
    resolver: zodResolver(buildingSchema),
    defaultValues: {
      area_id: building.area_id || "",
      name: building.name,
      code: building.code || "",
      type: building.type,
      status: building.status,
      province: building.province,
      district: building.district,
      ward: building.ward,
      street_address: building.street_address || "",
      total_floors: building.total_floors?.toString() || "",
      description: building.description || "",
      commission_tiers:
        ((building as any).commission_tiers as CommissionTier[]) ?? DEFAULT_COMMISSION_TIERS,
    },
  });

  // Update form when building changes
  useEffect(() => {
    if (building) {
      form.reset({
        area_id: building.area_id || "",
        name: building.name,
        code: building.code || "",
        type: building.type,
        status: building.status,
        province: building.province,
        district: building.district,
        ward: building.ward,
        street_address: building.street_address || "",
        total_floors: building.total_floors?.toString() || "",
        description: building.description || "",
        commission_tiers:
          ((building as any).commission_tiers as CommissionTier[]) ?? DEFAULT_COMMISSION_TIERS,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building]);

  const onSubmit = async (data: BuildingFormValues) => {
    try {
      await updateBuilding.mutateAsync({
        id: building.id,
        updates: {
          name: data.name,
          code: data.code || null,
          area_id: data.area_id || null,
          type: data.type,
          status: data.status,
          province: data.province,
          district: data.district,
          ward: data.ward,
          street_address: data.street_address || null,
          total_floors: data.total_floors ? parseInt(data.total_floors) : null,
          description: data.description || null,
          commission_tiers: data.commission_tiers as any,
        },
      });
      onOpenChange(false);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Chỉnh sửa Tòa nhà</DialogTitle>
          <DialogDescription>
            Cập nhật thông tin tòa nhà
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
                  name="area_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Khu vực</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn khu vực" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {areas.map((area) => (
                            <SelectItem key={area.id} value={area.id}>
                              {area.name}{area.code ? ` (${area.code})` : ''}
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
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tên tòa nhà *</FormLabel>
                      <FormControl>
                        <Input placeholder="Ví dụ: Tòa A" {...field} />
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
                        <FormLabel>Mã tòa nhà</FormLabel>
                        <FormControl>
                          <Input placeholder="TN-A" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Loại hình *</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Chọn loại hình" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="APARTMENT">Chung cư</SelectItem>
                            <SelectItem value="DORMITORY">Ký túc xá</SelectItem>
                            <SelectItem value="HOUSE">Nhà riêng</SelectItem>
                            <SelectItem value="OFFICE">Văn phòng</SelectItem>
                            <SelectItem value="SLEEPBOX">Sleepbox</SelectItem>
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
                            <SelectItem value="ACTIVE">Hoạt động</SelectItem>
                            <SelectItem value="INACTIVE">Không hoạt động</SelectItem>
                            <SelectItem value="MAINTENANCE">Bảo trì</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Address */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Địa chỉ</h3>
                
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="province"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tỉnh/Thành phố *</FormLabel>
                        <FormControl>
                          <Input placeholder="Hồ Chí Minh" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="district"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Quận/Huyện *</FormLabel>
                        <FormControl>
                          <Input placeholder="Quận 1" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="ward"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phường/Xã *</FormLabel>
                      <FormControl>
                        <Input placeholder="Phường Bến Nghé" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="street_address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số nhà, đường</FormLabel>
                      <FormControl>
                        <Input placeholder="123 Đường ABC" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Additional Info */}
              <div className="space-y-4 pt-4 border-t">
                <h3 className="font-semibold text-sm">Thông tin bổ sung</h3>
                
                <FormField
                  control={form.control}
                  name="total_floors"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Số tầng</FormLabel>
                      <FormControl>
                        <NumberInput
                          min={0}
                          value={field.value ? parseInt(field.value, 10) : null}
                          onChange={(v) => field.onChange(v ? String(v) : "")}
                          onBlur={field.onBlur}
                          name={field.name}
                          placeholder="10"
                        />
                      </FormControl>
                      <FormDescription>
                        Tổng số tầng của tòa nhà
                      </FormDescription>
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
                          placeholder="Mô tả chi tiết về tòa nhà..."
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Hoa hồng môi giới */}
              <div className="space-y-4 pt-4 border-t">
                <FormField
                  control={form.control}
                  name="commission_tiers"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <CommissionTiersField
                          value={(field.value as CommissionTier[]) ?? []}
                          onChange={field.onChange}
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
                <Button type="submit" disabled={updateBuilding.isPending}>
                  {updateBuilding.isPending ? "Đang cập nhật..." : "Cập nhật"}
                </Button>
              </div>
            </form>
          </Form>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
