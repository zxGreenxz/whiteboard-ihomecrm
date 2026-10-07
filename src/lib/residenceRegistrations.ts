// Sổ hồ sơ tạm trú đã nộp: mã hồ sơ extension đọc được lúc chủ bấm Nộp trên Cổng
// DVC, cho cả Đăng ký (TAMTRU_01) lẫn Xóa đăng ký (TAMTRU_06). Một khách có thể nộp
// nhiều lần (gia hạn, nộp lại sau khi bị trả), nên giữ đủ lịch sử và lấy dòng mới
// nhất của từng thủ tục để hiển thị.
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { FinancialWorkflowError } from './financialWorkflowError';
import type { Database } from '@/integrations/supabase/types';

type Row = Database['public']['Tables']['residence_registrations']['Row'];
/** Mã thủ tục trên cổng: TAMTRU_01 đăng ký, TAMTRU_06 xoá đăng ký tạm trú. */
export type ResidenceProcedureCode = 'TAMTRU_01' | 'TAMTRU_06';
export type ResidenceRegistration = Pick<Row, 'id' | 'organization_id' | 'building_id' | 'customer_id' | 'contract_id'
  | 'subm_code' | 'receive_org' | 'temp_resident_from' | 'temp_resident_to' | 'submitted_at' | 'created_at'>
  & { procedure_code: ResidenceProcedureCode };

import { RegistrationError, maHoSoHopLe } from './residenceRegistrationValidation';
export { RegistrationError, maHoSoHopLe } from './residenceRegistrationValidation';

const COLUMNS = 'id,organization_id,building_id,customer_id,contract_id,subm_code,receive_org,temp_resident_from,temp_resident_to,submitted_at,created_at,procedure_code';


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
  if (!Array.isArray(data)) throw new RegistrationError('Chưa tải được lịch sử đăng ký tạm trú.');
  return data as ResidenceRegistration[];
}

/** Lượt nộp của đúng một thủ tục, giữ thứ tự mới nhất trước. */
export function theoThuTuc(registrations: ResidenceRegistration[], procedure: ResidenceProcedureCode): ResidenceRegistration[] {
  return registrations.filter(r => r.procedure_code === procedure);
}

export interface GhiHoSoInput {
  customerId: string;
  buildingId: string;
  organizationId: string;
  contractId?: string | null;
  submCode: string;
  /** Thiếu thì là đăng ký — mọi lượt nộp trước khi có xoá đăng ký đều là TAMTRU_01. */
  procedureCode?: ResidenceProcedureCode;
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
  const procedure: ResidenceProcedureCode = input.procedureCode ?? 'TAMTRU_01';
  // Dòng PostgREST trả về mang procedure_code kiểu string; khớp đúng thủ tục mới thu hẹp được.
  const matches = (row: (Omit<ResidenceRegistration, 'procedure_code'> & { procedure_code: string }) | null): row is ResidenceRegistration => !!row?.id
    && row.procedure_code === procedure
    && row.organization_id === input.organizationId && row.customer_id === input.customerId && row.building_id === input.buildingId
    && row.subm_code === input.submCode.trim() && row.contract_id === (input.contractId ?? null)
    && row.receive_org === (input.receiveOrg ?? '').slice(0,200)
    && row.temp_resident_from === ngayIso(input.tempResidentFrom) && row.temp_resident_to === ngayIso(input.tempResidentTo);
  // Sổ chốt trùng theo (công ty, mã) cho CẢ hai thủ tục, nên dán nhầm mã đăng ký vào ô của khối
  // huỷ (hay ngược lại) sẽ ghi đè dòng cũ sang thủ tục kia và mất lịch sử. Đọc trước, khác thì từ chối.
  const { data: daCo, error: loiDoc } = await supabase.from('residence_registrations').select('procedure_code')
    .eq('organization_id', input.organizationId).eq('subm_code', input.submCode.trim()).maybeSingle();
  if (loiDoc) throw new RegistrationError('Chưa kiểm được mã hồ sơ này trong sổ. Vui lòng thử lại.');
  if (daCo && daCo.procedure_code !== procedure) {
    throw new RegistrationError(daCo.procedure_code === 'TAMTRU_06'
      ? 'Mã này đã ghi là hồ sơ huỷ tạm trú, không ghi thành hồ sơ đăng ký được.'
      : 'Mã này đã ghi là hồ sơ đăng ký tạm trú, không ghi thành hồ sơ huỷ được.');
  }
  // Load the feedback receipt coordinator only when saving; the guard still precedes every writer.
  const { persistentFinancialWorkflow } = await import('./persistentFinancialWorkflow');
  return persistentFinancialWorkflow('residence-registration-save', {scope:'target'}).run(input.submCode.trim(), 'lưu mã hồ sơ tạm trú', async (progress) => {
  const { data, error } = await supabase.from('residence_registrations').upsert({
    organization_id: input.organizationId,
    building_id: input.buildingId,
    customer_id: input.customerId,
    contract_id: input.contractId ?? null,
    subm_code: input.submCode.trim(),
    procedure_code: procedure,
    receive_org: (input.receiveOrg ?? '').slice(0, 200),
    temp_resident_from: ngayIso(input.tempResidentFrom),
    temp_resident_to: ngayIso(input.tempResidentTo),
    submitted_at: input.submittedAt ?? new Date().toISOString(),
    created_by: user.id,
  }, { onConflict: 'organization_id,subm_code' }).select(COLUMNS).single();
  if (error) {
    if (error.code === '42501') throw new FinancialWorkflowError('Bạn không có quyền ghi hồ sơ tạm trú của khách này.', 'failure', [], error);
    throw error;
  }
  const ids = data?.id ? [{id:data.id,label:'Mã hồ sơ tạm trú cần đối chiếu'}] : [];
  if (!matches(data)) {
    throw new FinancialWorkflowError('Chưa xác nhận được mã hồ sơ tạm trú đã lưu. Giữ mã đang nhập và đối chiếu lịch sử trước khi gửi lại.', 'unknown', ids);
  }
  progress.completed.push(...ids);
  return data as ResidenceRegistration;
  }, async (pending) => {
    const {data,error} = await supabase.from('residence_registrations').select(COLUMNS)
      .eq('organization_id',input.organizationId).eq('subm_code',input.submCode.trim()).is('deleted_at',null).maybeSingle();
    if (error) throw error;
    if (!matches(data) || (pending.completedIds.length > 0 && !pending.completedIds.includes(data.id))) return null;
    return {result:data as ResidenceRegistration};
  }, input.organizationId);
}

/** yyyy-mm-dd hoặc ISO → dd/mm/yyyy để hiện lên giao diện. */
export function ngayVn(raw: string | null | undefined): string {
  const m = String(raw ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Đường tra cứu hồ sơ trên cổng, để bấm thẳng từ CRM. */
export const DVC_TRA_CUU_URL = 'https://dichvucong.dancuquocgia.gov.vn/portal/p/home/tra-cuu-ho-so.html';
