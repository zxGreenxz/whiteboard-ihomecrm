import { useParams, useNavigate } from 'react-router-dom';
import { Building2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import MainLayout from '@/components/layout/MainLayout';
import BuildingForm from '@/components/buildings/BuildingForm';
import {
  useBuilding,
  useCreateBuilding,
  useUpdateBuilding,
} from '@/hooks/useBuildings';
import { useUpsertBuildingServices } from '@/hooks/useBuildingServices';
import type { BuildingFormData, BuildingServiceFormData } from '@/types/building';

/**
 * BuildingFormPage
 * Route: /buildings/new (create) and /buildings/:id/edit (edit)
 * 2-step submit: create/update building → upsert building services
 * Requirements: 2.8, 2.9, 2.10, 2.11, 3.1, 3.2, 3.3
 */
export default function BuildingFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = !!id;

  // Load existing building data in edit mode
  const { data: building, isLoading } = useBuilding(id || '');
  const createMutation = useCreateBuilding();
  const updateMutation = useUpdateBuilding();
  const upsertServicesMutation = useUpsertBuildingServices();

  const isSubmitting =
    createMutation.isPending ||
    updateMutation.isPending ||
    upsertServicesMutation.isPending;

  const handleSubmit = async (
    data: BuildingFormData,
    services: BuildingServiceFormData[]
  ) => {
    // Prepare services payload (only active or with overrides)
    const servicesPayload = services.map((s) => ({
      service_id: s.service_id,
      is_active: s.is_active,
      unit_price_override: s.unit_price_override,
    }));

    if (isEdit && id) {
      // Update building
      updateMutation.mutate(
        {
          id,
          updates: {
            name: data.name,
            code: data.code || null,
            province: data.province,
            district: data.district,
            ward: data.ward,
            street_address: data.street_address,
            area_id: data.area_id || null,
            status: data.status,
          },
        },
        {
          onSuccess: () => {
            // Step 2: Upsert building services
            upsertServicesMutation.mutate(
              { buildingId: id, services: servicesPayload },
              {
                onSuccess: () => {
                  toast.success('Dữ liệu đã được CẬP NHẬT thành công');
                  navigate('/buildings');
                },
              }
            );
          },
        }
      );
    } else {
      // Create building
      createMutation.mutate(
        {
          name: data.name,
          code: data.code || null,
          province: data.province,
          district: data.district,
          ward: data.ward,
          street_address: data.street_address,
          area_id: data.area_id || null,
          status: data.status,
        },
        {
          onSuccess: (newBuilding) => {
            // Step 2: Upsert building services
            upsertServicesMutation.mutate(
              { buildingId: newBuilding.id, services: servicesPayload },
              {
                onSuccess: () => {
                  toast.success('Dữ liệu đã được TẠO thành công');
                  navigate('/buildings');
                },
              }
            );
          },
        }
      );
    }
  };

  const handleCancel = () => {
    navigate('/buildings');
  };

  // Build default values from existing building for edit mode
  const defaultValues: Partial<BuildingFormData> | undefined = building
    ? {
        name: building.name,
        code: building.code ?? '',
        province: building.province,
        district: building.district,
        ward: building.ward,
        street_address: building.street_address ?? '',
        area_id: building.area_id ?? '',
        status: building.status as BuildingFormData['status'],
      }
    : undefined;

  if (isEdit && isLoading) {
    return (
      <MainLayout title="Đang tải..." icon={Pencil}>
        <div className="p-8 text-center text-muted-foreground">
          Đang tải dữ liệu toà nhà...
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout
      title={isEdit ? 'Chỉnh sửa toà nhà' : 'Thêm toà nhà'}
      subtitle="Danh mục dữ liệu > Toà nhà"
      icon={isEdit ? Pencil : Building2}
    >
      <BuildingForm
        defaultValues={defaultValues}
        buildingId={id}
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
        onCancel={handleCancel}
      />
    </MainLayout>
  );
}
