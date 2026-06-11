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
        return [];
      }

      return data || [];
    },
  });
};

export const useCreateHotline = () => {
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

      if (error) {
        toast.error("Không thể tạo hotline");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hotlines"] });
      toast.success("Hotline đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating hotline:", error);
    },
  });
};

export const useUpdateHotline = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: HotlineUpdate }) => {
      const { data, error } = await supabase
        .from("hotlines")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật hotline");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hotlines"] });
      toast.success("Hotline đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating hotline:", error);
    },
  });
};

export const useDeleteHotline = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("hotlines")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa hotline");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hotlines"] });
      toast.success("Hotline đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting hotline:", error);
    },
  });
};
