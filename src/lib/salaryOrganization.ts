import { supabase } from '@/integrations/supabase/client';
import { requireWorkingOrganization } from './workingOrganization';

export interface SalaryLockSubject {
  id: string;
  commissionItems?: ReadonlyArray<{ voucherId?: string | null }>;
}

export async function resolveSalaryPeriodOrganization(staffId: string, periodMonth: string): Promise<string> {
  const { data: monthly, error: monthlyError } = await supabase.from("salary_monthly").select("organization_id").eq("staff_id", staffId).eq("period_month", periodMonth).maybeSingle();
  if (monthlyError) throw monthlyError;
  if (monthly) {
    if (!monthly.organization_id) throw new Error("Bảng lương chưa có công ty rõ ràng");
    return monthly.organization_id;
  }
  const selectedOrganizationId = requireWorkingOrganization();
  const { data: cfg, error: configError } = await supabase
    .from("manager_salary_config")
    .select("organization_id")
    .eq("staff_id", staffId)
    .eq("organization_id", selectedOrganizationId)
    .not("organization_id", "is", null)
    .eq("is_active", true)
    .lte("effective_from", periodMonth)
    .or(`effective_to.is.null,effective_to.gte.${periodMonth}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (configError) throw configError;
  if (cfg?.organization_id) return cfg.organization_id;

  const { data: mem, error: membershipError } = await supabase
    .from("organization_memberships")
    .select("organization_id")
    .eq("user_id", staffId)
    .eq("organization_id", selectedOrganizationId)
    .eq("status", "ACTIVE")
    .limit(1)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (mem?.organization_id) return mem.organization_id;

  throw new Error("Không xác định được tổ chức của nhân viên — không thể ghi dòng lương");
}

export async function validateSalaryLockOrganization(
  managers: ReadonlyArray<SalaryLockSubject>, periodMonth: string,
): Promise<{ organizationId: string; commVoucherIds: string[] }> {
  const organizations = await Promise.all(managers.map(m => resolveSalaryPeriodOrganization(m.id, periodMonth)));
  const organizationId = organizations[0];
  if (!organizationId || organizations.some(id => id !== organizationId)) {
    throw new Error("Danh sách bảng lương phải thuộc cùng một công ty.");
  }
  const commVoucherIds = Array.from(new Set(managers.flatMap(m =>
    (m.commissionItems || []).map(x => x.voucherId).filter((id): id is string => !!id))));
  if (commVoucherIds.length) {
    const { data: vouchers, error } = await supabase.from("income_expenses")
      .select("id, organization_id").in("id", commVoucherIds);
    if (error) throw error;
    if (vouchers?.length !== commVoucherIds.length || vouchers.some(v => v.organization_id !== organizationId)) {
      throw new Error("Phiếu hoa hồng không thuộc công ty của bảng lương hoặc không còn quyền truy cập.");
    }
  }
  return { organizationId, commVoucherIds };
}
