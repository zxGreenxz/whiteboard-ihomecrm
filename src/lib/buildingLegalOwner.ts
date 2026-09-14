import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';

const defaultIssuePlace = 'Cục Cảnh sát';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Ngày cấp không hợp lệ');

export const buildingLegalOwnerSchema = z.object({
  full_name: z.string().trim().max(200),
  birth_year: z.number().int().min(1800).max(2200).nullable(),
  id_number: z.string().trim().max(50),
  id_issue_date: dateOnly.nullable(),
  id_issue_place: z.string().trim().max(500).transform(value => value || defaultIssuePlace),
  permanent_address: z.string().trim().max(1000),
});
export type BuildingLegalOwner = z.infer<typeof buildingLegalOwnerSchema>;
export const emptyBuildingLegalOwner: BuildingLegalOwner = {
  full_name: '', birth_year: null, id_number: '', id_issue_date: null, id_issue_place: defaultIssuePlace, permanent_address: '',
};

export async function loadBuildingLegalOwner(buildingId: string): Promise<BuildingLegalOwner | null> {
  const { data, error } = await supabase.from('building_legal_owners')
    .select('full_name,birth_year,id_number,id_issue_date,id_issue_place,permanent_address')
    .eq('building_id', buildingId).maybeSingle();
  if (error) throw new Error('Không tải được chủ sở hữu pháp lý. Vui lòng thử lại.');
  return data === null ? null : buildingLegalOwnerSchema.parse(data);
}

export async function saveBuildingLegalOwner(buildingId: string, owner: BuildingLegalOwner): Promise<void> {
  const payload = buildingLegalOwnerSchema.parse(owner);
  const { error } = await supabase.rpc('save_building_legal_owner', { p_building_id: buildingId, p_owner: payload });
  if (error) throw new Error(error.code === '42501'
    ? 'Bạn không có quyền lưu chủ sở hữu pháp lý.'
    : 'Thông tin tòa nhà có thể đã được lưu; chưa lưu được chủ sở hữu pháp lý. Vui lòng thử lại.');
}
