// Hook dữ liệu cho ảnh hồ sơ tạm trú: danh sách theo khách / theo toà và
// mutation tải lên / xoá mềm. Lỗi đã là tiếng Việt (DossierFileError) → toast thẳng.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  listBuildingOwnershipFiles, listCustomerDossierFiles, removeDossierFile, uploadDossierFile,
  type DossierKind, type ResidenceDossierFile,
} from '@/lib/residenceDossierFiles';

export const residenceDossierKeys = {
  customer: (customerId: string) => ['residence-dossier-files', 'customer', customerId] as const,
  building: (buildingId: string) => ['residence-dossier-files', 'building', buildingId] as const,
};

export function useCustomerDossierFiles(customerId: string | undefined) {
  return useQuery<ResidenceDossierFile[], Error>({
    queryKey: residenceDossierKeys.customer(customerId ?? ''),
    queryFn: () => listCustomerDossierFiles(customerId as string),
    enabled: !!customerId,
  });
}

export function useBuildingOwnershipFiles(buildingId: string | undefined) {
  return useQuery<ResidenceDossierFile[], Error>({
    queryKey: residenceDossierKeys.building(buildingId ?? ''),
    queryFn: () => listBuildingOwnershipFiles(buildingId as string),
    enabled: !!buildingId,
  });
}

export interface DossierUploadInput { kind: DossierKind; contractId?: string; file: File }

export function useDossierFileMutations(scope: {
  customerId?: string; buildingId: string; buildingName?: string; customerName?: string;
}) {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: residenceDossierKeys.building(scope.buildingId) }),
      scope.customerId
        ? queryClient.invalidateQueries({ queryKey: residenceDossierKeys.customer(scope.customerId) })
        : Promise.resolve(),
    ]);
  };
  const upload = useMutation<ResidenceDossierFile, Error, DossierUploadInput>({
    mutationFn: (input) => uploadDossierFile({
      kind: input.kind, buildingId: scope.buildingId, customerId: scope.customerId, contractId: input.contractId, file: input.file,
      buildingName: scope.buildingName, customerName: scope.customerName,
    }),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation<void, Error, string>({
    mutationFn: (id) => removeDossierFile(id),
    onSuccess: invalidate,
    onError: (error) => toast.error(error.message),
  });
  return { upload, remove };
}
