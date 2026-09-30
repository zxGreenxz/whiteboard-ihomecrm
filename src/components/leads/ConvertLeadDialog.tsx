import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useConvertLeadToDeposit, type LeadWithRelations } from "@/hooks/useLeads";
import { useCreateDeposit } from "@/hooks/useDeposits";
import { useCreateTenant } from "@/hooks/useTenants";
import { useTenantsLegacy } from "@/hooks/useTenants";
import { useRooms } from "@/hooks/useRooms";
import { todayISO } from '@/lib/collect';
import { continueLeadConversion,readLeadConversionTrace, type LeadConversionProgress } from '@/lib/leadConversionProgress';
import {persistentFinancialWorkflow} from '@/lib/persistentFinancialWorkflow';
import {FinancialWorkflowError} from '@/lib/financialWorkflow';
import {financialPending} from '@/lib/financialPending';
import {recordWriteBlocked,recordWriteMessage} from '@/lib/recordWriteOutcome';
import {getSessionUser} from '@/lib/authSession';
import {useOrganization} from '@/contexts/OrganizationContext';
import {supabase} from '@/integrations/supabase/client';
import {validateInputDrafts} from '@/lib/inputDraftValidation';
import { focusFirstError } from '@/lib/formErrors';
import { toast } from 'sonner';

const convertSchema = z.object({
  tenant_id: z.string().optional(),
  create_tenant: z.boolean(),
  tenant_name: z.string().optional(),
  tenant_phone: z.string().optional(),
  room_id: z.string().min(1, "Phải chọn căn hộ"),
  amount: z.number().min(0, "Số tiền phải >= 0"),
  deposit_date: z.string().min(1, "Ngày đặt cọc là bắt buộc"),
  hold_until_date: z.string().min(1, "Ngày giữ căn hộ là bắt buộc"),
  notes: z.string().optional(),
});

type ConvertFormValues = z.infer<typeof convertSchema>;

interface ConvertLeadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: LeadWithRelations;
}

