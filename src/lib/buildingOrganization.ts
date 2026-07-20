import { supabase } from "@/integrations/supabase/client";

export async function requireBuildingOrganizationId(buildingId: string): Promise<string> {
  const { data, error } = await supabase
    .from("buildings")
    .select("organization_id")
    .eq("id", buildingId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.organization_id) {
    throw new Error("Tòa nhà chưa được gắn tổ chức");
  }
  return data.organization_id;
}
