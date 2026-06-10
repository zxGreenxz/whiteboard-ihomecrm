import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { RoomWithRelations } from "@/types/room";
import { compareBuildingThenRoom } from "@/lib/roomSort";
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
          building:buildings(id, name, code)
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
        return [] as RoomWithRelations[];
      }

      // Sắp xếp theo toà nhà rồi tên phòng (MB* → G* → L* → 1,2,3,4...) — áp dụng
      // cho mọi nơi dùng useRooms: dropdown chọn phòng, sơ đồ toà nhà, danh sách...
      const rooms = (data || []) as unknown as RoomWithRelations[];
      return [...rooms].sort((a, b) =>
        compareBuildingThenRoom(
          a.building?.name ?? "",
          a.name ?? "",
          b.building?.name ?? "",
          b.name ?? "",
        ),
      );
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
          building:buildings(id, name, code)
        `)
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (error) {
        console.error('useRoom error:', error);
        return null;
      }

      return data as unknown as RoomWithRelations | null;
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
          toast.error("Mã căn hộ đã tồn tại");
        } else if (error.code === "23503") {
          toast.error("Tòa nhà không tồn tại");
        } else {
          toast.error("Không thể tạo căn hộ");
        }
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] }); // Update rooms count
      toast.success("Căn hộ đã được tạo thành công");
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
          toast.error("Mã căn hộ đã tồn tại");
        } else if (error.code === "23503") {
          toast.error("Tòa nhà không tồn tại");
        } else {
          toast.error("Không thể cập nhật căn hộ");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["rooms", data.id] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      toast.success("Căn hộ đã được cập nhật thành công");
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
      const { error } = await supabase
        .from("rooms")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) {
        toast.error("Không thể xóa căn hộ");
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      toast.success("Căn hộ đã được xóa thành công");
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
          toast.error("Một hoặc nhiều mã căn hộ đã tồn tại");
        } else {
          toast.error("Không thể tạo căn hộ hàng loạt");
        }
        throw error;
      }

      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      queryClient.invalidateQueries({ queryKey: ["buildings"] });
      toast.success(`Đã tạo thành công ${data.length} căn hộ`);
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
        toast.error("Không thể cập nhật trạng thái căn hộ");
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      toast.success("Trạng thái căn hộ đã được cập nhật thành công");
    },
    onError: (error) => {
      console.error("Error updating room status:", error);
    },
  });
};
