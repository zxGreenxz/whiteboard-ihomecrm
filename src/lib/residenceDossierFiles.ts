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
  | 'bucket_id' | 'object_name' | 'file_name' | 'content_type' | 'size_bytes' | 'sort_order' | 'created_at'
  | 'lease_term_from' | 'lease_term_to' | 'lease_term_source'> & { kind: DossierKind };
export class DossierFileError extends Error {}

const COLUMNS = 'id,kind,organization_id,building_id,customer_id,contract_id,bucket_id,object_name,file_name,content_type,size_bytes,sort_order,created_at,lease_term_from,lease_term_to,lease_term_source';
// Cổng DVC chỉ nhận pdf, jpg, jpeg, tiff, png (validFileAttachAll của cổng) — WebP bị
// từ chối thẳng. Vì vậy ảnh hồ sơ tạm trú lưu NGUYÊN BYTE gốc (imagePolicy
// 'identity-original'), không đi qua bộ nén sang WebP như ảnh thường. Giới hạn 10MB
// là ràng buộc của chính chính sách đó.
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const EXT_THEO_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png' };

/** Bỏ dấu, bỏ khoảng trắng, còn chữ và số — dùng dựng tên tệp dễ đọc. */
export function slugTen(raw: string): string {
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tên tệp hiển thị, đặt theo đối tượng chứ không giữ tên máy ảnh.
 *
 * VÌ SAO: tên này đi thẳng lên Cổng DVC ở cột "Đính kèm". Với ảnh chủ quyền của
 * toà thì "IMG_20260915.jpg" không cho biết là của toà nào, còn hai ảnh cùng tên
 * thì không biết ảnh nào là ảnh nào. Quy ước: chuquyen950nk1.jpg,
 * nguyengiabinhct01.jpg, nguyengiabinhhopdong1.jpg.
 */
export function tenTepHoSo(input: {
  kind: DossierKind; buildingName?: string; customerName?: string; index: number; ext: string;
}): string {
  const ext = input.ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const stt = Math.max(1, input.index);
  if (input.kind === 'OWNERSHIP') {
    return `chuquyen${slugTen(input.buildingName ?? '') || 'toanha'}${stt}.${ext}`;
  }
  const khach = slugTen(input.customerName ?? '') || 'khach';
  return `${khach}${input.kind === 'CT01' ? 'ct01' : 'hopdong'}${stt}.${ext}`;
}

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
  // Ảnh giữ nguyên byte gốc nên content-type = của tệp gốc; giữ phép kiểm đuôi
  // phòng khi lớp storage đổi định dạng ở tương lai.
  return /\.webp$/i.test(objectName) ? 'image/webp' : original;
}

export async function uploadDossierFile(input: {
  kind: DossierKind; buildingId: string; customerId?: string; contractId?: string; file: File;
  /** Tên toà và tên khách để đặt tên tệp dễ đọc trên Cổng DVC. */
  buildingName?: string; customerName?: string;
}): Promise<ResidenceDossierFile> {
  const { kind, buildingId, customerId, contractId, file } = input;
  // Cổng DVC không nhận WebP nên chỉ cho JPG/PNG ngay từ đây, thay vì để cổng từ chối sau.
  if (!IMAGE_TYPES.has(file.type)) throw new DossierFileError('Cổng DVC chỉ nhận ảnh JPG hoặc PNG.');
  if (file.size > MAX_BYTES) throw new DossierFileError('Ảnh tối đa 10MB.');
  if (kind !== 'OWNERSHIP' && !customerId) throw new DossierFileError('Thiếu khách hàng cho ảnh này.');
  const user = await getSessionUser();
  if (!user) throw new DossierFileError('Bạn cần đăng nhập lại.');
  const { data: building, error: buildingError } = await supabase.from('buildings')
    .select('organization_id,name').eq('id', buildingId).single();
  if (buildingError || !building?.organization_id) throw new DossierFileError('Không xác định được toà nhà của hồ sơ.');
  // Số thứ tự tiếp theo trong cùng nhóm: ảnh chủ quyền đếm theo toà, ảnh của
  // khách đếm theo khách. Đếm trước khi tải lên nên có thể trùng khi hai người
  // cùng bấm một lúc — tên chỉ để đọc, trùng không làm hỏng gì.
  let daCoRaw: ResidenceDossierFile[] = [];
  try {
    daCoRaw = kind === 'OWNERSHIP'
      ? await listBuildingOwnershipFiles(buildingId)
      : await listCustomerDossierFiles(customerId as string);
  } catch {
    // Truy vấn này CHỈ để đánh số thứ tự trong tên tệp. Đọc hụt thì đánh số 1:
    // tên có thể trùng số, còn chặn cả lượt tải ảnh vì một truy vấn phụ mới là
    // hỏng việc thật. Lỗi quyền/kết nối thật sự sẽ lộ ngay ở bước ghi bên dưới.
  }
  const daCo = Array.isArray(daCoRaw) ? daCoRaw.filter((f) => f.kind === kind) : [];
  const displayName = tenTepHoSo({
    kind, index: daCo.length + 1, ext: EXT_THEO_MIME[file.type] ?? 'jpg',
    buildingName: input.buildingName ?? building.name ?? undefined,
    customerName: input.customerName,
  });
  const path = `${user.id}/${kind.toLowerCase()}/${Date.now()}-${sanitizeStorageFileName(displayName)}`;
  const stored = await uploadFile(RESIDENCE_DOCS_BUCKET, path, file, { imagePolicy: 'identity-original' });
  const objectName = parseStorageRef(stored)?.path ?? path;
  const { data, error } = await supabase.from('residence_dossier_files').insert({
    kind,
    building_id: buildingId,
    organization_id: building.organization_id,
    customer_id: kind === 'OWNERSHIP' ? null : customerId ?? null,
    contract_id: contractId ?? null,
    bucket_id: RESIDENCE_DOCS_BUCKET,
    object_name: objectName,
    file_name: displayName.slice(0, 255),
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

/** dd/mm/yyyy → yyyy-mm-dd cho cột date của Postgres. */
function ngayIso(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split('/');
  return `${y}-${m}-${d}`;
}

/**
 * Ghi thời hạn đọc được trên ảnh hợp đồng vào chính dòng ảnh đó.
 *
 * Đây là BỘ NHỚ ĐỆM của việc nhận dạng chữ, không phải dữ liệu người dùng nhập:
 * đọc ảnh tốn vài giây và tốn pin trên điện thoại, mở lại hồ sơ không nên đọc lại.
 * `nguon = 'manual'` khi người dùng tự sửa ngày.
 */
export async function luuHanHopDong(
  id: string, from: string, to: string, nguon: 'ocr' | 'manual' = 'ocr',
): Promise<void> {
  const { error } = await supabase.from('residence_dossier_files')
    .update({ lease_term_from: ngayIso(from), lease_term_to: ngayIso(to), lease_term_source: nguon })
    .eq('id', id);
  if (error) {
    throw new DossierFileError(error.code === '42501'
      ? 'Bạn không có quyền sửa hạn hợp đồng của ảnh này.'
      : 'Chưa lưu được hạn hợp đồng. Vui lòng thử lại.');
  }
}

export async function removeDossierFile(id: string): Promise<void> {
  const { error } = await supabase.from('residence_dossier_files')
    .update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) {
    throw new DossierFileError(error.code === '42501' ? 'Bạn không có quyền xoá ảnh này.' : 'Chưa xoá được ảnh. Vui lòng thử lại.');
  }
}
