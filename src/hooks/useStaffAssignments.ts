import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type StaffAssignment = Database["public"]["Tables"]["staff_assignments"]["Row"];
type StaffAssignmentInsert = Database["public"]["Tables"]["staff_assignments"]["Insert"];
type StaffAssignmentUpdate = Database["public"]["Tables"]["staff_assignments"]["Update"];

export const useStaffAssignments = () => {
  return useQuery({
    queryKey: ["staff_assignments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_assignments")
        .select(`
          *,
          role:roles(id, name, permissions),
          building:buildings(id, name),
          area:areas(id, name)
        `)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useStaffAssignments error:", error);
        return [];
      }

      const rows = data || [];
      const staffIds = Array.from(new Set(rows.map((r) => r.staff_id))).filter(Boolean);
      if (staffIds.length === 0) return rows;

      // Second pass: pull profile info for each staff_id (full_name, phone, email,
      // and Resident-style staff fields if the migration has been applied).
      // Fall back to base columns if the extended columns don't exist yet.
      let profiles: any[] | null = null;
      const tryExtended = await supabase
        .from("profiles")
        .select("id,full_name,phone,email,department,job_title,employee_code,is_active" as any)
        .in("id", staffIds);
      if (!tryExtended.error) {
        profiles = tryExtended.data as any[];
      } else {
        const fallback = await supabase
          .from("profiles")
          .select("id,full_name,phone,email")
          .in("id", staffIds);
        profiles = (fallback.data as any[]) || [];
      }

      const profileById = new Map<string, any>();
      for (const p of (profiles || []) as any[]) profileById.set(p.id, p);

      return rows.map((r) => ({
        ...r,
        profile: profileById.get(r.staff_id) || null,
      }));
    },
  });
};

export const useStaffAssignmentsByStaff = (staffId: string) => {
  return useQuery({
    queryKey: ["staff_assignments", "staff", staffId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("staff_assignments")
        .select(`
          *,
          role:roles(id, name, permissions),
          building:buildings(id, name),
          area:areas(id, name)
        `)
        .eq("staff_id", staffId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useStaffAssignmentsByStaff error:", error);
        return [];
      }

      return data || [];
    },
    enabled: !!staffId,
  });
};

export const useCreateStaffAssignment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (assignment: Omit<StaffAssignmentInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("staff_assignments")
        .insert({ ...assignment, user_id: user.id })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Nhân viên đã được gán cho toà nhà này");
        } else {
          toast.error("Không thể gán nhân viên");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Nhân viên đã được gán thành công");
    },
    onError: (error) => {
      console.error("Error creating staff assignment:", error);
    },
  });
};

export const useUpdateStaffAssignment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: StaffAssignmentUpdate }) => {
      const { data, error } = await supabase
        .from("staff_assignments")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Nhân viên đã được gán cho toà nhà này");
        } else {
          toast.error("Không thể cập nhật phân quyền");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Phân quyền đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating staff assignment:", error);
    },
  });
};

// =============================================================
// Provision a brand-new staff member (Resident-style "Thêm người dùng" flow):
// 1. supabase.auth.signUp creates the auth user (email/phone/username synthetic)
// 2. profiles row gets full info (full_name, phone, email, department, …)
// 3. staff_assignments links the new user to a role + (optional) building
// =============================================================

export interface ProvisionStaffInput {
  /** Required: free-form login name. Anything goes — Vietnamese, spaces, etc.
   *  System synthesizes a stable auth email from this. */
  username: string;
  password: string;
  role_id: string;
  /** Toà lẻ (snapshot): 1 row / toà. Cùng rỗng với area_ids → full scope
   *  (1 row, building_id=null, area_id=null). */
  building_ids?: string[] | null;
  /** Khu vực (LIVE): 1 row / khu — toà thêm vào khu sau này TỰ ĐỘNG thuộc
   *  phạm vi của nhân viên (DB resolve qua area_buildings). */
  area_ids?: string[] | null;
  // All identity fields below are OPTIONAL.
  full_name?: string;
  phone?: string;
  email?: string;
  department?: string;
  job_title?: string;
  employee_code?: string;
  is_active?: boolean;
}

const slugifyUsername = (raw: string): string => {
  const slug = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'user';
};

/** Turn the user-typed username into a stable auth email.
 *  Always slugify first so the same input maps to the same account no
 *  matter the casing/diacritics. */
const buildAuthEmail = (input: ProvisionStaffInput): string => {
  const slug = slugifyUsername(input.username);
  return `${slug}@username.ihomecrm.local`;
};

