import { useFormContext, useFieldArray } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
} from '@/components/ui/form';
import type { CustomerFormData } from '@/types/customer';

const VEHICLE_TYPE_OPTIONS = [
  { value: 'MOTORBIKE', label: 'Xe máy' },
  { value: 'CAR', label: 'Ô tô' },
  { value: 'BICYCLE', label: 'Xe đạp' },
  { value: 'ELECTRIC_BIKE', label: 'Xe điện' },
  { value: 'OTHER', label: 'Khác' },
];

/**
 * CustomerVehiclesSection
 * Inline vehicle list with add/remove using useFieldArray
 * Fields: Loại PT (dropdown), Tên dòng xe, Biển số
 * Requirements: 2.9
 */
export default function CustomerVehiclesSection() {
  const { control } = useFormContext<CustomerFormData>();
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'vehicles',
  });

  return (
    <div className="space-y-3">
      {fields.map((field, index) => (
        <div key={field.id} className="flex items-end gap-3">
          {/* Loại phương tiện */}
          <FormField
            control={control}
            name={`vehicles.${index}.vehicle_type`}
            render={({ field: f }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Loại phương tiện</FormLabel>}
                <Select onValueChange={f.onChange} value={f.value || ''}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn loại" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {VEHICLE_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />

          {/* Tên dòng xe */}
          <FormField
            control={control}
            name={`vehicles.${index}.vehicle_name`}
            render={({ field: f }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Tên dòng xe</FormLabel>}
                <FormControl>
                  <Input placeholder="VD: Honda Wave" {...f} />
                </FormControl>
              </FormItem>
            )}
          />

          {/* Biển số */}
          <FormField
            control={control}
            name={`vehicles.${index}.license_plate`}
            render={({ field: f }) => (
              <FormItem className="flex-1">
                {index === 0 && <FormLabel>Biển số xe</FormLabel>}
                <FormControl>
                  <Input placeholder="VD: 59A-12345" {...f} />
                </FormControl>
              </FormItem>
            )}
          />

          {/* Remove button */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-red-500 hover:text-red-600 hover:bg-red-50 shrink-0"
            onClick={() => remove(index)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ vehicle_type: 'MOTORBIKE', vehicle_name: '', license_plate: '' })}
        className="gap-1"
      >
        <Plus className="h-4 w-4" />
        Thêm phương tiện
      </Button>
    </div>
  );
}
