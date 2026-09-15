// Ảnh giấy tờ chứng minh chỗ ở hợp pháp của toà (sổ hồng, hợp đồng thuê nhà nguyên căn...).
// Tải một lần, tool đính kèm cho mọi hồ sơ tạm trú của toà. Chỉ hiện khi toà đã có id.
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { useBuildingOwnershipFiles, useDossierFileMutations } from '@/hooks/useResidenceDossierFiles';
import DossierImageUploader from './DossierImageUploader';

export interface BuildingOwnershipDocsProps { buildingId: string }

export default function BuildingOwnershipDocs({ buildingId }: BuildingOwnershipDocsProps) {
  const { data: permissions } = useMyPermissions();
  const canEdit = canUse(permissions, 'buildings', 'edit');
  const files = useBuildingOwnershipFiles(buildingId);
  const { upload, remove } = useDossierFileMutations({ buildingId });

  return (
    <section className="space-y-2 rounded-md border p-3" aria-label="Giấy tờ chứng minh chỗ ở hợp pháp">
      <DossierImageUploader kind="OWNERSHIP" files={files.data ?? []} canEdit={canEdit}
        onUpload={upload.mutateAsync} onRemove={remove.mutateAsync}
        hint="Dùng cho hồ sơ Đăng ký tạm trú trên Cổng DVC: tải một lần, đính kèm cho mọi khách của toà." />
      {files.isError && <p className="text-xs text-red-600">Không tải được ảnh giấy tờ chỗ ở hợp pháp.</p>}
    </section>
  );
}