export const useProvisionStaff = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ProvisionStaffInput) => {
      // Tạo tài khoản qua Edge Function admin-create-user (Supabase Admin API,
      // super_admin-gated) THAY VÌ browser signUp. signUp cũ tự chuyển session
      // sang user mới (phải lưu/khôi phục session admin — dễ race, để lại orphan
      // auth row) và đòi project-level signup phải mở. Admin API không đổi session
      // và không cần mở signup công khai. (AUTHORIZATION-PLAN.md §10, Sprint 0.2)
      const { data: { session: adminSession } } = await supabase.auth.getSession();
      if (!adminSession) throw new Error("Bạn chưa đăng nhập");
      const owner = adminSession.user;

      const authEmail = buildAuthEmail(input);

      // handle_new_user() đọc user_metadata → dựng profiles trong 1 transaction.
      const { data: created, error: fnErr } = await supabase.functions.invoke(
        "admin-create-user",
        {
          body: {
            email: authEmail,
            password: input.password,
            username: input.username,
            full_name: input.full_name || input.username,
            phone: input.phone || null,
            contact_email: input.email || null,
            employee_code: input.employee_code || null,
            department: input.department || null,
            job_title: input.job_title || null,
            is_active: input.is_active ?? true,
          },
        },
      );

      // Lỗi HTTP từ edge fn: đọc message trong response body nếu có.
      if (fnErr) {
        let msg = fnErr.message;
        try {
          const ctx = (fnErr as unknown as { context?: Response }).context;
          if (ctx && typeof ctx.json === "function") {
            const body = await ctx.json();
            if (body?.error) msg = body.error as string;
          }
        } catch { /* giữ msg gốc */ }
        if (/already been registered|already registered|duplicate/i.test(msg)) {
          throw new Error(`Tên đăng nhập "${input.username}" đã được sử dụng. Vui lòng chọn tên khác.`);
        }
        throw new Error(msg);
      }
      if (created?.error) {
        const msg = created.error as string;
        if (/already been registered|already registered|duplicate/i.test(msg)) {
          throw new Error(`Tên đăng nhập "${input.username}" đã được sử dụng. Vui lòng chọn tên khác.`);
        }
        throw new Error(msg);
      }
      const newUserId = created?.user?.id as string | undefined;
      if (!newUserId) throw new Error("Không tạo được tài khoản — kiểm tra lại tên đăng nhập");

      // Seed permissions snapshot từ role.permissions để staff có quyền ngay
      // (Tier 2 init = Tier 1). Owner sau đó có thể tinh chỉnh per staff.
      const { data: roleRow } = await supabase
        .from("roles")
        .select("permissions")
        .eq("id", input.role_id)
        .single();

      // Scope rows: toà lẻ (building_id) + khu live (area_id). Cả hai rỗng →
      // 1 row global (building_id=null, area_id=null) = "tất cả toà nhà".
      const buildingIds = input.building_ids ?? [];
      const areaIds = input.area_ids ?? [];
      const scopeRows: { building_id: string | null; area_id: string | null }[] =
        buildingIds.length === 0 && areaIds.length === 0
          ? [{ building_id: null, area_id: null }]
          : [
              ...buildingIds.map((bid) => ({ building_id: bid, area_id: null })),
              ...areaIds.map((aid) => ({ building_id: null, area_id: aid })),
            ];

      const rowsToInsert = scopeRows.map((scope) => ({
        user_id: owner.id,
        staff_id: newUserId,
        role_id: input.role_id,
        ...scope,
        permissions: roleRow?.permissions ?? null,
      }));

      const { data: assignments, error: assignErr } = await supabase
        .from("staff_assignments")
        .insert(rowsToInsert)
        .select();
      if (assignErr) throw assignErr;

      return assignments;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Đã tạo tài khoản nhân viên thành công");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
};

// =============================================================
// Edit a staff member's assignments — sets role_id + buildings
// to the given target. Diffs against existing rows: insert missing,
// delete extras, update role_id on common rows.
// =============================================================

export interface UpdateStaffMemberInput {
  staff_id: string;
  role_id: string;
  /** Toà lẻ (snapshot). Cùng rỗng với area_ids → full scope (1 row global). */
  building_ids?: string[] | null;
  /** Khu vực (LIVE) — phạm vi tự cập nhật theo membership của khu. */
  area_ids?: string[] | null;
  profile_patch?: {
    full_name?: string;
    phone?: string | null;
    email?: string | null;
    department?: string | null;
    job_title?: string | null;
    employee_code?: string | null;
    is_active?: boolean;
  };
}