export function ConvertLeadDialog({ open, onOpenChange, lead }: ConvertLeadDialogProps) {
  const [createNewTenant, setCreateNewTenant] = useState(false);
  const [progress, setProgress] = useState<LeadConversionProgress>({});
  const progressRef = useRef<LeadConversionProgress>({});
  const [unknownDeposit, setUnknownDeposit] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef=useRef(false);
  const [checkingPending,setCheckingPending]=useState(true);
  const {selectedOrganizationId}=useOrganization();
  const organizationId=lead.organization_id ?? selectedOrganizationId;
  const guard=persistentFinancialWorkflow('lead-conversion');
  const formRef = useRef<HTMLFormElement>(null);
  const convertLead = useConvertLeadToDeposit({ silent: true });
  const createDeposit = useCreateDeposit({ silent: true });
  const createTenant = useCreateTenant({ silent: true });
  const tenantsQuery=useTenantsLegacy({enabled:open});
  const roomsQuery=useRooms();
  const {data:tenants=[]}=tenantsQuery;
  const {data:rooms=[]}=roomsQuery;
  const sourceBlocked=tenantsQuery.isLoading || tenantsQuery.isError || roomsQuery.isLoading || roomsQuery.isError;
  const readRecord=async(table:'tenants'|'deposits'|'leads',id:string)=>{
    const {data,error}=await supabase.from(table).select('*').eq('id',id).eq('organization_id',organizationId!).is('deleted_at',null).maybeSingle();
    if(error)throw error;
    return data;
  };

  const form = useForm<ConvertFormValues>({
    resolver: zodResolver(convertSchema),
    defaultValues: {
      tenant_id: undefined,
      create_tenant: false,
      tenant_name: lead.customer_name || "",
      tenant_phone: lead.phone || "",
      room_id: lead.room_id || "",
      amount: 0,
      deposit_date: todayISO(),
      hold_until_date: "",
      notes: lead.notes || "",
    },
  });

  useEffect(()=>{
    if(!open || !organizationId)return;
    let active=true;setCheckingPending(true);
    void (async()=>{
      try{
        const user=await getSessionUser();if(!user)return;
        const pending=financialPending.read({namespace:'lead-conversion',userId:user.id,organizationId,businessKey:lead.id});
        if(!pending)return;
        const trace=readLeadConversionTrace(pending.requestKey);
        if(!trace || trace.leadId!==lead.id){if(active){setUnknownDeposit(true);form.setError('root.server',{message:recordWriteMessage(new FinancialWorkflowError('Yêu cầu chuyển khách hẹn trước chưa được đối chiếu. Giữ các mã đã nhận, không tạo lại khách hoặc phiếu.','unknown',pending.completedIds.map(id=>({id,label:'Bản ghi cần đối chiếu'}))),'chuyển khách hẹn')});}return;}
        if(active){const next={tenantId:trace.tenantId,depositId:trace.depositId};progressRef.current=next;setProgress(next);setUnknownDeposit(!trace.canResume);}
        if(trace.depositId && trace.tenantId){
          const tenant=await readRecord('tenants',trace.tenantId);const deposit=await readRecord('deposits',trace.depositId);
          if(!tenant || tenant.id!==trace.tenantId || !deposit || deposit.id!==trace.depositId || !('tenant_id' in deposit) || deposit.tenant_id!==trace.tenantId || !('amount' in deposit) || typeof deposit.amount!=='number' || !Number.isFinite(deposit.amount))throw new Error('Chưa đối chiếu được khách và phiếu đã nhận mã.');
          if(active && !form.formState.isDirty && !form.formState.errors.root?.server){setCreateNewTenant(false);form.reset({...form.getValues(),tenant_id:trace.tenantId,room_id:deposit.room_id ?? '',amount:deposit.amount,deposit_date:deposit.deposit_date,hold_until_date:deposit.hold_until ?? '',notes:deposit.notes ?? ''});}
        }
      }catch(error){if(active){setUnknownDeposit(true);form.setError('root.server',{message:recordWriteMessage(error,'đối chiếu chuyển khách hẹn')});}}
      finally{if(active)setCheckingPending(false);}
    })();return()=>{active=false;};
  },[open,lead.id,organizationId]);
  const onSubmit = async (data: ConvertFormValues,reconcileOnly=false) => {
    if ((unknownDeposit && !reconcileOnly) || busyRef.current || busy || checkingPending || sourceBlocked || !organizationId || !validateInputDrafts(formRef.current)) return;
    if (!progressRef.current.tenantId && !createNewTenant && !data.tenant_id) {
      form.setError('tenant_id', { message: 'Phải chọn khách hàng' });
      await focusFirstError({ tenant_id: 'Phải chọn khách hàng' }, { root: formRef.current });
      return;
    }
    if (!progressRef.current.tenantId && createNewTenant && (!data.tenant_name?.trim() || !data.tenant_phone?.trim())) {
      const errors: Record<string, string> = {};
      if (!data.tenant_name?.trim()) errors.tenant_name = 'Phải nhập tên khách hàng';
      if (!data.tenant_phone?.trim()) errors.tenant_phone = 'Phải nhập số điện thoại';
      Object.entries(errors).forEach(([name, message]) => form.setError(name as 'tenant_name' | 'tenant_phone', { message }));
      await focusFirstError(errors, { root: formRef.current });
      return;
    }
    busyRef.current=true;setBusy(true);form.clearErrors('root.server');
    try {
      await continueLeadConversion({ tenantId: progressRef.current.tenantId || (!createNewTenant ? data.tenant_id : undefined), depositId: progressRef.current.depositId }, {
        createTenant: async () => {
          if(reconcileOnly)throw new FinancialWorkflowError('Chỉ đối chiếu yêu cầu trước, chưa tạo khách khác.','failure',[]);
          const tenant = await createTenant.mutateAsync({ full_name: data.tenant_name!.trim(), phone: data.tenant_phone!.trim(), email: lead.email, status: 'DEPOSITED' });
          return tenant.id;
        },
        createDeposit: async tenantId => {
          if(reconcileOnly)throw new FinancialWorkflowError('Chỉ đối chiếu yêu cầu trước, chưa lập phiếu khác.','failure',[]);
          const deposit = await createDeposit.mutateAsync({ tenant_id: tenantId, room_id: data.room_id, amount: data.amount,
            deposit_date: data.deposit_date, hold_until: data.hold_until_date, status: 'PENDING', notes: data.notes || null });
          return deposit.id;
        },
        markLead: () => {
          if(reconcileOnly)throw new FinancialWorkflowError('Chỉ đối chiếu trạng thái đã gửi, chưa cập nhật khách hẹn lại.','failure',[]);
          return convertLead.mutateAsync(lead.id);
        },
      }, next => { progressRef.current = next; setProgress(next); },{
        guard,leadId:lead.id,organizationId,
        readTenant:id=>readRecord('tenants',id),readDeposit:id=>readRecord('deposits',id),readLead:()=>readRecord('leads',lead.id),
        validateDeposit:row=>row.room_id===data.room_id && row.amount===data.amount && row.deposit_date===data.deposit_date && row.hold_until===data.hold_until_date,
      });
      toast.success(`Đã chuyển khách hẹn thành đặt cọc${progressRef.current.depositId ? ` (phiếu ${progressRef.current.depositId})` : ''}`);
      onOpenChange(false);
    } catch (error) {
      const message=recordWriteMessage(error,'chuyển khách hẹn thành đặt cọc');
      form.setError('root.server',{type:'server',message});
      let canResume=false;
      try {
        const user=await getSessionUser();
        const pending=user?financialPending.read({namespace:'lead-conversion',userId:user.id,organizationId,businessKey:lead.id}):null;
        canResume=!!readLeadConversionTrace(pending?.requestKey)?.canResume;
      } catch { /* IDs/error remain visible; missing persistence never authorizes another write. */ }
      setUnknownDeposit(recordWriteBlocked(error) && !canResume);
      toast.error('Chưa hoàn tất chuyển khách hẹn',{description:message});
    } finally {
      busyRef.current=false;setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next=>{if(!busyRef.current && !busy)onOpenChange(next);}}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Chuyển sang Đặt cọc</DialogTitle>
          <DialogDescription>
            Chuyển đổi khách hẹn thành đặt cọc: {lead.customer_name}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form ref={formRef} onSubmit={form.handleSubmit(data=>onSubmit(data), errors => { void focusFirstError(errors, { root: formRef.current }); })} className="space-y-4">
            {(progress.tenantId || progress.depositId || unknownDeposit || form.formState.errors.root?.server?.message) && (
              <div role="alert" className="rounded border border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
                {form.formState.errors.root?.server?.message && <p>{form.formState.errors.root.server.message}</p>}
                {progress.tenantId && <p>Khách hàng đã tạo: {progress.tenantId}</p>}
                {progress.depositId && <p>Phiếu đặt cọc đã tạo: {progress.depositId}. Lưu lại chỉ tiếp tục cập nhật khách hẹn.</p>}
                {unknownDeposit && <><p>Yêu cầu chuyển trước chưa được xác nhận đầy đủ. Đối chiếu khách và phiếu đã có; không lập lại toàn bộ.</p><Button type="button" variant="outline" disabled={busy || checkingPending || sourceBlocked} onClick={()=>{void onSubmit(form.getValues(),true);}}>Đối chiếu trạng thái đã gửi</Button></>}
              </div>
            )}
            {sourceBlocked && <div role="alert" className="text-destructive">Chưa tải đủ khách thuê hoặc căn hộ. <Button type="button" variant="outline" onClick={()=>{void tenantsQuery.refetch();void roomsQuery.refetch();}}>Tải lại dữ liệu</Button></div>}
            <fieldset disabled={busy || checkingPending || sourceBlocked || unknownDeposit || !!progress.depositId} className="space-y-4">
            {/* Tenant Selection */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="create_tenant"
                  checked={createNewTenant}
                  onChange={(e) => setCreateNewTenant(e.target.checked)}
                  disabled={Boolean(progress.tenantId)}
                  className="rounded"
                />
                <label htmlFor="create_tenant" className="text-sm">
                  Tạo khách hàng mới
                </label>
              </div>

              {createNewTenant ? (
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="tenant_name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tên khách hàng *</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="tenant_phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Số điện thoại *</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              ) : (
                <FormField
                  control={form.control}
                  name="tenant_id"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Chọn khách hàng *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn khách hàng" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {tenants.map((tenant) => (
                            <SelectItem key={tenant.id} value={tenant.id}>
                              {tenant.full_name} - {tenant.phone}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>

            {/* Room Selection */}
            <FormField
              control={form.control}
              name="room_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Căn hộ *</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn căn hộ" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {rooms.map((room) => (
                        <SelectItem key={room.id} value={room.id}>
                          {room.name} {room.code && `(${room.code})`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Deposit Info */}
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Số tiền cọc *</FormLabel>
                    <FormControl>
                      <CurrencyInput
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="deposit_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ngày đặt cọc *</FormLabel>
                    <FormControl>
                      <DateInput
                        value={field.value || ''}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="hold_until_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Giữ căn hộ đến *</FormLabel>
                    <FormControl>
                      <DateInput
                        value={field.value || ''}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea {...field} className="min-h-[60px]" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            </fieldset>
            <div className="flex justify-end gap-3 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                disabled={busy || unknownDeposit || checkingPending || sourceBlocked}
              >
                {busy ? 'Đang xử lý...' : progress.depositId ? 'Hoàn tất chuyển đổi' : 'Tạo đặt cọc'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
