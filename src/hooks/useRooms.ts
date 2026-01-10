import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Room = Database["public"]["Tables"]["rooms"]["Row"];
type RoomInsert = Database["public"]["Tables"]["rooms"]["Insert"];
type RoomUpdate = Database["public"]["Tables"]["rooms"]["Update"];

// Fetch all rooms (optionally filtered by building)
export const useRooms = (buildingId?: string) => {
  return useQuery({
    queryKey: buildingId ? ["rooms", "building", buildingId] : ["rooms"],
    queryFn: async () => {
      let query = supabase
        .from("rooms")
        .select(`
          *,
          building:buildings(id, name, code, area_id)
        `)
        .is("deleted_at", null)
        .order("building_id", { ascending: true })
        .order("floor", { ascending: true })
        .order("name", { ascending: true });

      if (buildingId) {
        query = query.eq("building_id", buildingId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('useRooms error:', error);
        return [];
      }

      return data || [];
    },
  });
};

// Fetch single room by ID
export const useRoom = (id: string) => {
  return useQuery({
    queryKey: ["rooms", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select(`
          *,
          building:buildings(id, name, code, area_id)
        `)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        console.error('useRoom error:', error);
        return null;
      }

      return data;
    },
    enabled: !!id,
  });
};

// Create new room
export const useCreateRoom = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (room: RoomInsert) => {
      const { data, error } = await supabase
        .from("rooms")
        .insert(room)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã phòng đã tồn tại");
        } else if (error.code === "23503") {
          toast.error("Tòa nhà không tồn tại");
        } else {
          toast.error("Không thể tạo phòng");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] }); // Update rooms count
      toast.success("Tạo phòng thành công");
    },
    onError: (error) => {
      console.error("Error creating room:", error);
    },
  });
};

// Update existing room
export const useUpdateRoom = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: RoomUpdate;
    }) => {
      const { data, error } = await supabase
        .from("rooms")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        if (error.code === "23505") {
          toast.error("Mã phòng đã tồn tại");
        } else if (error.code === "23503") {
          toast.error("Tòa nhà không tồn tại");
        } else {
          toast.error("Không thể cập nhật phòng");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["rooms", data.id] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      toast.success("Cập nhật phòng thành công");
    },
    onError: (error) => {
      console.error("Error updating room:", error);
    },
  });
};

// Soft delete room
export const useDeleteRoom = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Soft delete
      const { data, error } = await supabase
        .from("rooms")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể xóa phòng");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      toast.success("Xóa phòng thành công");
    },
    onError: (error) => {
      console.error("Error deleting room:", error);
    },
  });
};

// Bulk create rooms
export const useBulkCreateRooms = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (rooms: RoomInsert[]) => {
      const { data, error } = await supabase
        .from("rooms")
        .insert(rooms)
        .select();

      if (error) {
        if (error.code === "23505") {
          toast.error("Một hoặc nhiều mã phòng đã tồn tại");
        } else {
          toast.error("Không thể tạo phòng hàng loạt");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      toast.success(`Tạo thành công ${data.length} phòng`);
    },
    onError: (error) => {
      console.error("Error bulk creating rooms:", error);
    },
  });
};

// Update room status
export const useUpdateRoomStatus = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: Database["public"]["Enums"]["room_status"];
    }) => {
      const { data, error } = await supabase
        .from("rooms")
        .update({ status })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        toast.error("Không thể cập nhật trạng thái phòng");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Cập nhật trạng thái thành công");
    },
    onError: (error) => {
      console.error("Error updating room status:", error);
    },
  });
};
