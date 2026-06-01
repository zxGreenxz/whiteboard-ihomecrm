import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';
import type { CustomerFormData } from '@/types/customer';

/**
 * CustomerOrganizationFields
 * Fields for organization customer: Tên công ty*, SĐT*, Email,
 * Người đại diện, Địa chỉ trụ sở
 * Requirements: 3.1
 */
export default function CustomerOrganizationFields() {
  const { control } = useFormContext<CustomerFormData>();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* Tên công ty * */}
      <FormField
        control={control}
        name="company_name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Tên Công ty/Tổ chức <span className="text-red-500">*</span></FormLabel>
            <FormControl>
              <Input placeholder="Nhập tên công ty" {...field} value={field.value ?? ''} />
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

      {/* Người đại diện */}
      <FormField
        control={control}
        name="representative"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Người đại diện</FormLabel>
            <FormControl>
              <Input placeholder="Nhập tên người đại diện" {...field} value={field.value ?? ''} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {/* Địa chỉ trụ sở */}
      <FormField
        control={control}
        name="headquarters_address"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Địa chỉ trụ sở</FormLabel>
            <FormControl>
              <Input placeholder="Nhập địa chỉ trụ sở" {...field} value={field.value ?? ''} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}
