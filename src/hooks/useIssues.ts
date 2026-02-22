import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { toast } from "sonner";

type Issue = Database["public"]["Tables"]["issues"]["Row"];
type IssueInsert = Database["public"]["Tables"]["issues"]["Insert"];
type IssueUpdate = Database["public"]["Tables"]["issues"]["Update"];
type IssueComment = Database["public"]["Tables"]["issue_comments"]["Row"];
type IssueCommentInsert = Database["public"]["Tables"]["issue_comments"]["Insert"];
type IssueCategory = Database["public"]["Tables"]["issue_categories"]["Row"];

export interface IssueWithRelations extends Issue {
  category?: {
    id: string;
    name: string;
  };
  building?: {
    id: string;
    name: string;
  };
  room?: {
    id: string;
    name: string;
  };
  contract?: {
    id: string;
    contract_number: string | null;
  };
  reported_by_tenant?: {
    id: string;
    full_name: string;
  };
  reported_by_staff?: {
    id: string;
    full_name: string | null;
  };
  assigned_profile?: {
    id: string;
    full_name: string | null;
  };
}

export interface IssueCommentWithRelations extends IssueComment {
  profile?: {
    id: string;
    full_name: string | null;
  };
}

// Fetch all issues
export const useIssues = (filters?: {
  status?: string;
  priority?: string;
  category_id?: string;
  building_id?: string;
  assigned_to?: string;
}) => {
  return useQuery({
    queryKey: ["issues", filters],
    queryFn: async (): Promise<IssueWithRelations[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabase
        .from("issues")
        .select(`
          *,
          category:issue_categories!issues_category_id_fkey (
            id, name
          ),
          building:buildings!issues_building_id_fkey (
            id, name
          ),
          room:rooms!issues_room_id_fkey (
            id, name
          ),
          contract:contracts!issues_contract_id_fkey (
            id, contract_number
          ),
          reported_by_tenant:tenants!issues_reported_by_tenant_id_fkey (
            id, full_name
          ),
          reported_by_staff:profiles!issues_reported_by_staff_id_fkey (
            id, full_name
          ),
          assigned_profile:profiles!issues_assigned_to_fkey (
            id, full_name
          )
        `)
        .eq('user_id', user.id)
        .order("created_at", { ascending: false });

      if (filters?.status) {
        query = query.eq("status", filters.status);
      }
      if (filters?.priority) {
        query = query.eq("priority", filters.priority);
      }
      if (filters?.category_id) {
        query = query.eq("category_id", filters.category_id);
      }
      if (filters?.building_id) {
        query = query.eq("building_id", filters.building_id);
      }
      if (filters?.assigned_to) {
        query = query.eq("assigned_to", filters.assigned_to);
      }

      const { data, error } = await query;

      if (error) {
        toast.error("Không thể tải danh sách công việc");
        throw error;
      }

      return (data as IssueWithRelations[]) || [];
    },
  });
};

// Fetch single issue
export const useIssue = (id: string) => {
  return useQuery({
    queryKey: ["issues", id],
    queryFn: async (): Promise<IssueWithRelations> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("issues")
        .select(`
          *,
          category:issue_categories!issues_category_id_fkey (
            id, name
          ),
          building:buildings!issues_building_id_fkey (
            id, name
          ),
          room:rooms!issues_room_id_fkey (
            id, name
          ),
          contract:contracts!issues_contract_id_fkey (
            id, contract_number
          ),
          reported_by_tenant:tenants!issues_reported_by_tenant_id_fkey (
            id, full_name
          ),
          reported_by_staff:profiles!issues_reported_by_staff_id_fkey (
            id, full_name
          ),
          assigned_profile:profiles!issues_assigned_to_fkey (
            id, full_name
          )
        `)
        .eq("id", id)
        .eq('user_id', user.id)
        .single();

      if (error) {
        toast.error("Không thể tải thông tin công việc");
        throw error;
      }

      return data as IssueWithRelations;
    },
    enabled: !!id,
  });
};

// Create issue
export const useCreateIssue = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: IssueInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: issue, error } = await supabase
        .from("issues")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return issue;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi tạo công việc: " + error.message);
    },
  });
};

// Update issue
export const useUpdateIssue = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...data }: IssueUpdate & { id: string }) => {
      const { data: issue, error } = await supabase
        .from("issues")
        .update({
          ...data,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return issue;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi cập nhật công việc: " + error.message);
    },
  });
};

// Assign issue
export const useAssignIssue = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      assigned_to,
      due_date,
      estimated_cost,
    }: {
      id: string;
      assigned_to: string;
      due_date?: string;
      estimated_cost?: number;
    }) => {
      const { data: issue, error } = await supabase
        .from("issues")
        .update({
          assigned_to,
          assigned_at: new Date().toISOString(),
          due_date: due_date || null,
          estimated_cost: estimated_cost || null,
          status: 'ASSIGNED',
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return issue;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      toast.success("Dữ liệu đã được CẬP NHẬT thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi phân công: " + error.message);
    },
  });
};

// Fetch issue comments
export const useIssueComments = (issue_id?: string) => {
  return useQuery({
    queryKey: ["issue-comments", issue_id],
    queryFn: async (): Promise<IssueCommentWithRelations[]> => {
      if (!issue_id) return [];

      const { data, error } = await supabase
        .from("issue_comments")
        .select(`
          *,
          profile:profiles!issue_comments_user_id_fkey (
            id, full_name
          )
        `)
        .eq("issue_id", issue_id)
        .order("created_at", { ascending: true });

      if (error) {
        toast.error("Không thể tải bình luận");
        throw error;
      }

      return (data as IssueCommentWithRelations[]) || [];
    },
    enabled: !!issue_id,
  });
};

// Create comment
export const useCreateComment = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: IssueCommentInsert) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: comment, error } = await supabase
        .from("issue_comments")
        .insert({
          ...data,
          user_id: user.id,
        })
        .select()
        .single();

      if (error) throw error;

      // Update issue updated_at
      await supabase
        .from("issues")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", data.issue_id);

      return comment;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issue-comments"] });
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      toast.success("Dữ liệu đã được TẠO thành công");
    },
    onError: (error: Error) => {
      toast.error("Có lỗi xảy ra khi thêm bình luận: " + error.message);
    },
  });
};

// Fetch issue categories
export const useIssueCategories = () => {
  return useQuery({
    queryKey: ["issue-categories"],
    queryFn: async (): Promise<IssueCategory[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from("issue_categories")
        .select("*")
        .eq('user_id', user.id)
        .order("name");

      if (error) {
        toast.error("Không thể tải danh mục công việc");
        throw error;
      }

      return data || [];
    },
  });
};
