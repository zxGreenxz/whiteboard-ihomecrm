import { supabase } from "@/integrations/supabase/client";
import { parseOrganizations, type Organization } from "@/contexts/OrganizationContext";

/**
 * Danh bạ công ty của NGƯỜI ĐANG GỌI — cùng nguồn với OrganizationProvider.
 *
 * Không select thẳng bảng `organizations`: RLS của bảng đó không cho người dùng thường (kể cả
 * Chủ công ty) đọc dòng của chính mình, select ra [] mà không báo lỗi (đo prod 01/10/2026).
 */
export async function fetchMyOrganizations(): Promise<Organization[]> {
  const { data, error } = await supabase.rpc("list_my_copilot_organizations_v1");
  if (error) throw error;
  return parseOrganizations(data);
}
