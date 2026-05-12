import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ct01Schema, type CT01FormValues } from '@/lib/ct01Validation';
import { autoFillCT01FromCustomer } from '@/lib/ct01Helpers';
import type { Customer } from '@/types/customer';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CT01FamilyMembersTable } from '@/components/customers/CT01FamilyMembersTable';

interface CT01FormProps {
  customer: Customer;
  onSubmit: (values: CT01FormValues) => void;
  isLoading?: boolean;
}

export function CT01Form({ customer, onSubmit, isLoading }: CT01FormProps) {
  const form = useForm<CT01FormValues>({
    resolver: zodResolver(ct01Schema),
    defaultValues: {
      registration_authority: '',
      full_name: '',
      date_of_birth: '',
      gender: '',
      id_number: '',
      phone: '',
      email: '',
      permanent_address: '',
      temporary_address: '',
      current_address: '',
      occupation_workplace: '',
      household_head_name: '',
      household_head_relationship: '',
      request_content: '',
      family_members: [],
    },
  });

  useEffect(() => {
    if (customer) {
      const filled = autoFillCT01FromCustomer(customer);
      form.reset({
        registration_authority: filled.registration_authority ?? '',
        full_name: filled.full_name ?? '',
        date_of_birth: filled.date_of_birth ?? '',
        gender: filled.gender ?? '',
        id_number: filled.id_number ?? '',
        phone: filled.phone ?? '',
        email: filled.email ?? '',
        permanent_address: filled.permanent_address ?? '',
        temporary_address: filled.temporary_address ?? '',
        current_address: filled.current_address ?? '',
        occupation_workplace: filled.occupation_workplace ?? '',
        household_head_name: filled.household_head_name ?? '',
        household_head_relationship: filled.household_head_relationship ?? '',
        request_content: filled.request_content ?? '',
        family_members: filled.family_members ?? [],
      });
    }
  }, [customer, form]);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Cơ quan ĐKCT - full width */}
        <FormField
          control={form.control}
          name="registration_authority"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Cơ quan đăng ký cư trú <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <Input placeholder="Nhập cơ quan đăng ký cư trú" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* 2-column grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Họ tên */}
          <FormField
            control={form.control}
            name="full_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Họ và tên <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <Input placeholder="Nhập họ và tên" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Ngày sinh */}
          <FormField
            control={form.control}
            name="date_of_birth"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Ngày sinh <span className="text-destructive">*</span></FormLabel>
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

          {/* Giới tính */}
          <FormField
            control={form.control}
            name="gender"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Giới tính <span className="text-destructive">*</span></FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
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

          {/* CMND/CCCD */}
          <FormField
            control={form.control}
            name="id_number"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Số CMND/CCCD <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <Input placeholder="Nhập số CMND/CCCD" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* SĐT */}
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Số điện thoại</FormLabel>
                <FormControl>
                  <Input placeholder="Nhập số điện thoại" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Email */}
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="Nhập email" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Nghề nghiệp */}
          <FormField
            control={form.control}
            name="occupation_workplace"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Nghề nghiệp / Nơi làm việc</FormLabel>
                <FormControl>
                  <Input placeholder="Nhập nghề nghiệp và nơi làm việc" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Chủ hộ */}
          <FormField
            control={form.control}
            name="household_head_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Họ tên chủ hộ</FormLabel>
                <FormControl>
                  <Input placeholder="Nhập họ tên chủ hộ" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Quan hệ với chủ hộ */}
          <FormField
            control={form.control}
            name="household_head_relationship"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Quan hệ với chủ hộ</FormLabel>
                <FormControl>
                  <Input placeholder="Nhập quan hệ với chủ hộ" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Address fields - full width */}
        <FormField
          control={form.control}
          name="permanent_address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nơi thường trú</FormLabel>
              <FormControl>
                <Input placeholder="Nhập địa chỉ thường trú" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="temporary_address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nơi tạm trú</FormLabel>
              <FormControl>
                <Input placeholder="Nhập địa chỉ tạm trú" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="current_address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nơi ở hiện tại</FormLabel>
              <FormControl>
                <Input placeholder="Nhập địa chỉ hiện tại" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Nội dung đề nghị - full width */}
        <FormField
          control={form.control}
          name="request_content"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Nội dung đề nghị</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Nhập nội dung đề nghị"
                  className="min-h-[100px]"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Danh sách thành viên hộ gia đình */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Danh sách thành viên hộ gia đình</h3>
          <CT01FamilyMembersTable control={form.control as any} />
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={isLoading}>
            {isLoading ? 'Đang xử lý...' : 'Lưu phiếu CT01'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
