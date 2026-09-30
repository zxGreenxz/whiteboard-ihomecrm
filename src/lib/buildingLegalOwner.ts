import { z } from 'zod';
import { FinancialWorkflowError } from './financialWorkflow';
import { supabase } from '@/integrations/supabase/client';

const defaultIssuePlace = 'Cục Cảnh sát';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày cấp CCCD/CMND phải là ngày hợp lệ.').refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Ngày cấp CCCD/CMND phải là ngày hợp lệ.');

export const buildingLegalOwnerSchema = z.object({
  full_name: z.string().trim().max(200, 'Họ tên chủ sở hữu không được quá 200 ký tự.'),
  birth_year: z.number({ invalid_type_error: 'Nhập năm sinh chủ sở hữu bằng số.' }).int('Năm sinh chủ sở hữu phải là số nguyên.').min(1800, 'Năm sinh chủ sở hữu phải từ 1800 đến 2200.').max(2200, 'Năm sinh chủ sở hữu phải từ 1800 đến 2200.').nullable(),
  id_number: z.string().trim().max(50, 'CCCD/CMND chủ sở hữu không được quá 50 ký tự.'),
  id_issue_date: dateOnly.nullable(),
  id_issue_place: z.string().trim().max(500, 'Nơi cấp CCCD/CMND không được quá 500 ký tự.').transform(value => value || defaultIssuePlace),
  permanent_address: z.string().trim().max(1000, 'Địa chỉ thường trú không được quá 1.000 ký tự.'),
});
export type BuildingLegalOwner = z.infer<typeof buildingLegalOwnerSchema>;
export const emptyBuildingLegalOwner: BuildingLegalOwner = {
  full_name: '', birth_year: null, id_number: '', id_issue_date: null, id_issue_place: defaultIssuePlace, permanent_address: '',
};

export async function loadBuildingLegalOwner(buildingId: string): Promise<BuildingLegalOwner | null> {
  const { data, error } = await supabase.from('building_legal_owners')
    .select('full_name,birth_year,id_number,id_issue_date,id_issue_place,permanent_address')
    .eq('building_id', buildingId).maybeSingle();
  if (error) throw error;
  return data === null ? null : buildingLegalOwnerSchema.parse(data);
}

export async function saveBuildingLegalOwner(buildingId: string, owner: BuildingLegalOwner): Promise<void> {
  const payload = buildingLegalOwnerSchema.parse(owner);
  const { error } = await supabase.rpc('save_building_legal_owner', { p_building_id: buildingId, p_owner: payload });
  if (error) throw error;
  const current=await loadBuildingLegalOwner(buildingId);
  if(!current || Object.entries(payload).some(([key,value])=>current[key as keyof BuildingLegalOwner]!==value))throw new FinancialWorkflowError('Chưa xác nhận được thông tin chủ sở hữu sau khi lưu. Đối chiếu tòa đã lưu trước khi thực hiện tiếp.','unknown',[]);
}
