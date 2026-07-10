import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { DateInput } from "@/components/ui/date-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

import type { ContractFormState } from "./useContractFormState";

type GeneralSectionProps = Pick<
  ContractFormState,
  | "form"
  | "buildings"
  | "selectedBuildingId"
  | "filteredRooms"
  | "handleBuildingChange"
  | "handleRoomChange"
>;

/** ===== Section 1: Thông tin chung ===== (JSX chuyển NGUYÊN VĂN) */
export function GeneralSection({
  form,
  buildings,
  selectedBuildingId,
  filteredRooms,
  handleBuildingChange,
  handleRoomChange,
}: GeneralSectionProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground border-b pb-2">
        Thông tin chung
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Toà nhà */}
        <div className="space-y-2">
          <Label>
            Toà nhà <span className="text-destructive">*</span>
          </Label>
          <Select
            value={selectedBuildingId}
            onValueChange={handleBuildingChange}
          >
            <SelectTrigger>
              <SelectValue placeholder="Chọn toà nhà" />
            </SelectTrigger>
            <SelectContent>
              {buildings.map((b: any) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Phòng */}
        <FormField
          control={form.control}
          name="room_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Phòng <span className="text-destructive">*</span>
              </FormLabel>
              <Select
                value={field.value}
                onValueChange={(val) => {
                  handleRoomChange(val);
                  field.onChange(val);
                }}
                disabled={!selectedBuildingId}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn phòng" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {/* Phòng RESERVED (đã cọc giữ chỗ) VẪN chọn được để ký HĐ cho
                      người đã cọc — chỉ gắn nhãn "Đã cọc" để nhận biết. */}
                  {filteredRooms.map((r: any) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                      {r.status === "RESERVED" ? " · Đã cọc" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Ngày ký */}
        <FormField
          control={form.control}
          name="signed_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ngày ký</FormLabel>
              <FormControl>
                <DateInput
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Ngày bắt đầu */}
        <FormField
          control={form.control}
          name="start_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Ngày bắt đầu <span className="text-destructive">*</span>
              </FormLabel>
              <FormControl>
                <DateInput
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Hạn hợp đồng */}
        <FormField
          control={form.control}
          name="end_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Hạn hợp đồng <span className="text-destructive">*</span>
              </FormLabel>
              <FormControl>
                <DateInput
                  value={field.value}
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

      {/* Ghi chú */}
      <FormField
        control={form.control}
        name="notes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Ghi chú</FormLabel>
            <FormControl>
              <Textarea
                placeholder="Ghi chú hợp đồng..."
                rows={2}
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
