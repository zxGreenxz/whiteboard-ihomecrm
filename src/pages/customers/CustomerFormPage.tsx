import { useParams, useNavigate } from 'react-router-dom';
import { UserPlus, Pencil } from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import CustomerForm from '@/components/customers/CustomerForm';
import {
  useCustomer,
  useCreateCustomer,
  useUpdateCustomer,
} from '@/hooks/useCustomers';
import { useVehicles } from '@/hooks/useVehicles';
import type { CustomerFormData } from '@/types/customer';

/**
 * CustomerFormPage
 * Route: /customers/new (create) and /customers/:id/edit (edit)
 * Requirements: 2.10, 2.11, 2.12, 5.1, 5.2
 */
export default function CustomerFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = !!id;

  // Load existing data in edit mode
  const { data: customer, isLoading } = useCustomer(id || '');
  // Xe của khách, để sửa/xoá ngay trong form thay vì phải sang trang Phương tiện.
  const { data: vehiclesData, isLoading: isLoadingVehicles } = useVehicles(
    { customer_id: id },
    undefined,
    { enabled: isEdit },
  );
  const createMutation = useCreateCustomer();
  const updateMutation = useUpdateCustomer();

  const handleSubmit = (data: CustomerFormData) => {
    if (isEdit && id) {
      updateMutation.mutate(
        { id, data },
        { onSuccess: () => navigate('/customers') }
      );
    } else {
      createMutation.mutate(data, {
        onSuccess: () => navigate('/customers'),
      });
    }
  };

  const isSubmitting = createMutation.isPending || updateMutation.isPending;

  // Build default values from existing customer for edit mode
  const defaultValues: Partial<CustomerFormData> | undefined = customer
    ? {
        customer_type: customer.customer_type,
        full_name: customer.full_name,
        phone: customer.phone,
        email: customer.email ?? '',
        date_of_birth: customer.date_of_birth ?? undefined,
        gender: customer.gender ?? undefined,
        id_number: customer.id_number ?? undefined,
        id_issue_date: customer.id_issue_date ?? undefined,
        id_issue_place: customer.id_issue_place ?? undefined,
        is_foreign: customer.is_foreign,
        province: customer.province ?? undefined,
        district: customer.district ?? undefined,
        ward: customer.ward ?? undefined,
        detailed_address: customer.detailed_address ?? undefined,
        current_residence: customer.current_residence ?? undefined,
        permanent_address: customer.permanent_address ?? undefined,
        bank_account_number: customer.bank_account_number ?? undefined,
        bank_name: customer.bank_name ?? undefined,
        occupation: customer.occupation ?? undefined,
        workplace: customer.workplace ?? undefined,
        contact_person: customer.contact_person ?? undefined,
        contact_person_phone: customer.contact_person_phone ?? undefined,
        advisor: customer.advisor ?? undefined,
        advisor_phone: customer.advisor_phone ?? undefined,
        fingerprint_code: customer.fingerprint_code ?? undefined,
        customer_group: customer.customer_group ?? undefined,
        notes: customer.notes ?? undefined,
        avatar_url: customer.avatar_url ?? undefined,
        // DB default cho id_images là '[]'::jsonb, nhưng schema form chờ Record<string,string>.
        // Mọi mảng (kể cả [] rỗng) coi như chưa có ảnh để Zod không reject silently.
        id_images:
          customer.id_images && !Array.isArray(customer.id_images)
            ? (customer.id_images as Record<string, string>)
            : undefined,
        company_name: customer.company_name ?? undefined,
        representative: customer.representative ?? undefined,
        business_registration_url: customer.business_registration_url ?? undefined,
        headquarters_address: customer.headquarters_address ?? undefined,
        vehicles: (vehiclesData?.data ?? []).map((v) => ({
          id: v.id,
          vehicle_type: v.vehicle_type,
          vehicle_name: v.vehicle_name ?? '',
          color: v.color ?? '',
          license_plate: v.license_plate ?? '',
        })),
      }
    : undefined;

  // CustomerForm chỉ đọc defaultValues lúc mount ⇒ phải chờ cả xe về, kẻo
  // form mount với danh sách xe rỗng rồi lưu đè thành "xoá hết xe".
  if (isEdit && (isLoading || isLoadingVehicles)) {
    return (
      <MainLayout title="Đang tải..." icon={Pencil}>
        <div className="p-8 text-center text-muted-foreground">Đang tải dữ liệu khách hàng...</div>
      </MainLayout>
    );
  }

  return (
    <MainLayout
      title={isEdit ? 'Chỉnh sửa khách hàng' : 'Thêm khách hàng'}
      subtitle={isEdit ? 'Cập nhật thông tin khách hàng' : 'Tạo khách hàng mới'}
      icon={isEdit ? Pencil : UserPlus}
    >
      <CustomerForm
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
      />
    </MainLayout>
  );
}