export const useUpdateStaffMember = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateStaffMemberInput) => {
      const owner = await getSessionUser();
      if (!owner) throw new Error("Bạn chưa đăng nhập");

      // 1) Sync profile fields. Admin RLS policy (profiles_admin_update,
      //    migration 20260502000001) allows the user_id of any
      //    staff_assignments row to update that staff's profile.
      if (input.profile_patch) {
        const { error } = await supabase
          .from("profiles")
          .update(input.profile_patch as any)
          .eq("id", input.staff_id);
        if (error) throw error;
      }

      // 2) Fetch existing assignments for this staff
      const { data: existing, error: fetchErr } = await supabase
        .from("staff_assignments")
        .select("id, building_id, area_id, role_id")
        .eq("staff_id", input.staff_id);
      if (fetchErr) throw fetchErr;

      // Scope mong muốn: toà lẻ + khu live; cả hai rỗng → 1 row global.
      const buildingIds = input.building_ids ?? [];
      const areaIds = input.area_ids ?? [];
      const wantScopes: { building_id: string | null; area_id: string | null }[] =
        buildingIds.length === 0 && areaIds.length === 0
          ? [{ building_id: null, area_id: null }]
          : [
              ...buildingIds.map((bid) => ({ building_id: bid, area_id: null })),
              ...areaIds.map((aid) => ({ building_id: null, area_id: aid })),
            ];

      // Key phân biệt 3 loại row: toà lẻ / khu live / global
      const keyOf = (r: { building_id: string | null; area_id: string | null }) =>
        r.building_id ? `b:${r.building_id}` : r.area_id ? `a:${r.area_id}` : "__global__";

      const have = new Map<string, { id: string; role_id: string }>();
      for (const r of existing || []) {
        have.set(keyOf(r as any), { id: r.id, role_id: r.role_id });
      }
      const want = new Set(wantScopes.map(keyOf));

      // 3) Delete rows whose building is no longer in `want`
      const toDelete: string[] = [];
      for (const [key, val] of have.entries()) {
        if (!want.has(key)) toDelete.push(val.id);
      }
      if (toDelete.length > 0) {
        const { error } = await supabase
          .from("staff_assignments")
          .delete()
          .in("id", toDelete);
        if (error) throw error;
      }

      // Đọc role.permissions để snapshot khi role đổi hoặc tạo row mới.
      const { data: roleRow } = await supabase
        .from("roles")
        .select("permissions")
        .eq("id", input.role_id)
        .single();

      // 4) Update role_id on rows we're keeping (if role changed).
      // Khi role đổi → re-snapshot permissions từ template mới (Tier 1 → Tier 2).
      const toUpdateIds: string[] = [];
      for (const [key, val] of have.entries()) {
        if (want.has(key) && val.role_id !== input.role_id) toUpdateIds.push(val.id);
      }
      if (toUpdateIds.length > 0) {
        const { error } = await supabase
          .from("staff_assignments")
          .update({ role_id: input.role_id, permissions: roleRow?.permissions ?? null })
          .in("id", toUpdateIds);
        if (error) throw error;
      }

      // 5) Insert missing rows (toà/khu mới được thêm)
      const toInsert = wantScopes
        .filter((scope) => !have.has(keyOf(scope)))
        .map((scope) => ({
          user_id: owner.id,
          staff_id: input.staff_id,
          role_id: input.role_id,
          ...scope,
          permissions: roleRow?.permissions ?? null,
        }));
      if (toInsert.length > 0) {
        const { error } = await supabase.from("staff_assignments").insert(toInsert);
        if (error) throw error;
      }

      return { staff_id: input.staff_id };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Đã cập nhật phân quyền nhân viên");
    },
    onError: (error: Error) => {
      toast.error(`Không cập nhật được: ${error.message}`);
    },
  });
};

// Remove a staff member completely. Calls SECURITY DEFINER RPC
// `delete_staff_member` which DELETEs from auth.users — cascades
// wipe profiles + staff_assignments + any user-owned data.
// Single source of truth: auth.users.
export const useRemoveStaffMember = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (staff_id: string) => {
      const { error } = await supabase.rpc("delete_staff_member", {
        p_staff_id: staff_id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Đã xoá nhân viên");
    },
    onError: (error: Error) => {
      toast.error(`Không xoá được: ${error.message}`);
    },
  });
};

// LƯU Ý: useApplyTemplate đã bị XOÁ — dead code chưa từng được gọi (flow áp
// mẫu thực tế: applyTemplateToDraft copy vào draft client-side → handleSave
// → useUpdateStaffMember re-snapshot + useUpdateStaffPermissions).

// =============================================================
// Lưu permissions tinh chỉnh per staff. UPDATE mọi row của staff
// cùng 1 JSONB (multi-building → multi-row nhưng cùng permissions).
// =============================================================
export const useUpdateStaffPermissions = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      staffId,
      permissions,
    }: {
      staffId: string;
      permissions: any;
    }) => {
      const { error } = await supabase
        .from("staff_assignments")
        .update({ permissions })
        .eq("staff_id", staffId);
      if (error) throw error;
      return { staffId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Đã lưu phân quyền");
    },
    onError: (e: Error) => toast.error(`Không lưu được: ${e.message}`),
  });
};

export const useDeleteStaffAssignment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("staff_assignments")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa phân quyền");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Phân quyền đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting staff assignment:", error);
    },
  });
};
