import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Meter = Database["public"]["Tables"]["meters"]["Row"];
type MeterInsert = Database["public"]["Tables"]["meters"]["Insert"];
type MeterUpdate = Database["public"]["Tables"]["meters"]["Update"];

export const useMeters = (roomId?: string, meterType?: string) => {
  return useQuery({
    queryKey: ["meters", roomId, meterType],
    queryFn: async () => {
      let query = supabase
        .from("meters")
        .select("*")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      if (roomId) {
        query = query.eq("room_id", roomId);
      }
      if (meterType) {
        query = query.eq("meter_type", meterType);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useMeters error:", error);
        return [];
      }

      return data || [];
    },
  });
};

export const useMeter = (id: string) => {
  return useQuery({
    queryKey: ["meters", "detail", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("meters")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        console.error("useMeter error:", error);
        return null;
      }

      return data;
    },
    enabled: !!id,
  });
};

export const useCreateMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (meter: Omit<MeterInsert, "user_id">) => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("meters")
        .insert({ ...meter, user_id: user.id })
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã công tơ đã tồn tại");
        } else {
          toast.error("Không thể tạo công tơ");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      toast.success("Công tơ đã được tạo thành công");
    },
    onError: (error) => {
      console.error("Error creating meter:", error);
    },
  });
};

export const useUpdateMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: MeterUpdate }) => {
      const { data, error } = await supabase
        .from("meters")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã công tơ đã tồn tại");
        } else {
          toast.error("Không thể cập nhật công tơ");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      toast.success("Công tơ đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating meter:", error);
    },
  });
};

export const useDeleteMeter = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("meters")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa công tơ");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meters"] });
      toast.success("Công tơ đã được xóa thành công");
    },
    onError: (error) => {
      console.error("Error deleting meter:", error);
    },
  });
};
