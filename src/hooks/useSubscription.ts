import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type SubscriptionPlan = Database["public"]["Tables"]["subscription_plans"]["Row"];
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
        return [];
      }

      return data || [];
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
        console.error("useUserSubscription error:", error);
        return null;
      }

      return data;
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
        .select()
        .single();

      if (error) {
        toast.error("Không thể đăng ký gói cước");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user_subscriptions"] });
      toast.success("Gói cước đã được đăng ký thành công");
    },
    onError: (error) => {
      console.error("Error creating user subscription:", error);
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
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật gói cước");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user_subscriptions"] });
      toast.success("Gói cước đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating user subscription:", error);
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
        .select()
        .single();

      if (error) {
        toast.error("Không thể hủy gói cước");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user_subscriptions"] });
      toast.success("Gói cước đã được hủy thành công");
    },
    onError: (error) => {
      console.error("Error cancelling user subscription:", error);
    },
  });
};
