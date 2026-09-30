import { salarySettingsErrorMessage } from "@/lib/salarySettingsFeedback";
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
  room_id: string | null;
  room_name: string | null;
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
    meta: {label:"cấu hình lương",errorDisplay:"inline"},
    queryFn: async () => {
      const { data: cfg , error: sourceError1 } = await (supabase
        .from("manager_salary_config")
        .select("*") as any)
        .order("created_at", { ascending: true });
      if (sourceError1) throw sourceError1;
      const rows = (cfg || []) as any[];
      const ids = rows.map((r) => r.staff_id);
      const nameById = new Map<string, string>();
      if (ids.length) {
        const { data: profs , error: sourceError2 } = await (supabase.from("profiles").select("id, full_name") as any).in("id", ids);
        if (sourceError2) throw sourceError2;
        for (const p of (profs || []) as any[]) nameById.set(p.id, p.full_name);
      }
      const roomIds = rows.map((r) => r.room_id).filter(Boolean);
      const roomNameById = new Map<string, string>();
      if (roomIds.length) {
        const { data: rms , error: sourceError3 } = await (supabase.from("rooms").select("id, name") as any).in("id", roomIds);
        if (sourceError3) throw sourceError3;
        for (const rm of (rms || []) as any[]) roomNameById.set(rm.id, rm.name);
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
        room_id: r.room_id ?? null,
        room_name: r.room_id ? (roomNameById.get(r.room_id) ?? null) : null,
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
  room_id?: string | null;
}

export const useSaveManagerConfig = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveManagerConfigInput) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      if (input.id) {
        const { data, error } = await supabase
          .from("manager_salary_config")
          .update({
            base_salary: input.base_salary,
            default_room_rent: input.default_room_rent,
            income_goal: input.income_goal ?? 0,
            role_title: input.role_title,
            alias: input.alias ?? null,
            room_id: input.room_id ?? null,
          })
          .eq("id", input.id).select("id").single();
        if (error) throw error;
        if (!data?.id) throw new TypeError("Unconfirmed salary config result");
      } else {
        if (!input.staff_id) throw new Error("Chưa chọn nhân viên");
        const { data, error } = await supabase.from("manager_salary_config").insert({
          user_id: user.id,
          staff_id: input.staff_id,
          base_salary: input.base_salary,
          default_room_rent: input.default_room_rent,
          income_goal: input.income_goal ?? 0,
          role_title: input.role_title,
          alias: input.alias ?? null,
          room_id: input.room_id ?? null,
        }).select("id").single();
        if (error) throw error;
        if (!data?.id) throw new TypeError("Unconfirmed salary config result");
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-config-list"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã lưu cấu hình quản lý");
    },
    onError: (error) => toast.error(salarySettingsErrorMessage(error,"lưu cấu hình nhân viên hưởng lương")),
  });
};

// Quy tắc thưởng (1 dòng/owner)
export const useBonusRules = () => {
  return useQuery({
    queryKey: ["salary-bonus-rules"],
    meta: {label:"cấu hình lương",errorDisplay:"inline"},
    queryFn: async () => {
      const { data , error: sourceError4 } = await (supabase.from("salary_bonus_rules").select("id, user_id, rules") as any).limit(1).maybeSingle();
      if (sourceError4) throw sourceError4;
      if (!data) return { id: null as string | null, rules: { ...DEFAULT_RULES } };
      // staffMonths sống chung trong jsonb `rules` nhưng KHÔNG thuộc SalaryRules —
      // tách ra để form quy tắc không lưu nhầm (xem useStaffMonthOverrides).
      const { staffMonths: _sm, ...rest } = ((data as any).rules || {}) as any;
      return { id: (data as any).id, rules: { ...DEFAULT_RULES, ...rest } as SalaryRules };
    },
  });
};

export const useSaveBonusRules = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rules: SalaryRules) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      const { data: existing , error: sourceError5 } = await (supabase.from("salary_bonus_rules").select("id, rules") as any).limit(1).maybeSingle();
      if (sourceError5) throw sourceError5;
      // GIỮ staffMonths (cài đặt tháng hiển thị) khi lưu lại quy tắc thưởng.
      const staffMonths = ((existing as any)?.rules?.staffMonths) || {};
      const merged = { ...rules, staffMonths };
      if (existing?.id) {
        const { data: saved, error } = await supabase.from("salary_bonus_rules").update({ rules: merged }).eq("id", (existing as any).id).select("id").single();
        if (error) throw error;
        if (!saved?.id) throw new TypeError("Unconfirmed salary rules result");
      } else {
        const { data: saved, error } = await supabase.from("salary_bonus_rules").insert({ user_id: user.id, rules: merged }).select("id").single();
        if (error) throw error;
        if (!saved?.id) throw new TypeError("Unconfirmed salary rules result");
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-bonus-rules"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast.success("Đã lưu quy tắc thưởng");
    },
    onError: (error) => toast.error(salarySettingsErrorMessage(error,"lưu quy tắc thưởng")),
  });
};

