// Tệp hồ sơ đăng ký tạm trú: ảnh CT01/hợp đồng đã ký (theo khách) và giấy tờ
// chứng minh chỗ ở hợp pháp (theo toà). Lưu ở bucket private residence-docs,
// đọc qua signed URL; quyền do RLS quyết định (customers.print / buildings.edit).
import { supabase } from '@/integrations/supabase/client';
import { getPublicUrl, parseStorageRef, sanitizeStorageFileName, uploadFile } from '@/lib/storage';
import { getSessionUser } from '@/lib/authSession';
import type { Database } from '@/integrations/supabase/types';

export type DossierKind = 'CT01' | 'LEASE' | 'OWNERSHIP';
export const RESIDENCE_DOCS_BUCKET = 'residence-docs';
export const DOSSIER_KIND_LABEL: Record<DossierKind, string> = {
  CT01: 'Tờ khai CT01 đã ký',
  LEASE: 'Hợp đồng thuê đã ký',
  OWNERSHIP: 'Giấy tờ chứng minh chỗ ở hợp pháp',
};
type Row = Database['public']['Tables']['residence_dossier_files']['Row'];
export type ResidenceDossierFile = Pick<Row, 'id' | 'organization_id' | 'building_id' | 'customer_id' | 'contract_id'
  | 'bucket_id' | 'object_name' | 'file_name' | 'content_type' | 'size_bytes' | 'sort_order' | 'created_at'> & { kind: DossierKind };
export class DossierFileError extends Error {}

const COLUMNS = 'id,kind,organization_id,building_id,customer_id,contract_id,bucket_id,object_name,file_name,content_type,size_bytes,sort_order,created_at';
const MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

/** Giá trị để StorageImage / createSignedUrlFromStored ký lúc đọc. */
export function dossierStorageValue(file: Pick<ResidenceDossierFile, 'bucket_id' | 'object_name'>): string {
  return getPublicUrl(file.bucket_id, file.object_name);
}

export async function listCustomerDossierFiles(customerId: string): Promise<ResidenceDossierFile[]> {
  const { data, error } = await supabase.from('residence_dossier_files').select(COLUMNS)
    .eq('customer_id', customerId).is('deleted_at', null).order('kind').order('sort_order').order('created_at');
  if (error) throw new DossierFileError('Không tải được ảnh hồ sơ tạm trú. Vui lòng thử lại.');
  return (data ?? []) as ResidenceDossierFile[];
}

export async function listBuildingOwnershipFiles(buildingId: string): Promise<ResidenceDossierFile[]> {
  const { data, error } = await supabase.from('residence_dossier_files').select(COLUMNS)
    .eq('building_id', buildingId).eq('kind', 'OWNERSHIP').is('deleted_at', null).order('sort_order').order('created_at');
  if (error) throw new DossierFileError('Không tải được giấy tờ chỗ ở hợp pháp. Vui lòng thử lại.');
  return (data ?? []) as ResidenceDossierFile[];
}

function contentTypeOf(objectName: string, original: string): string {
  // uploadFile nén ảnh ra WebP và đổi đuôi key; content-type phải khớp bytes đã lưu.
  return /\.webp$/i.test(objectName) ? 'image/webp' : original;
}

export async function uploadDossierFile(input: {
  kind: DossierKind; buildingId: string; customerId?: string; contractId?: string; file: File;
}): Promise<ResidenceDossierFile> {
  const { kind, buildingId, customerId, contractId, file } = input;
  if (!IMAGE_TYPES.has(file.type)) throw new DossierFileError('Chỉ nhận ảnh JPG, PNG hoặc WebP.');
  if (file.size > MAX_BYTES) throw new DossierFileError('Ảnh tối đa 15MB.');
  if (kind !== 'OWNERSHIP' && !customerId) throw new DossierFileError('Thiếu khách hàng cho ảnh này.');
  const user = await getSessionUser();
  if (!user) throw new DossierFileError('Bạn cần đăng nhập lại.');
  const { data: building, error: buildingError } = await supabase.from('buildings')
    .select('organization_id').eq('id', buildingId).single();
  if (buildingError || !building?.organization_id) throw new DossierFileError('Không xác định được toà nhà của hồ sơ.');
  const path = `${user.id}/${kind.toLowerCase()}/${Date.now()}-${sanitizeStorageFileName(file.name)}`;
  const stored = await uploadFile(RESIDENCE_DOCS_BUCKET, path, file);
  const objectName = parseStorageRef(stored)?.path ?? path;
  const { data, error } = await supabase.from('residence_dossier_files').insert({
    kind,
    building_id: buildingId,
    organization_id: building.organization_id,
    customer_id: kind === 'OWNERSHIP' ? null : customerId ?? null,
    contract_id: contractId ?? null,
    bucket_id: RESIDENCE_DOCS_BUCKET,
    object_name: objectName,
    file_name: file.name.slice(0, 255),
    content_type: contentTypeOf(objectName, file.type),
    size_bytes: file.size,
    sort_order: Date.now() % 1_000_000_000,
    created_by: user.id,
  }).select(COLUMNS).single();
  if (error || !data) {
    throw new DossierFileError(error?.code === '42501'
      ? 'Bạn không có quyền lưu ảnh hồ sơ tạm trú.'
      : 'Ảnh đã tải lên nhưng chưa lưu được vào hồ sơ. Vui lòng thử lại.');
  }
  return data as ResidenceDossierFile;
}

/** Ảnh CT01/LEASE ưu tiên đúng hợp đồng đang chọn; không có thì lấy mọi ảnh của khách; cộng ảnh chỗ ở hợp pháp của toà. */
export function pickDossierFilesForContract(
  customerFiles: ResidenceDossierFile[], ownershipFiles: ResidenceDossierFile[], contractId: string,
): ResidenceDossierFile[] {
  const perKind = (kind: 'CT01' | 'LEASE') => {
    const ofKind = customerFiles.filter(f => f.kind === kind);
    const ofContract = ofKind.filter(f => f.contract_id === contractId);
    return ofContract.length > 0 ? ofContract : ofKind;
  };
  return [...perKind('CT01'), ...perKind('LEASE'), ...ownershipFiles.filter(f => f.kind === 'OWNERSHIP')];
}

export async function removeDossierFile(id: string): Promise<void> {
  const { error } = await supabase.from('residence_dossier_files')
    .update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) {
    throw new DossierFileError(error.code === '42501' ? 'Bạn không có quyền xoá ảnh này.' : 'Chưa xoá được ảnh. Vui lòng thử lại.');
  }
}
