import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
} from '@/components/ui/form';
import { customerSchema } from '@/lib/customerValidation';
import type { CustomerFormData, CustomerType } from '@/types/customer';
import type { CCCDQrData } from '@/lib/cccdQrParser';
import { lookupAddressFromText } from '@/lib/cccdAddressLookup';
import ImageUploadZone from './ImageUploadZone';
import AddressCascadingDropdowns from './AddressCascadingDropdowns';
import CustomerIndividualFields from './CustomerIndividualFields';
import CustomerOrganizationFields from './CustomerOrganizationFields';
import CustomerVehiclesSection from './CustomerVehiclesSection';
import CCCDQrUpload from './CCCDQrUpload';

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormData>;
  onSubmit: (data: CustomerFormData) => void;
  isSubmitting: boolean;
}

/**
 * CustomerForm
 * Main form with React Hook Form + Zod resolver.
 * Sections: Hình ảnh, Thông tin chung, Địa chỉ, Thông tin khác, Thông tin xe.
 */
export default function CustomerForm({ defaultValues, onSubmit, isSubmitting }: CustomerFormProps) {
  const queryClient = useQueryClient();
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

  const handleCccdParsed = async (data: CCCDQrData) => {
    if (data.fullName) form.setValue('full_name', data.fullName, { shouldDirty: true });
    if (data.idNumber) form.setValue('id_number', data.idNumber, { shouldDirty: true });
    if (data.dateOfBirth) form.setValue('date_of_birth', data.dateOfBirth, { shouldDirty: true });
    if (data.gender) form.setValue('gender', data.gender, { shouldDirty: true });
    if (data.idIssueDate) form.setValue('id_issue_date', data.idIssueDate, { shouldDirty: true });
    if (data.idIssuePlace) form.setValue('id_issue_place', data.idIssuePlace, { shouldDirty: true });
    if (data.permanentAddress) {
      form.setValue('permanent_address', data.permanentAddress, { shouldDirty: true });
      try {
        const res = await lookupAddressFromText(data.permanentAddress);
        // Seed React Query cache trước để useDistricts/useWards có data ngay sau re-render.
        if (res.provinceCode && res.districts) {
          queryClient.setQueryData(['address', 'districts', res.provinceCode], res.districts);
        }
        if (res.districtCode && res.wards) {
          queryClient.setQueryData(['address', 'wards', res.districtCode], res.wards);
        }
        if (res.detailedAddress) form.setValue('detailed_address', res.detailedAddress, { shouldDirty: true });
        // Set tỉnh trước, chờ Radix Select mount SelectItem cho cấp dưới rồi mới set
        // (Radix reset value về '' nếu không khớp SelectItem nào đang mount).
        // setTimeout(0) không đủ trên iOS Safari thật — chờ 2 animation frame để chắc
        // React đã commit + paint xong trước khi set cấp tiếp theo.
        const waitFrame = () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          );
        if (res.provinceCode) {
          form.setValue('province', res.provinceCode, { shouldDirty: true });
        }
        if (res.districtCode) {
          await waitFrame();
          form.setValue('district', res.districtCode, { shouldDirty: true });
        }
        if (res.wardCode) {
          await waitFrame();
          form.setValue('ward', res.wardCode, { shouldDirty: true });
        }
      } catch (e) {
        console.error('Address lookup failed:', e);
      }
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

        {/* QR CCCD scan — chỉ áp dụng cho khách cá nhân */}
        {!isOrganization && (
          <div className="bg-white rounded-lg border p-4">
            <CCCDQrUpload onParsed={handleCccdParsed} />
          </div>
        )}

        {/* Image Upload Section */}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Hình ảnh</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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

        {/* Thông tin khác */}
        <div className="bg-white rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Thông tin khác</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {!isOrganization && (
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
            )}
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
