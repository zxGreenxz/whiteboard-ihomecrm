import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';
import { Separator } from '@/components/ui/separator';
import { customerSchema } from '@/lib/customerValidation';
import type { CustomerFormData, CustomerType } from '@/types/customer';
import ImageUploadZone from './ImageUploadZone';
import AddressCascadingDropdowns from './AddressCascadingDropdowns';
import CustomerIndividualFields from './CustomerIndividualFields';
import CustomerOrganizationFields from './CustomerOrganizationFields';
import CustomerVehiclesSection from './CustomerVehiclesSection';

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormData>;
  onSubmit: (data: CustomerFormData) => void;
  isSubmitting: boolean;
}

/**
 * CustomerForm
 * Main form with React Hook Form + Zod resolver
 * Toggle Cá nhân/Tổ chức, conditional rendering
 * Sections: Image upload, Thông tin chung, Địa chỉ, Tài chính & Liên lạc,
 *           Nhóm KH + Ghi chú, Thông tin xe
 * Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 2.8, 2.9
 */
export default function CustomerForm({ defaultValues, onSubmit, isSubmitting }: CustomerFormProps) {
  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      customer_type: 'INDIVIDUAL',
      full_name: '',
      phone: '',
      email: '',
      is_foreign: false,
      vehicles: [],
      ...defaultValues,
    },
  });

  const customerType = form.watch('customer_type');
  const isOrganization = customerType === 'ORGANIZATION';

  const handleTypeChange = (type: CustomerType) => {
    form.setValue('customer_type', type);
    // Reset type-specific fields
    if (type === 'ORGANIZATION') {
      form.setValue('full_name', form.getValues('full_name') || '');
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Toggle Cá nhân / Tổ chức */}
        <div className="bg-white rounded-lg border p-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={!isOrganization ? 'default' : 'outline'}
              onClick={() => handleTypeChange('INDIVIDUAL')}
              className={!isOrganization ? 'bg-green-600 hover:bg-green-700' : ''}
            >
              Cá nhân
            </Button>
            <Button
              type="button"
              variant={isOrganization ? 'default' : 'outline'}
              onClick={() => handleTypeChange('ORGANIZATION')}
              className={isOrganization ? 'bg-green-600 hover:bg-green-700' : ''}
            >
              Tổ chức
            </Button>
          </div>
        </div>

        {/* Image Upload Section */}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Hình ảnh</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <FormField
              control={form.control}
              name="avatar_url"
              render={({ field }) => (
                <ImageUploadZone
                  label="Ảnh đại diện"
                  value={field.value}
                  onChange={field.onChange}
                  bucket="customer-images"
                />
              )}
            />
            <ImageUploadZone
              label={isOrganization ? 'Đăng ký kinh doanh' : 'CCCD mặt trước'}
              value={form.watch('id_images')?.front}
              onChange={(url) => {
                const current = form.getValues('id_images') || {};
                form.setValue('id_images', { ...current, front: url });
              }}
              bucket="customer-images"
            />
            {!isOrganization && (
              <>
                <ImageUploadZone
                  label="CCCD mặt sau"
                  value={form.watch('id_images')?.back}
                  onChange={(url) => {
                    const current = form.getValues('id_images') || {};
                    form.setValue('id_images', { ...current, back: url });
                  }}
                  bucket="customer-images"
                />
                <ImageUploadZone
                  label="Hộ chiếu"
                  value={form.watch('id_images')?.passport}
                  onChange={(url) => {
                    const current = form.getValues('id_images') || {};
                    form.setValue('id_images', { ...current, passport: url });
                  }}
                  bucket="customer-images"
                />
              </>
            )}
          </div>
        </div>

        {/* Thông tin chung */}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Thông tin chung</h3>
          {isOrganization ? <CustomerOrganizationFields /> : <CustomerIndividualFields />}
        </div>

        {/* Địa chỉ */}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Địa chỉ</h3>
          <AddressCascadingDropdowns
            provinceValue={form.watch('province')}
            districtValue={form.watch('district')}
            wardValue={form.watch('ward')}
            onProvinceChange={(v) => form.setValue('province', v)}
            onDistrictChange={(v) => form.setValue('district', v)}
            onWardChange={(v) => form.setValue('ward', v)}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="detailed_address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Địa chỉ chi tiết</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập địa chỉ chi tiết" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="current_residence"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Chỗ ở hiện tại</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập chỗ ở hiện tại" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="permanent_address"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Địa chỉ thường trú</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập địa chỉ thường trú" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Tài chính & Liên lạc */}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Tài chính & Liên lạc</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <FormField
              control={form.control}
              name="bank_account_number"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Số tài khoản</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập số tài khoản" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="bank_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ngân hàng</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập tên ngân hàng" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            {!isOrganization && (
              <>
                <FormField
                  control={form.control}
                  name="occupation"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nghề nghiệp</FormLabel>
                      <FormControl>
                        <Input placeholder="Nhập nghề nghiệp" {...field} value={field.value ?? ''} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="workplace"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Nơi làm việc</FormLabel>
                      <FormControl>
                        <Input placeholder="Nhập nơi làm việc" {...field} value={field.value ?? ''} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </>
            )}
            <FormField
              control={form.control}
              name="advisor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Người tư vấn</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập tên người tư vấn" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="advisor_phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>SĐT người tư vấn</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập SĐT" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contact_person"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Người liên lạc</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập tên người liên lạc" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contact_person_phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>SĐT người liên lạc</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập SĐT" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="fingerprint_code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mã vân tay cửa ra vào</FormLabel>
                  <FormControl>
                    <Input placeholder="Nhập mã vân tay" {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Nhóm KH + Ghi chú */}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Nhóm khách hàng & Ghi chú</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="customer_group"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nhóm khách hàng</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? ''}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn nhóm" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="VIP">VIP</SelectItem>
                      <SelectItem value="Thường">Thường</SelectItem>
                      <SelectItem value="Tiềm năng">Tiềm năng</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Nhập ghi chú" rows={3} {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Thông tin xe */}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Thông tin xe</h3>
          <CustomerVehiclesSection />
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-3">
          <Button type="submit" disabled={isSubmitting} className="bg-green-600 hover:bg-green-700">
            {isSubmitting ? 'Đang lưu...' : 'Lưu'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
