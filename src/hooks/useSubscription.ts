import {readSubscriptionPlans,readUserSubscription} from '@/lib/accountJobReadModels';
import { requireAccountWriteReceipt } from "@/lib/accountSettingsWriteReceipt";
import { notifyActionError } from '@/lib/actionFeedback';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

/** Xuất ra để trang không phải tự suy kiểu gói cước từ `typeof plans`. */
export type SubscriptionPlan = Database["public"]["Tables"]["subscription_plans"]["Row"];
type UserSubscription = Database["public"]["Tables"]["user_subscriptions"]["Row"];
type UserSubscriptionInsert = Database["public"]["Tables"]["user_subscriptions"]["Insert"];
type UserSubscriptionUpdate = Database["public"]["Tables"]["user_subscriptions"]["Update"];

// Fetch all active subscription plans
export const useSubscriptionPlans = () => {
  return useQuery({
    queryKey: ["subscription_plans"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("*")
        .eq("is_active", true)
        .order("price", { ascending: true });

      if (error) {
        console.error("useSubscriptionPlans error:", error);
        throw error;
      }

      return readSubscriptionPlans(data);
    },
  });
};

// Fetch current user's subscription
export const useUserSubscription = () => {
  return useQuery({
    queryKey: ["user_subscriptions", "current"],
    queryFn: async () => {
      const user = await getSessionUser();

      if (!user) return null;

      const { data, error } = await supabase
        .from("user_subscriptions")
        .select(`
          *,
          plan:subscription_plans(*)
        `)
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        // maybeSingle(): 0 dòng trả data=null KHÔNG kèm lỗi → có lỗi là hỏng thật.
        console.error("useUserSubscription error:", error);
        throw error;
      }

      return readUserSubscription(data,user.id);
    },
  });
};

export const useCreateUserSubscription = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (subscription: Omit<UserSubscriptionInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("user_subscriptions")
        .insert({ ...subscription, user_id: user.id })
        .select("*, plan:subscription_plans(name)")
        .single();

      if (error) {
        throw error;
      }

      return requireAccountWriteReceipt(data, { ...subscription, user_id: user.id });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["user_subscriptions"] });
      toast.success(`Đã đăng ký gói “${data.plan?.name || data.plan_id}”.`);
    },
    onError: (error) => {
      notifyActionError(error, "Chưa xác nhận được kết quả đăng ký gói cước");
    },
  });
};

export const useUpdateUserSubscription = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: UserSubscriptionUpdate }) => {
      const { data, error } = await supabase
        .from("user_subscriptions")
        .update(updates)
        .eq("id", id)
        .select("*, plan:subscription_plans(name)")
        .single();

      if (error) {
        throw error;
      }

      return requireAccountWriteReceipt(data, { ...updates, id });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["user_subscriptions"] });
      toast.success(`Đã cập nhật gói “${data.plan?.name || data.plan_id}”.`);
    },
    onError: (error) => {
      notifyActionError(error, "Chưa xác nhận được kết quả cập nhật gói cước");
    },
  });
};

export const useCancelUserSubscription = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("user_subscriptions")
        .update({ status: "cancelled" })
        .eq("id", id)
        .select("*, plan:subscription_plans(name)")
        .single();

      if (error) {
        throw error;
      }

      return requireAccountWriteReceipt(data, { id, status: 'cancelled' });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["user_subscriptions"] });
      toast.success(`Đã hủy gói “${data.plan?.name || data.plan_id}”.`);
    },
    onError: (error) => {
      notifyActionError(error, "Chưa xác nhận được kết quả hủy gói cước");
    },
  });
};
