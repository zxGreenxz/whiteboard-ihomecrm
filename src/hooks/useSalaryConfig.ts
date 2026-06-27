import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";

export interface ManagerConfigRow {
  id: string;
  staff_id: string;
  full_name: string;
  base_salary: number;
  default_room_rent: number;
  income_goal: number;
  role_title: string;
  alias: string | null;
  is_active: boolean;
}

export interface SalaryRules {
  repair: number;
  weekendRepair: number;
  afterHourContract: number;
  afterHourMark: string;
  weekendDays: number[];
  requirePhoto: boolean;
}

const DEFAULT_RULES: SalaryRules = {
  repair: 30000, weekendRepair: 20000, afterHourContract: 50000,
  afterHourMark: "18:00", weekendDays: [0], requirePhoto: false,
};

// Danh sách quản lý hưởng lương (kèm tên) cho tab Cấu hình
export const useSalaryConfigList = () => {
  return useQuery<ManagerConfigRow[]>({
    queryKey: ["salary-config-list"],
    queryFn: async () => {
      const { data: cfg } = await (supabase
        .from("manager_salary_config" as any)
        .select("*") as any)
        .order("created_at", { ascending: true });
      const rows = (cfg || []) as any[];
      const ids = rows.map((r) => r.staff_id);
      const nameById = new Map<string, string>();
      if (ids.length) {
        const { data: profs } = await (supabase.from("profiles" as any).select("id, full_name") as any).in("id", ids);
        for (const p of (profs || []) as any[]) nameById.set(p.id, p.full_name);
      }
      return rows.map((r) => ({
        id: r.id,
        staff_id: r.staff_id,
        full_name: nameById.get(r.staff_id) || r.alias || "Quản lý",
        base_salary: Number(r.base_salary) || 0,
        default_room_rent: Number(r.default_room_rent) || 0,
        income_goal: Number(r.income_goal) || 0,
        role_title: r.role_title || "Quản lý vận hành",
        alias: r.alias,
        is_active: !!r.is_active,
      }));
    },
  });
};

export interface SaveManagerConfigInput {
  id?: string;
  staff_id?: string;
  base_salary: number;
  default_room_rent: number;
  income_goal?: number;
  role_title: string;
  alias?: string | null;
}

export const useSaveManagerConfig = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveManagerConfigInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      if (input.id) {
        const { error } = await supabase
          .from("manager_salary_config" as any)
          .update({
            base_salary: input.base_salary,
            default_room_rent: input.default_room_rent,
            income_goal: input.income_goal ?? 0,
            role_title: input.role_title,
            alias: input.alias ?? null,
          })
          .eq("id", input.id);
        if (error) throw error;
      } else {
        if (!input.staff_id) throw new Error("Chưa chọn nhân viên");
        const { error } = await supabase.from("manager_salary_config" as any).insert({
          user_id: user.id,
          staff_id: input.staff_id,
          base_salary: input.base_salary,
          default_room_rent: input.default_room_rent,
          income_goal: input.income_goal ?? 0,
          role_title: input.role_title,
          alias: input.alias ?? null,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-config-list"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã lưu cấu hình quản lý");
    },
    onError: (e: any) => toast.error(e?.message || "Không thể lưu"),
  });
};

// Quy tắc thưởng (1 dòng/owner)
export const useBonusRules = () => {
  return useQuery({
    queryKey: ["salary-bonus-rules"],
    queryFn: async () => {
      const { data } = await (supabase.from("salary_bonus_rules" as any).select("id, user_id, rules") as any).limit(1).maybeSingle();
      if (!data) return { id: null as string | null, rules: { ...DEFAULT_RULES } };
      return { id: (data as any).id, rules: { ...DEFAULT_RULES, ...((data as any).rules || {}) } as SalaryRules };
    },
  });
};

export const useSaveBonusRules = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rules: SalaryRules) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      const { data: existing } = await (supabase.from("salary_bonus_rules" as any).select("id") as any).limit(1).maybeSingle();
      if (existing?.id) {
        const { error } = await supabase.from("salary_bonus_rules" as any).update({ rules }).eq("id", (existing as any).id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("salary_bonus_rules" as any).insert({ user_id: user.id, rules });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-bonus-rules"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã lưu quy tắc thưởng");
    },
    onError: (e: any) => toast.error(e?.message || "Không thể lưu quy tắc"),
  });
};

// Ngày lễ
export const useSalaryHolidays = () => {
  return useQuery({
    queryKey: ["salary-holidays"],
    queryFn: async () => {
      const { data } = await (supabase
        .from("salary_holidays" as any)
        .select("id, holiday_date, name") as any)
        .order("holiday_date", { ascending: true });
      return ((data || []) as any[]).map((h) => ({ id: h.id, holiday_date: h.holiday_date, name: h.name as string | null }));
    },
  });
};

export const useAddHoliday = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ holiday_date, name }: { holiday_date: string; name?: string }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      const { error } = await supabase.from("salary_holidays" as any).insert({ user_id: user.id, holiday_date, name: name ?? null });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-holidays"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã thêm ngày lễ");
    },
    onError: (e: any) => toast.error(e?.message || "Không thể thêm"),
  });
};

export const useDeleteHoliday = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase.from("salary_holidays" as any).delete() as any).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-holidays"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã xoá ngày lễ");
    },
  });
};
