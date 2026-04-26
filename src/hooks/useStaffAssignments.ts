import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
          building:buildings(id, name)
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
          building:buildings(id, name)
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
      const {
        data: { user },
      } = await supabase.auth.getUser();

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
  /** null/undefined = quản lý tất cả toà nhà (1 row, building_id=null).
   *  Empty array = same as null. Otherwise insert one row per id. */
  building_ids?: string[] | null;
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
 *  We always go through the slug → @username.ihomecrm.local channel so
 *  the same input maps to the same account no matter the casing/diacritics. */
const buildAuthEmail = (input: ProvisionStaffInput): string => {
  const slug = slugifyUsername(input.username);
  return `${slug}@username.ihomecrm.local`;
};

export const useProvisionStaff = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ProvisionStaffInput) => {
      // Save admin session BEFORE signUp. supabase.auth.signUp() auto-switches
      // the client session to the newly-created user, which would make every
      // subsequent profile-upsert / staff_assignment-insert run as the new
      // (un-privileged) user → RLS 403, then on retry "User already registered"
      // 422, and an orphan auth row stuck in the database.
      const { data: { session: adminSession } } = await supabase.auth.getSession();
      if (!adminSession) throw new Error("Bạn chưa đăng nhập");
      const owner = adminSession.user;

      const authEmail = buildAuthEmail(input);

      const { data: signUp, error: signUpErr } = await supabase.auth.signUp({
        email: authEmail,
        password: input.password,
        options: {
          data: {
            username: input.username,
            full_name: input.full_name || input.username,
            phone: input.phone || null,
            email: input.email || null,
            employee_code: input.employee_code || null,
            department: input.department || null,
            job_title: input.job_title || null,
          },
        },
      });

      // Restore admin session IMMEDIATELY — even on signUp error, because the
      // client may already have partially switched.
      await supabase.auth.setSession({
        access_token: adminSession.access_token,
        refresh_token: adminSession.refresh_token,
      });

      if (signUpErr) {
        if (/already registered|duplicate/i.test(signUpErr.message)) {
          throw new Error(`Tên đăng nhập "${input.username}" đã được sử dụng. Vui lòng chọn tên khác.`);
        }
        throw signUpErr;
      }
      const newUserId = signUp.user?.id;
      if (!newUserId) throw new Error("Không tạo được tài khoản — kiểm tra lại tên đăng nhập");

      // upsert profile (the auth trigger usually inserts a stub — we override with full data).
      // First try with extended columns; if any column doesn't exist yet (migration
      // 20260427_apply_staff_profile_fields.sql not applied), retry with the base set.
      const baseProfile = {
        id: newUserId,
        full_name: input.full_name || input.username,
        phone: input.phone || null,
        email: input.email || null,
      };
      const extendedProfile = {
        ...baseProfile,
        department: input.department || null,
        job_title: input.job_title || null,
        employee_code: input.employee_code || null,
        is_active: input.is_active ?? true,
      };
      const tryExt = await supabase
        .from("profiles")
        .upsert(extendedProfile as any, { onConflict: "id" });
      if (tryExt.error) {
        console.warn("profile upsert with extended columns failed; retrying base:", tryExt.error.message);
        const fallback = await supabase
          .from("profiles")
          .upsert(baseProfile as any, { onConflict: "id" });
        if (fallback.error) {
          console.warn("profile upsert (base) also failed:", fallback.error.message);
        }
      }

      const buildingIds = (input.building_ids && input.building_ids.length > 0)
        ? input.building_ids
        : [null]; // null = "tất cả toà nhà"

      const rowsToInsert = buildingIds.map((bid) => ({
        user_id: owner.id,
        staff_id: newUserId,
        role_id: input.role_id,
        building_id: bid,
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
  building_ids?: string[] | null; // null/empty → all buildings (single row, building_id=null)
  profile_patch?: {
    full_name?: string;
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
      const { data: { user: owner } } = await supabase.auth.getUser();
      if (!owner) throw new Error("Bạn chưa đăng nhập");

      // 1) Sync profile fields (gracefully degrade if extended cols missing)
      if (input.profile_patch) {
        const tryExt = await supabase
          .from("profiles")
          .update(input.profile_patch as any)
          .eq("id", input.staff_id);
        if (tryExt.error) {
          const baseOnly: any = {};
          if (input.profile_patch.full_name !== undefined) baseOnly.full_name = input.profile_patch.full_name;
          if (Object.keys(baseOnly).length > 0) {
            await supabase.from("profiles").update(baseOnly).eq("id", input.staff_id);
          }
        }
      }

      // 2) Fetch existing assignments for this staff
      const { data: existing, error: fetchErr } = await supabase
        .from("staff_assignments")
        .select("id, building_id, role_id")
        .eq("staff_id", input.staff_id);
      if (fetchErr) throw fetchErr;

      const wantBuildings: (string | null)[] = (input.building_ids && input.building_ids.length > 0)
        ? input.building_ids
        : [null];

      const have = new Map<string, { id: string; role_id: string }>();
      for (const r of existing || []) {
        // Use a sentinel for null building_id
        const key = r.building_id ?? "__null__";
        have.set(key, { id: r.id, role_id: r.role_id });
      }
      const want = new Set(wantBuildings.map((b) => b ?? "__null__"));

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

      // 4) Update role_id on rows we're keeping (if role changed)
      const toUpdateIds: string[] = [];
      for (const [key, val] of have.entries()) {
        if (want.has(key) && val.role_id !== input.role_id) toUpdateIds.push(val.id);
      }
      if (toUpdateIds.length > 0) {
        const { error } = await supabase
          .from("staff_assignments")
          .update({ role_id: input.role_id })
          .in("id", toUpdateIds);
        if (error) throw error;
      }

      // 5) Insert missing rows
      const toInsert = wantBuildings
        .filter((b) => !have.has(b ?? "__null__"))
        .map((b) => ({
          user_id: owner.id,
          staff_id: input.staff_id,
          role_id: input.role_id,
          building_id: b,
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

// Remove an entire staff member (deletes all assignments for that staff_id).
export const useRemoveStaffMember = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (staff_id: string) => {
      const { error } = await supabase
        .from("staff_assignments")
        .delete()
        .eq("staff_id", staff_id);
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
