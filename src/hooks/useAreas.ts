import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useEffect } from 'react';

// Types
export interface Area {
  id: string;
  code: string;
  name: string;
  description?: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
  buildings_count?: number;
}

export interface CreateAreaData {
  code: string;
  name: string;
  description?: string;
  status?: 'active' | 'inactive';
}

export interface UpdateAreaData {
  code?: string;
  name?: string;
  description?: string;
  status?: 'active' | 'inactive';
}

// Fetch all areas
export const useAreas = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['areas'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('areas')
        .select(`
          id,
          code,
          name,
          description,
          status,
          created_at,
          updated_at,
          buildings:buildings(count)
        `)
        .order('code', { ascending: true });

      if (error) throw error;

      // Transform the data to include buildings_count
      return data.map((area: any) => ({
        ...area,
        buildings_count: area.buildings?.[0]?.count || 0,
        buildings: undefined, // Remove the nested buildings object
      })) as Area[];
    },
  });

  // Set up real-time subscription
  useEffect(() => {
    const channel = supabase
      .channel('areas_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'areas',
        },
        () => {
          // Invalidate and refetch areas when any change occurs
          queryClient.invalidateQueries({ queryKey: ['areas'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return query;
};

// Create area
export const useCreateArea = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateAreaData) => {
      const { data: area, error } = await supabase
        .from('areas')
        .insert({
          code: data.code,
          name: data.name,
          description: data.description,
          status: data.status || 'active',
        })
        .select()
        .single();

      if (error) throw error;
      return area;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['areas'] });
      toast({
        title: 'Thành công',
        description: 'Đã tạo khu vực mới',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Lỗi',
        description: error.message || 'Không thể tạo khu vực',
        variant: 'destructive',
      });
    },
  });
};

// Update area
export const useUpdateArea = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateAreaData }) => {
      const { data: area, error } = await supabase
        .from('areas')
        .update(data)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return area;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['areas'] });
      toast({
        title: 'Thành công',
        description: 'Đã cập nhật khu vực',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Lỗi',
        description: error.message || 'Không thể cập nhật khu vực',
        variant: 'destructive',
      });
    },
  });
};

// Delete area
export const useDeleteArea = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('areas')
        .delete()
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['areas'] });
      toast({
        title: 'Thành công',
        description: 'Đã xóa khu vực',
      });
    },
    onError: (error: any) => {
      toast({
        title: 'Lỗi',
        description: error.message || 'Không thể xóa khu vực',
        variant: 'destructive',
      });
    },
  });
};
