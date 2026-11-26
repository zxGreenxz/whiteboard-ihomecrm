function feedbackRecordName(value:unknown,fallback?:string):string {
 const row=value&&typeof value==='object'?value as {name?:unknown;id?:unknown}:null;
 return typeof row?.name==='string'&&row.name.trim()?row.name: fallback?.trim()||(typeof row?.id==='string'?row.id:'bản ghi');
}
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { confirmedRecordId, confirmedRecordBatch, recordWriteBlocked, recordWriteMessage, repeatableWrite, settleZeroRowDelete } from '@/lib/recordWriteOutcome';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import { friendlyError } from "@/lib/friendlyError";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg } from "@/lib/orgPayload";

export class TemplateDefaultPartialError extends Error {
  constructor(public readonly templateId: string, public readonly previousDefaultIds: readonly string[], public readonly cause: unknown) {
    super(`Các mẫu mặc định trước đã được bỏ chọn, nhưng chưa xác nhận được mẫu ${templateId} làm mặc định. Tải lại danh sách mẫu để đối chiếu trước khi chọn tiếp.`);
    this.name = "TemplateDefaultPartialError";
  }
}

// --- Types ---

export interface IncomeExpenseTemplate {
  id: string;
  user_id: string;
  code: string;
  name: string;
  description: string | null;
  template_file_url: string | null;
  is_default: boolean;
  is_income_template: boolean;
  field_mappings: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

// --- Query Hooks ---

export const useIncomeExpenseTemplates = (filterIsIncome?: boolean) => {
  return useQuery({
    queryKey: ["income-expense-templates", filterIsIncome],
    queryFn: async (): Promise<IncomeExpenseTemplate[]> => {
      let query = supabase
        .from("income_expense_templates")
        .select("*")
        .is("deleted_at", null)
        .order("name", { ascending: true });

      if (filterIsIncome !== undefined) {
        query = query.eq("is_income_template", filterIsIncome);
      }

      const { data, error } = await query;

      if (error) {
        console.error("useIncomeExpenseTemplates error:", error);
        throw error;
      }

      if (!Array.isArray(data)) throw new Error('Chưa xác nhận được danh sách mẫu in thu chi. Tải lại trước khi chọn.');
      return data as unknown as IncomeExpenseTemplate[];
    },
  });
};

// --- Mutation Hooks ---

export const useCreateIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();

