// Sổ hồ sơ Đăng ký tạm trú đã nộp: mã hồ sơ extension đọc được lúc chủ bấm Nộp
// trên Cổng DVC. Một khách có thể nộp nhiều lần (gia hạn, nộp lại sau khi bị trả),
// nên giữ đủ lịch sử và lấy dòng mới nhất để hiển thị.
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import type { Database } from '@/integrations/supabase/types';

type Row = Database['public']['Tables']['residence_registrations']['Row'];
export type ResidenceRegistration = Pick<Row, 'id' | 'organization_id' | 'building_id' | 'customer_id' | 'contract_id'
  | 'subm_code' | 'receive_org' | 'temp_resident_from' | 'temp_resident_to' | 'submitted_at' | 'created_at'>;

export class RegistrationError extends Error {}

const COLUMNS = 'id,organization_id,building_id,customer_id,contract_id,subm_code,receive_org,temp_resident_from,temp_resident_to,submitted_at,created_at';

/** Mã hồ sơ cổng cấp: G01.899.909-260916-890012. Chặn rác trước khi ghi vào sổ. */
export function maHoSoHopLe(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Z0-9][A-Z0-9.\-/]{4,60}$/i.test(raw.trim());
}

/** dd/mm/yyyy → yyyy-mm-dd; trả null nếu không đúng dạng (cột date không nhận rác). */
export function ngayIso(raw: string | null | undefined): string | null {
  const m = String(raw ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Mới nhất trước — dòng đầu là lần nộp gần nhất, phần còn lại là lịch sử. */
export async function listCustomerRegistrations(customerId: string): Promise<ResidenceRegistration[]> {
  const { data, error } = await supabase.from('residence_registrations').select(COLUMNS)
    .eq('customer_id', customerId).is('deleted_at', null).order('submitted_at', { ascending: false });
  if (error) throw new RegistrationError('Không tải được lịch sử đăng ký tạm trú.');
  return (data ?? []) as ResidenceRegistration[];
}

export interface GhiHoSoInput {
  customerId: string;
  buildingId: string;
  organizationId: string;
  contractId?: string | null;
  submCode: string;
  receiveOrg?: string | null;
  /** dd/mm/yyyy như hiện trên cổng. */
  tempResidentFrom?: string | null;
  tempResidentTo?: string | null;
  submittedAt?: string;
}

/**
 * Ghi một lần nộp vào sổ. Nộp lại cùng mã (extension gửi trùng, người dùng mở lại
 * tab cũ) chỉ cập nhật dòng đã có nhờ khoá duy nhất (organization_id, subm_code),
 * còn nộp mã mới thì thêm dòng mới — đó chính là lịch sử.
 */
export async function ghiHoSoTamTru(input: GhiHoSoInput): Promise<ResidenceRegistration> {
  if (!maHoSoHopLe(input.submCode)) throw new RegistrationError('Mã hồ sơ không hợp lệ.');
  const user = await getSessionUser();
  if (!user) throw new RegistrationError('Bạn cần đăng nhập lại.');
  const { data, error } = await supabase.from('residence_registrations').upsert({
    organization_id: input.organizationId,
    building_id: input.buildingId,
    customer_id: input.customerId,
    contract_id: input.contractId ?? null,
    subm_code: input.submCode.trim(),
    receive_org: (input.receiveOrg ?? '').slice(0, 200),
    temp_resident_from: ngayIso(input.tempResidentFrom),
    temp_resident_to: ngayIso(input.tempResidentTo),
    submitted_at: input.submittedAt ?? new Date().toISOString(),
    created_by: user.id,
  }, { onConflict: 'organization_id,subm_code' }).select(COLUMNS).single();
  if (error || !data) {
    throw new RegistrationError(error?.code === '42501'
      ? 'Bạn không có quyền ghi hồ sơ tạm trú của khách này.'
      : 'Chưa lưu được mã hồ sơ tạm trú. Vui lòng thử lại.');
  }
  return data as ResidenceRegistration;
}

/** yyyy-mm-dd hoặc ISO → dd/mm/yyyy để hiện lên giao diện. */
export function ngayVn(raw: string | null | undefined): string {
  const m = String(raw ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Đường tra cứu hồ sơ trên cổng, để bấm thẳng từ CRM. */
export const DVC_TRA_CUU_URL = 'https://dichvucong.dancuquocgia.gov.vn/portal/p/home/tra-cuu-ho-so.html';
