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
  full_name: string;
  phone: string;          // required
  email?: string;         // optional
  username?: string;      // optional — used if no email/phone (Resident allows free-form)
  password: string;
  role_id: string;
  building_id?: string | null;  // null = quản lý tất cả toà nhà
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

const buildAuthEmail = (input: ProvisionStaffInput): string => {
  if (input.email && input.email.includes('@')) return input.email.trim();
  const phone = (input.phone || '').replace(/[^0-9]/g, '');
  if (/^[0-9]{10,11}$/.test(phone)) return `${phone}@phone.ihomecrm.local`;
  const slug = slugifyUsername(input.username || input.full_name || 'user');
  return `${slug}@username.ihomecrm.local`;
};

export const useProvisionStaff = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ProvisionStaffInput) => {
      const {
        data: { user: owner },
      } = await supabase.auth.getUser();
      if (!owner) throw new Error("Bạn chưa đăng nhập");

      const authEmail = buildAuthEmail(input);

      const { data: signUp, error: signUpErr } = await supabase.auth.signUp({
        email: authEmail,
        password: input.password,
        options: {
          data: {
            full_name: input.full_name,
            phone: input.phone || null,
            email: input.email || null,
            employee_code: input.employee_code || null,
            department: input.department || null,
            job_title: input.job_title || null,
          },
        },
      });
      if (signUpErr) throw signUpErr;
      const newUserId = signUp.user?.id;
      if (!newUserId) throw new Error("Không tạo được tài khoản — kiểm tra email/SĐT");

      // upsert profile (the auth trigger usually inserts a stub — we override with full data).
      // First try with extended columns; if any column doesn't exist yet (migration
      // 20260427_apply_staff_profile_fields.sql not applied), retry with the base set.
      const baseProfile = {
        id: newUserId,
        full_name: input.full_name,
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

      const { data: assignment, error: assignErr } = await supabase
        .from("staff_assignments")
        .insert({
          user_id: owner.id,
          staff_id: newUserId,
          role_id: input.role_id,
          building_id: input.building_id || null,
        })
        .select()
        .single();
      if (assignErr) throw assignErr;

      return assignment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff_assignments"] });
      toast.success("Đã tạo tài khoản nhân viên thành công");
    },
    onError: (error: Error) => {
      const msg = /already registered|duplicate/i.test(error.message)
        ? "Email/SĐT đã được đăng ký trước đó"
        : error.message;
      toast.error(`Không tạo được nhân viên: ${msg}`);
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