  return useMutation({
    mutationFn: async (input: {
      name: string;
      description?: string | null;
      template_file_url?: string | null;
      is_default?: boolean;
      is_income_template?: boolean;
      field_mappings?: Record<string, string> | null;
    }) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      return persistentFinancialWorkflow('income-expense-template-create').run('create', 'tạo mẫu in thu chi', async () => {
      const { data, error } = await supabase
        .from("income_expense_templates")
        .insert(withOrg({
          user_id: user.id,
          name: input.name,
          description: input.description ?? null,
          template_file_url: input.template_file_url ?? null,
          is_default: input.is_default ?? false,
          is_income_template: input.is_income_template ?? false,
          field_mappings: input.field_mappings ?? null,
        }, selectedOrganizationId))
        .select()
        .single();

      if (error) {
        throw error;
      }

      confirmedRecordId(data, 'tạo mẫu in thu chi');
      return data;
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      toast.success(`Đã tạo mẫu in thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({queryKey:['income-expense-templates']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa tạo mẫu in thu chi',{description:recordWriteMessage(error,'tạo mẫu in thu chi')});return;}
      const feedback = friendlyError(error, "Chưa tạo được mẫu in thu chi", { operation: "tạo mẫu in thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error creating income expense template:", error);
    },
  });
};

export const useUpdateIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: {
        name?: string;
        description?: string | null;
        template_file_url?: string | null;
        is_default?: boolean;
        is_income_template?: boolean;
        field_mappings?: Record<string, string> | null;
      };
    }) => {
      // Đợt 8 (luật 5): sửa theo mã, đặt giá trị tuyệt đối ⇒ lưu lại cho cùng kết quả, không giữ dấu nào. Khớp 0 dòng
      // (PGRST116: RLS, mẫu đã xoá) là chưa ghi gì: lời từ chối rõ, đi nguyên.
      const data = await repeatableWrite('cập nhật mẫu in thu chi', async () => {
        const { data, error } = await supabase
          .from("income_expense_templates")
          .update(updates)
          .eq("id", id)
          .select()
          .single();

        if (error) throw error;
        confirmedRecordId(data, 'cập nhật mẫu in thu chi', id);
        return data;
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'income-expense-template-update', businessKey: id }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần lưu sau gỡ lại. */ }
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      toast.success(`Đã cập nhật mẫu in thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({queryKey:['income-expense-templates']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa cập nhật mẫu in thu chi',{description:recordWriteMessage(error,'cập nhật mẫu in thu chi')});return;}
      const feedback = friendlyError(error, "Chưa cập nhật được mẫu in thu chi", { operation: "cập nhật mẫu in thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error updating income expense template:", error);
    },
  });
};

export const useDeleteIncomeExpenseTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // Đợt 8 (luật 5): xoá mềm theo mã, không giữ dấu nào. Chỉ đóng dấu giờ xoá cho mẫu còn sống, nên lần xoá lại không
      // ghi đè giờ xoá của lần trước. Khớp 0 dòng (PGRST116) thì đọc lại đúng mẫu đó: đã có giờ xoá (hoặc không còn thấy)
      // ⇒ đã xoá trước đó (báo thành công); còn sống ⇒ RLS không cho xoá (từ chối rõ).
      const deleted = await repeatableWrite('xoá mẫu in thu chi', async (): Promise<unknown> => {
        const { data, error } = await supabase
          .from("income_expense_templates")
          .update({ deleted_at: new Date().toISOString() })
          .eq("id", id).is('deleted_at', null).select('id,name').single();

        if (error) {
          if ((error as { code?: unknown }).code !== 'PGRST116') throw error;
          await settleZeroRowDelete('xoá mẫu in thu chi', () => supabase.from('income_expense_templates').select('id,name,deleted_at').eq('id', id));
          return { id, alreadyDeleted: true };
        }
        confirmedRecordId(data, 'xoá mẫu in thu chi', id);
        return data;
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'income-expense-template-delete', businessKey: id }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần xoá sau gỡ lại. */ }
      return deleted;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      if ((data as { alreadyDeleted?: unknown } | null)?.alreadyDeleted === true) {
        toast.success('Mẫu in thu chi này đã được xoá ở lần gửi trước (hoặc bởi người khác). Không còn gì để xoá thêm.');
        return;
      }
      toast.success(`Đã xóa mẫu in thu chi ${feedbackRecordName(data)}`);
    },
    onError: (error) => {
      queryClient.invalidateQueries({queryKey:['income-expense-templates']});
      if(error instanceof FinancialWorkflowError) {toast.error('Chưa xoá mẫu in thu chi',{description:recordWriteMessage(error,'xoá mẫu in thu chi')});return;}
      const feedback = friendlyError(error, "Chưa xóa được mẫu in thu chi", { operation: "xóa mẫu in thu chi" });
      toast.error(feedback.title, { description: feedback.description });
      console.error("Error deleting income expense template:", error);
    },
  });
};

export const useToggleDefaultTemplate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      is_default,
      is_income_template,
    }: {
      id: string;
      is_default: boolean;
      is_income_template: boolean;
    }) => {
      const user = await getSessionUser();

      if (!user) throw new Error("User not authenticated");

      // Đợt 8 (luật 5): chọn / bỏ chọn mẫu mặc định là thiết lập, không phải tiền, và có ĐÍCH tuyệt đối (đúng mẫu này là
      // mặc định duy nhất của nhóm, hoặc mẫu này không mặc định). Mỗi lần bấm đọc lại nhóm mẫu rồi chỉ làm phần còn thiếu:
      // lần trước đã tới đích ⇒ không ghi gì; dở dang (đã bỏ mẫu cũ, chưa đặt mẫu mới) ⇒ chỉ đặt mẫu mới. Không giữ dấu
      // «chờ đối chiếu» nào; dấu bản trước (phạm vi người dùng, khoá `default:<nhóm>`) được gỡ sau khi xong. Khoá «ý định»
      // `ihome:template-default-intent:v1:*` của bản trước không còn ai đọc nên không chặn gì (dọn ở đợt 11).
      const saved = await repeatableWrite('đổi mẫu in mặc định', async () => {
        const {data: group, error: readError} = await supabase.from('income_expense_templates').select('*')
          .eq('user_id', user.id).eq('is_income_template', is_income_template).is('deleted_at', null);
        if(readError) throw readError;
        if(!Array.isArray(group) || group.some(row => !row || typeof row.id !== 'string' || !row.id || typeof row.is_default !== 'boolean' || row.user_id !== user.id || row.is_income_template !== is_income_template) || new Set(group.map(row=>row.id)).size !== group.length) throw new FinancialWorkflowError('Chưa tải đủ mẫu in cùng loại. Tải lại trước khi chọn mặc định.', 'failure', []);
        const rows = group as unknown as IncomeExpenseTemplate[];
        const target = rows.find(row => row.id === id);
        // Bước chuẩn bị chưa ghi gì: mẫu đích không còn trong nhóm thì dừng TRƯỚC khi bỏ chọn mẫu khác.
        if(!target) throw new FinancialWorkflowError(`Mẫu ${id} không còn trong danh sách mẫu ${is_income_template ? 'thu' : 'chi'} của bạn (đã xoá hoặc không thuộc bạn). Tải lại danh sách mẫu rồi chọn lại; chưa đổi mẫu mặc định nào.`, 'failure', []);
        const others = is_default ? rows.filter(row => row.id !== id && row.is_default).map(row => row.id) : [];
        if(target.is_default === is_default && !others.length) return {...target, unchanged: true};
        if(others.length) {
          const {data:unset,error:unsetError}=await supabase.from('income_expense_templates').update({is_default:false})
            .eq('user_id',user.id).eq('is_income_template',is_income_template).in('id',others).is('deleted_at',null).select('id, is_default');
          if(unsetError) throw unsetError;
          const ids=confirmedRecordBatch(unset,others.length,'bỏ mẫu mặc định trước');
          if(ids.some(savedId=>!others.includes(savedId)) || (unset as Array<{is_default:unknown}>).some(row=>row.is_default!==false)) throw new FinancialWorkflowError('Chưa xác nhận đủ các mẫu đã bỏ mặc định.','unknown',ids.map(savedId=>({id:savedId,label:'Mẫu đã bỏ mặc định'})));
        }
        const unsetSteps = others.map(otherId => ({id: otherId, label: 'Mẫu đã bỏ mặc định'}));
        if(target.is_default === is_default) return {...target, unchanged: false};
        const {data,error}=await supabase.from('income_expense_templates').update({is_default})
          .eq('id',id).eq('user_id',user.id).eq('is_income_template',is_income_template).is('deleted_at',null).select().single();
        if(error) {
          // Đã bỏ chọn mẫu cũ nhưng máy chủ từ chối rõ việc đặt mẫu mới (mẫu vừa bị xoá, không có quyền…): nói rõ mẫu nào
          // vừa bị bỏ chọn để người dùng chọn lại; bấm lại sẽ đọc nhóm mẫu và chỉ làm phần còn thiếu. (`recordWriteBlocked`
          // của một lỗi máy chủ thô = kết quả chưa rõ; không phải thì đó là lời từ chối rõ.)
          if(others.length && !recordWriteBlocked(error)) throw new FinancialWorkflowError(`Đã bỏ chọn mặc định ở mẫu ${others.join(', ')} nhưng chưa đặt được mẫu ${id} làm mặc định: ${recordWriteMessage(error, 'đặt mẫu mặc định')} Tải lại danh sách mẫu rồi chọn lại mẫu mặc định.`, 'failure', [], error);
          throw others.length ? new FinancialWorkflowError('Đã bỏ chọn mẫu mặc định cũ, chưa xác nhận được mẫu mới.', 'unknown', unsetSteps, error) : error;
        }
        confirmedRecordId(data,'đổi mẫu mặc định',id);
        const row=data as unknown as IncomeExpenseTemplate;
        if(row.is_default!==is_default || row.is_income_template!==is_income_template || row.user_id!==user.id) throw new FinancialWorkflowError('Chưa xác nhận mẫu có đúng trạng thái mặc định đã chọn.','unknown',[...unsetSteps,{id,label:'Mẫu cần đối chiếu'}]);
        return {...row,unchanged:false};
      });
      try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'income-expense-template-default', businessKey: `default:${is_income_template}` }, { organizationId: 'actor-scope' }); }
      catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần đổi sau gỡ lại. */ }
      return saved;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
      if (result.unchanged) toast.info(`Mẫu ${feedbackRecordName(result)} đã có trạng thái mặc định được chọn`);
      else toast.success(`${result.is_default ? "Đã chọn mẫu in mặc định" : "Đã bỏ chọn mẫu in mặc định"} ${feedbackRecordName(result)}`);
    },
    onError: (error) => {
      if (error instanceof FinancialWorkflowError) {
        queryClient.invalidateQueries({queryKey:['income-expense-templates']});
        toast.error('Chưa hoàn tất đổi mẫu mặc định', {description:recordWriteMessage(error,'đổi mẫu mặc định')});
      } else if (error instanceof TemplateDefaultPartialError) {
        queryClient.invalidateQueries({ queryKey: ["income-expense-templates"] });
        toast.error("Mẫu mặc định mới cập nhật một phần", { description: error.message });
      } else {
        const feedback = friendlyError(error, "Chưa đổi được mẫu in mặc định", { operation: "đổi mẫu in mặc định" });
        toast.error(feedback.title, { description: feedback.description });
      }
      console.error("Error toggling default template:", error);
    },
  });
};
