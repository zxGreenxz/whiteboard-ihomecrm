import { friendlyError } from "@/lib/friendlyError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";
import { nullIfNotFound } from "@/hooks/readErrors";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";

type Floor = Database["public"]["Tables"]["floors"]["Row"];
type FloorInsert = Database["public"]["Tables"]["floors"]["Insert"];
type FloorUpdate = Database["public"]["Tables"]["floors"]["Update"];

export const useFloors = (buildingId?: string) => {
  return useQuery({
    queryKey: ["floors", buildingId],
    queryFn: async () => {
      let query = supabase
        .from("floors")
        .select("*")
        .order("floor_number", { ascending: true });

      if (buildingId) {
        query = query.eq("building_id", buildingId);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useFloors error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new TypeError("Invalid category list response");
      return data;
    },
  });
};

export const useFloor = (id: string) => {
  return useQuery({
    queryKey: ["floors", "detail", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("floors")
        .select("*")
        .eq("id", id)
        .single();

      if (error) return nullIfNotFound(error, "useFloor");

      return data;
    },
    enabled: !!id,
  });
};

export const useCreateFloor = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (floor: Omit<FloorInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("floors")
        .insert(withOrg({ ...floor, user_id: user.id }, selectedOrganizationId))
        .select()
        .single();

      if (error) throw error;
      if (!data || typeof data.id !== "string" || !data.id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      toast.success(`Đã tạo tầng ${data.name || data.floor_number}.`);
    },
    onError: (error) => {
      console.error("Error creating floor:", error);
      if (options?.inlineError) return;
      const feedback = friendlyError(error, "Chưa tạo được tầng", { operation: "tạo tầng" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

export const useUpdateFloor = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: FloorUpdate }) => {
      const { data, error } = await supabase
        .from("floors")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data || data.id !== id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      toast.success(`Đã lưu thay đổi tầng ${data.name || data.floor_number}.`);
    },
    onError: (error) => {
      console.error("Error updating floor:", error);
      if (options?.inlineError) return;
      const feedback = friendlyError(error, "Chưa lưu thay đổi được tầng", { operation: "lưu thay đổi tầng" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};

export const useDeleteFloor = (options?: {inlineError?:boolean}) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("floors")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      if (!data || data.id !== id) throw new TypeError("Unconfirmed category result");

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      toast.success(`Đã xóa tầng ${data.name || data.floor_number}.`);
    },
    onError: (error) => {
      console.error("Error deleting floor:", error);
      if (options?.inlineError) return;
      const feedback = friendlyError(error, "Chưa xóa được tầng", { operation: "xóa tầng" });
      toast.error(feedback.title, { description: feedback.description });
    },
  });
};
