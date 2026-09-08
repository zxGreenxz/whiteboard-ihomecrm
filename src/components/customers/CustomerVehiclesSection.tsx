import { useFormContext, useFieldArray } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
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
          <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          {/* Loại phương tiện */}
          <FormField
            control={control}
            name={`vehicles.${index}.vehicle_type`}
            render={({ field: f }) => (
              <FormItem>
                {index === 0 && <FormLabel>Loại phương tiện</FormLabel>}
                <FormControl><SearchableSelect aria-label={`Loại phương tiện ${index + 1}`} value={f.value || ''} onValueChange={f.onChange} options={VEHICLE_TYPE_OPTIONS} placeholder="Chọn loại" searchPlaceholder="Tìm loại phương tiện..." /></FormControl>
              </FormItem>
            )}
          />

          {/* Tên dòng xe */}
          <FormField
            control={control}
            name={`vehicles.${index}.vehicle_name`}
            render={({ field: f }) => (
              <FormItem>
                {index === 0 && <FormLabel>Tên dòng xe</FormLabel>}
                <FormControl>
                  <Input placeholder="VD: Honda Wave" {...f} />
                </FormControl>
              </FormItem>
            )}
          />

          {/* Màu xe */}
          <FormField
            control={control}
            name={`vehicles.${index}.color`}
            render={({ field: f }) => (
              <FormItem>
                {index === 0 && <FormLabel>Màu xe</FormLabel>}
                <FormControl>
                  <Input placeholder="VD: Đen, Trắng, Đỏ" {...f} value={f.value ?? ''} />
                </FormControl>
              </FormItem>
            )}
          />

          {/* Biển số */}
          <FormField
            control={control}
            name={`vehicles.${index}.license_plate`}
            render={({ field: f }) => (
              <FormItem>
                {index === 0 && <FormLabel>Biển số xe</FormLabel>}
                <FormControl>
                  <Input placeholder="VD: 59A-12345" {...f} />
                </FormControl>
              </FormItem>
            )}
          />
          </div>

          {/* Remove button */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Xoá phương tiện"
            title="Xoá phương tiện"
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
        onClick={() =>
          append({ vehicle_type: 'MOTORBIKE', vehicle_name: '', color: '', license_plate: '' })
        }
        className="gap-1"
      >
        <Plus className="h-4 w-4" />
        Thêm phương tiện
      </Button>
    </div>
  );
}
