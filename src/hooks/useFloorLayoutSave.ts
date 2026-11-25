import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import type { FloorLayoutsMap } from '@/pages/phong-trong/floorLayoutShared';
import {
  FloorLayoutSaveError, saveEditedFloors, type FloorLayoutIo, type FloorLayoutSnapshot, type SaveEditedFloorsInput,
} from '@/components/sale-phong/floor-editor/floorLayoutSave';

function layoutsOf(value: Json | null | undefined): FloorLayoutsMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as unknown as FloorLayoutsMap : {};
}

/** Đọc/ghi `buildings.floor_layouts` kèm `updated_at`; ghi chỉ khi bản trên máy chủ chưa đổi. */
export const supabaseFloorLayoutIo: FloorLayoutIo = {
  async read(buildingId) {
    const { data, error } = await supabase.from('buildings').select('id, floor_layouts, updated_at')
      .eq('id', buildingId).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!data) throw new FloorLayoutSaveError('Không còn đọc được toà nhà này (đã xoá hoặc ngoài phạm vi được giao). Tải lại trang.', 'denied');
    return { floorLayouts: layoutsOf(data.floor_layouts), updatedAt: data.updated_at };
  },
  async writeIfUnchanged(buildingId, floorLayouts, expectedUpdatedAt) {
    const { data, error } = await supabase.from('buildings').update({ floor_layouts: floorLayouts as unknown as Json })
      .eq('id', buildingId).eq('updated_at', expectedUpdatedAt).select('id, floor_layouts, updated_at').maybeSingle();
    if (error) throw error;
    return data ? { floorLayouts: layoutsOf(data.floor_layouts), updatedAt: data.updated_at } : null;
  },
};

/** Lưu sơ đồ theo tầng đã sửa; đọc lại bản mới nhất khi người dùng chọn bỏ bản đang sửa. */
export function useFloorLayoutSave(io: FloorLayoutIo = supabaseFloorLayoutIo) {
  const queryClient = useQueryClient();
  const save = useMutation<FloorLayoutSnapshot, unknown, SaveEditedFloorsInput>({
    meta: { handlesFeedback: true },
    mutationFn: input => saveEditedFloors(io, input),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['buildings'] });
      void queryClient.invalidateQueries({ queryKey: ['my-available-rooms'] });
    },
  });
  return { save, readLatest: (buildingId: string) => io.read(buildingId) };
}
