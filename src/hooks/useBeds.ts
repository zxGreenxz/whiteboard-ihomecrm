import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Bed = Database["public"]["Tables"]["beds"]["Row"];
type BedInsert = Database["public"]["Tables"]["beds"]["Insert"];
type BedUpdate = Database["public"]["Tables"]["beds"]["Update"];

// Fetch all beds (optionally filtered by room)
export const useBeds = (roomId?: string) => {
  return useQuery({
    queryKey: roomId ? ["beds", "room", roomId] : ["beds"],
    queryFn: async () => {
      let query = supabase
        .from("beds")
        .select(`
          *,
          room:rooms(id, name, code, building_id, floor)
        `)
        .is("deleted_at", null)
        .order("room_id", { ascending: true })
        .order("name", { ascending: true });

      if (roomId) {
        query = query.eq("room_id", roomId);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách giường");
        throw error;
      }

      return data || [];
    },
  });
};

// Fetch single bed by ID
export const useBed = (id: string) => {
  return useQuery({
    queryKey: ["beds", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("beds")
        .select(`
          *,
          room:rooms(id, name, code, building_id, floor)
        `)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin giường");
        throw error;
      }

      return data;
    },
    enabled: !!id,
  });
};

// Create new bed
export const useCreateBed = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (bed: BedInsert) => {
      const { data, error } = await supabase
        .from("beds")
        .insert(bed)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã giường đã tồn tại");
        } else if (error.code === "23503") {
          toast.error("Phòng không tồn tại");
        } else {
          toast.error("Không thể tạo giường");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["beds"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Tạo giường thành công");
    },
    onError: (error) => {
      console.error("Error creating bed:", error);
    },
  });
};

// Update existing bed
export const useUpdateBed = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: BedUpdate;
    }) => {
      const { data, error } = await supabase
        .from("beds")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã giường đã tồn tại");
        } else if (error.code === "23503") {
          toast.error("Phòng không tồn tại");
        } else {
          toast.error("Không thể cập nhật giường");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["beds"] });
      queryClient.invalidateQueries({ queryKey: ["beds", data.id] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Cập nhật giường thành công");
    },
    onError: (error) => {
      console.error("Error updating bed:", error);
    },
  });
};

// Soft delete bed
export const useDeleteBed = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Soft delete
      const { data, error } = await supabase
        .from("beds")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa giường");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["beds"] });
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Xóa giường thành công");
    },
    onError: (error) => {
      console.error("Error deleting bed:", error);
    },
  });
};
