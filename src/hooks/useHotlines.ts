import { friendlyError } from "@/lib/friendlyError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Hotline = Database["public"]["Tables"]["hotlines"]["Row"];
type HotlineInsert = Database["public"]["Tables"]["hotlines"]["Insert"];
type HotlineUpdate = Database["public"]["Tables"]["hotlines"]["Update"];

export const useHotlines = () => {
  return useQuery({
    queryKey: ["hotlines"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("hotlines")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("useHotlines error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new TypeError("Invalid category list response");
      return data;
    },
  });
};

export const useCreateHotline = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (hotline: Omit<HotlineInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("hotlines")
        .insert({ ...hotline, user_id: user.id })
        .select()
        .single();

      if (error) throw error;
      if (!data || typeof data.id !== "string" || !data.id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["hotlines"] });
      toast.success(`Đã tạo hotline ${data.name}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error creating hotline:", error);
      const feedback = friendlyError(error, "Chưa tạo được hotline", { operation: "tạo hotline" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

export const useUpdateHotline = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: HotlineUpdate }) => {
      const { data, error } = await supabase
        .from("hotlines")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data || data.id !== id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["hotlines"] });
      toast.success(`Đã lưu thay đổi hotline ${data.name}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error updating hotline:", error);
      const feedback = friendlyError(error, "Chưa lưu thay đổi được hotline", { operation: "lưu thay đổi hotline" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

export const useDeleteHotline = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("hotlines")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data || data.id !== id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["hotlines"] });
      toast.success(`Đã xóa hotline ${data.name}.`);
    },
    onError: (error) => {
      if (options?.inlineError) return;
      console.error("Error deleting hotline:", error);
      const feedback = friendlyError(error, "Chưa xóa được hotline", { operation: "xóa hotline" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};
