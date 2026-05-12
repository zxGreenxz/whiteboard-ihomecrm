import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Switch } from '@/components/ui/switch';
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
  FormMessage,
} from '@/components/ui/form';
import type { CustomerFormData } from '@/types/customer';

/**
 * CustomerIndividualFields
 * Fields for individual customer: Họ tên*, SĐT*, Email, CMND/CCCD,
 * Ngày cấp, Nơi cấp, Ngày sinh, Giới tính, Toggle Khách nước ngoài
 * Requirements: 2.3, 2.4
 */
export default function CustomerIndividualFields() {
  const { control, watch } = useFormContext<CustomerFormData>();
  const isForeign = watch('is_foreign');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Họ tên * */}
        <FormField
          control={control}
          name="full_name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Họ tên khách <span className="text-red-500">*</span></FormLabel>
              <FormControl>
                <Input placeholder="Nhập họ tên" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* SĐT * */}
        <FormField
          control={control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Số điện thoại <span className="text-red-500">*</span></FormLabel>
              <FormControl>
                <Input placeholder="Nhập số điện thoại" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Email */}
        <FormField
          control={control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="Nhập email" type="email" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* CMND/CCCD */}
        <FormField
          control={control}
          name="id_number"
          render={({ field }) => (
            <FormItem>
              <FormLabel>CMND/CCCD</FormLabel>
              <FormControl>
                <Input placeholder="Nhập CMND/CCCD" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Ngày cấp */}
        <FormField
          control={control}
          name="id_issue_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ngày cấp</FormLabel>
              <FormControl>
                <DateInput
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Nơi cấp */}
        <FormField
          control={control}
          name="id_issue_place"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nơi cấp</FormLabel>
              <FormControl>
                <Input placeholder="Nhập nơi cấp" {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Ngày sinh */}
        <FormField
          control={control}
          name="date_of_birth"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ngày sinh</FormLabel>
              <FormControl>
                <DateInput
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Giới tính */}
        <FormField
          control={control}
          name="gender"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Giới tính</FormLabel>
              <Select onValueChange={field.onChange} value={field.value ?? ''}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn giới tính" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="Nam">Nam</SelectItem>
                  <SelectItem value="Nữ">Nữ</SelectItem>
                  <SelectItem value="Khác">Khác</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {/* Toggle Khách nước ngoài */}
      <FormField
        control={control}
        name="is_foreign"
        render={({ field }) => (
          <FormItem className="flex items-center gap-3 space-y-0">
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
            <FormLabel className="cursor-pointer">Khách nước ngoài</FormLabel>
          </FormItem>
        )}
      />

      {/* Additional fields when foreign customer is enabled */}
      {isForeign && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <p className="col-span-full text-sm font-medium text-blue-700">Thông tin khách nước ngoài</p>
          <FormField
            control={control}
            name="id_number"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Số hộ chiếu</FormLabel>
                <FormControl>
                  <Input placeholder="Nhập số hộ chiếu" {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="id_issue_place"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Quốc tịch</FormLabel>
                <FormControl>
                  <Input placeholder="Nhập quốc tịch" {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="id_issue_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Ngày hết hạn visa</FormLabel>
                <FormControl>
                  <DateInput
                    value={field.value ?? ''}
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
      )}
    </div>
  );
}