// Ngày lễ
export const useSalaryHolidays = () => {
  return useQuery({
    queryKey: ["salary-holidays"],
    meta: {label:"cấu hình lương",errorDisplay:"inline"},
    queryFn: async () => {
      const { data , error: sourceError6 } = await (supabase
        .from("salary_holidays")
        .select("id, holiday_date, name") as any)
        .order("holiday_date", { ascending: true });
      if (sourceError6) throw sourceError6;
      return ((data || []) as any[]).map((h) => ({ id: h.id, holiday_date: h.holiday_date, name: h.name as string | null }));
    },
  });
};

export const useAddHoliday = (options: {silent?:boolean} = {}) => {
  const qc = useQueryClient();
  return useMutation({
    meta:{silent:options.silent},
    mutationFn: async ({ holiday_date, name }: { holiday_date: string; name?: string }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      const { data, error } = await supabase.from("salary_holidays").insert({ user_id: user.id, holiday_date, name: name ?? null }).select("id").single();
      if (error) throw error;
      if (!data?.id) throw new TypeError("Unconfirmed holiday result");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-holidays"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      if(!options.silent) toast.success("Đã thêm ngày lễ.");
    },
    onError: (error) => {if(!options.silent) toast.error(salarySettingsErrorMessage(error,"thêm ngày lễ"));},
  });
};

export const useDeleteHoliday = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await (supabase.from("salary_holidays").delete() as any).eq("id", id).select("id");
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },
    onError: (error) => toast.error(salarySettingsErrorMessage(error,"xóa ngày lễ")),
    onSuccess: (changed) => {
      qc.invalidateQueries({ queryKey: ["salary-holidays"] });
      qc.invalidateQueries({ queryKey: ["manager-salary"] });
      toast[changed?"success":"info"](changed?"Đã xóa ngày lễ.":"Ngày lễ không còn trong danh sách hoặc không thuộc phạm vi được sửa. Danh sách đã được tải lại.");
    },
  });
};

// ===== Tháng hiển thị cho nhân viên (admin) =====
// Override hiện/ẩn từng tháng cho self-view: 'YYYY-MM' → bool. Lưu trong
// salary_bonus_rules.rules.staffMonths (chủ sổ ghi; staff đọc map qua RPC).

export const useStaffMonthOverrides = () => {
  return useQuery({
    queryKey: ["salary-staff-months"],
    meta: {label:"cấu hình lương",errorDisplay:"inline"},
    queryFn: async () => {
      const { data , error: sourceError7 } = await (supabase.from("salary_bonus_rules").select("rules") as any).limit(1).maybeSingle();
      if (sourceError7) throw sourceError7;
      return (((data as any)?.rules?.staffMonths) || {}) as Record<string, boolean>;
    },
  });
};

// Đặt/huỷ override 1 tháng. value=null → xoá override (về mặc định lùi-tháng).
export const useSaveStaffMonthOverride = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ym, value }: { ym: string; value: boolean | null }) => {
      const user = await getSessionUser();
      if (!user) throw new Error("Chưa đăng nhập");
      const { data: row , error: sourceError8 } = await (supabase.from("salary_bonus_rules").select("id, rules") as any).limit(1).maybeSingle();
      if (sourceError8) throw sourceError8;
      const rules: any = { ...((row as any)?.rules || {}) };
      const sm: Record<string, boolean> = { ...(rules.staffMonths || {}) };
      if (value === null) delete sm[ym]; else sm[ym] = value;
      rules.staffMonths = sm;
      if ((row as any)?.id) {
        const { data: saved, error } = await supabase.from("salary_bonus_rules").update({ rules }).eq("id", (row as any).id).select("id").single();
        if (error) throw error;
        if (!saved?.id) throw new TypeError("Unconfirmed salary rules result");
      } else {
        const { data: saved, error } = await supabase.from("salary_bonus_rules").insert({ user_id: user.id, rules }).select("id").single();
        if (error) throw error;
        if (!saved?.id) throw new TypeError("Unconfirmed salary rules result");
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-staff-months"] });
      qc.invalidateQueries({ queryKey: ["salary-staff-month"] });
    },
    onError: (error) => toast.error(salarySettingsErrorMessage(error,"đổi tháng hiển thị cho nhân viên")),
  });
};

// Tập các tháng ('YYYY-MM') đã CHỐT (đọc bởi chủ sổ — để admin biết mốc auto).
export const useSalaryLockedMonths = () => {
  return useQuery({
    queryKey: ["salary-locked-months"],
    meta: {label:"cấu hình lương",errorDisplay:"inline"},
    queryFn: async () => {
      const { data , error: sourceError9 } = await (supabase.from("salary_monthly").select("period_month, status") as any).eq("status", "LOCKED");
      if (sourceError9) throw sourceError9;
      return new Set<string>(((data || []) as any[]).map((r) => String(r.period_month).slice(0, 7)));
    },
  });
};
