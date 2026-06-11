import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

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
        return [];
      }

      return data || [];
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

      if (error) {
        console.error("useFloor error:", error);
        return null;
      }

      return data;
    },
    enabled: !!id,
  });
};

export const useCreateFloor = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (floor: Omit<FloorInsert, "user_id">) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("floors")
        .insert({ ...floor, user_id: user.id })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Tầng này đã tồn tại trong toà nhà");
        } else {
          toast.error("Không thể tạo tầng");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      toast.success("Tầng đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating floor:", error);
    },
  });
};

export const useUpdateFloor = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: FloorUpdate }) => {
      const { data, error } = await supabase
        .from("floors")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Tầng này đã tồn tại trong toà nhà");
        } else {
          toast.error("Không thể cập nhật tầng");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      toast.success("Tầng đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating floor:", error);
    },
  });
};

export const useDeleteFloor = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("floors")
        .delete()
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa tầng");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["floors"] });
      toast.success("Tầng đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting floor:", error);
    },
  });
};
