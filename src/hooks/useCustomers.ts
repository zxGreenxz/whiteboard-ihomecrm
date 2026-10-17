import { customerListArgs, parseCustomerList } from '@/lib/customerList';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError, type CompletedFinancialStep } from '@/lib/financialWorkflow';
import { confirmedRecordId, confirmedRecordBatch, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getSessionUser } from "@/lib/authSession";
import { toast } from "sonner";
import type {
  Customer,
  CustomerFilters,
  CustomerStats,
  CustomerFormData,
} from "@/types/customer";
import type { VehicleType } from '@/types/vehicle';
import type { PaginatedData, PaginationParams } from "@/hooks/usePagination";
import { ACTIVE_CONTRACT_STATUSES } from "@/types/contract";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
import { friendlyError } from '@/lib/friendlyError';

// =============================================
// useCustomers - Query customers with filters and pagination
// Requirements: 1.1, 1.5, 1.6, 1.9
// =============================================

/**
 * Nguồn sự thật DUY NHẤT cho query key của danh sách khách.
 *
 * VÌ SAO LÀ HÀM CHỨ KHÔNG PHẢI MẢNG CHÉP TAY Ở TỪNG CHỖ
 *   Ngoài `useCustomers`, còn `useSeedCustomerIntoPickerCache` phải trỏ vào ĐÚNG
 *   ô cache của picker. Hai bản chép tay của cùng một key sẽ trôi khỏi nhau, và
 *   khi trôi thì `setQueryData` ghi vào một ô KHÔNG AI ĐỌC — không lỗi, không
 *   cảnh báo, chỉ là khách vừa tạo không hiện ra. Đúng lớp lỗi im lặng mà cả hệ
 *   realtime của repo này sinh ra để chống.
 *
 * Phần tử `"no-loc"` CHỈ được thêm khi bật `skipLocationEnrichment`. Cố ý không
 * thêm phần tử thứ 4 vô điều kiện: làm vậy sẽ đổi key của cả ba consumer còn
 * lại, và `placeholderData: keepPreviousData` mất dữ liệu cũ để giữ ⇒ bảng khách
 * hàng nháy "Đang tải" một lần sau khi deploy, đổi lấy con số không.
 *
 * Gốc key vẫn là `["customers"]` nên hub realtime (src/hooks/realtime/operations.ts)
 * invalidate theo prefix vẫn phủ hết — tạo root mới mới là thứ rơi ra ngoài hub.
 */
export const customersQueryKey = (
  filters?: CustomerFilters,
  pagination?: { page: number; pageSize: number },
  skipLocationEnrichment?: boolean,
  organizationId?: string | null,
): readonly unknown[] => [
  "customers", filters, pagination,
  ...(skipLocationEnrichment ? ["no-loc"] : []),
  ...(organizationId ? [organizationId] : []),
];

/** Ô cache của picker khách trong màn hợp đồng — xem `useSeedCustomerIntoPickerCache`. */
export const CUSTOMER_PICKER_QUERY_KEY = customersQueryKey(
  undefined,
  undefined,
  true,
);

export const useCustomers = (
  filters?: CustomerFilters,
  pagination?: { page: number; pageSize: number },
  // options.enabled: dialog mounted-sẵn (vd CustomerSelectionDialog trong form
  // HĐ) gate fetch khi đóng — tránh kéo cả bảng customers + chuỗi enrichment
  // mỗi lần tải trang. Default true.
  //
  // options.skipLocationEnrichment: bỏ hẳn chuỗi contract_customers → contracts
  // → rooms → buildings ở dưới. Picker HĐ chỉ hiện tên/SĐT/CCCD nên chuỗi đó là
  // thuần lãng phí: ở ~500 khách nó là 7 request nối tiếp sau request chính.
  // Cờ này ĐỔI HÌNH DẠNG DỮ LIỆU TRẢ VỀ nên phải nằm trong query key, khác hẳn
  // `enabled` (chỉ chặn fetch). Hai consumer chung một key mà khác hình dạng thì
  // ai mount trước quyết định — và bên còn lại đọc thiếu trường mà không biết.
  options?: { enabled?: boolean; skipLocationEnrichment?: boolean }
) => {
  const {selectedOrganizationId}=useOrganization();
  return useQuery({
    enabled: (options?.enabled ?? true) && !!selectedOrganizationId,
    // Giữ trang cũ khi đổi filter/search/trang để bảng không nhảy về "Đang tải".
    placeholderData: (previous,query)=>query?.queryKey.at(-1)===selectedOrganizationId?previous:undefined,
    queryKey: customersQueryKey(
      filters,
      pagination,
      options?.skipLocationEnrichment,
      selectedOrganizationId,
    ),
    queryFn: async (): Promise<PaginatedData<Customer>> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");
      if (!selectedOrganizationId) throw new Error("Chưa chọn tổ chức.");

      // Một lời gọi thay chuỗi PostgREST cũ (customers + count + location ids
      // phân trang + 1 request nhúng toà/80 khách): RLS, tìm không dấu, lọc
      // toà/phòng, sắp xếp, phân trang, tổng và toà hiện tại đều nằm trong
      // customer_list_v1 — cùng công thức với Hermes/báo cáo. Không phân trang
      // (picker HĐ) ⇒ toàn bộ danh sách, `count` = số dòng như trước.
      const args = customerListArgs({
        organizationId: selectedOrganizationId,
        filters,
        pagination,
        includeLocation: !options?.skipLocationEnrichment,
      });
      const { data, error } = await supabase.rpc("customer_list_v1", args);
      if (error) {
        console.error("useCustomers error:", error);
        throw error;
      }
      const list = parseCustomerList(data, args);
      return { data: list.rows, count: list.total };
    },
  });
};

/**
 * Chèn khách vừa tạo vào đầu danh sách của picker — hàm THUẦN để test được.
 *
 * Query của picker sắp `created_at desc` (xem `.order` ở trên) nên khách mới
 * nhất đứng ĐẦU ⇒ `unshift`, không phải `push`.
 *
 * Idempotent theo `id`: một `invalidateQueries` hoặc một event realtime có thể
 * đã kịp mang khách đó về trước khi hàm này chạy. Chèn lần hai sẽ tạo hàng trùng
 * và đẩy `count` lệch.
 */
export function insertCustomerIntoPickerCache(
  prev: PaginatedData<Customer> | undefined,
  customer: Customer,
): PaginatedData<Customer> {
  const base = prev ?? { data: [], count: 0 };
  if (base.data.some((c) => c.id === customer.id)) return base;
  return { data: [customer, ...base.data], count: base.count + 1 };
}

/**
 * Đưa khách canonical do server vừa trả vào thẳng cache picker.
 *
 * ĐÂY LÀ ĐIỂM CỦA CẢ ĐỢT SỬA: server đã trả về khách rồi, nhưng đường cũ vứt nó
 * đi rồi bắt server đọc lại toàn bộ danh sách. Cùng một tab không cần đi vòng
 * qua mạng để biết thứ chính nó vừa tạo.
 *
 * Ghi vào ĐÚNG một ô cache. KHÔNG dùng `setQueriesData({ queryKey: ["customers"] })`:
 * nó khớp cả `["customers", id]` của `useCustomer` (hình dạng khác hẳn) lẫn mọi
 * key có filter/pagination — chèn vào đó là chèn sai bộ lọc và vỡ kích thước trang.
 */
export const useSeedCustomerIntoPickerCache = () => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId}=useOrganization();
  return useCallback(
    (customer: Customer) => {
      queryClient.setQueryData<PaginatedData<Customer>>(
        customersQueryKey(undefined,undefined,true,selectedOrganizationId),
        (prev) => insertCustomerIntoPickerCache(prev, customer),
      );
    },
    [queryClient,selectedOrganizationId],
  );
};

// =============================================
// useCustomer - Single customer query
// =============================================

export const useCustomer = (id: string) => {
  return useQuery({
    queryKey: ["customers", id],
    queryFn: async (): Promise<Customer | null> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      // hermes-parity:begin customer-detail — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .single();
      // hermes-parity:end customer-detail

      if (error) {
        console.error("useCustomer error:", error);
        throw error;
      }

      return data as Customer;
    },
    enabled: !!id,
  });
};

// =============================================
// useCustomerStats - Count total, individual, organization, foreign
// Requirements: 1.2, 1.3
// =============================================

export const useCustomerStats = (filters?: CustomerFilters) => {
  const { selectedOrganizationId } = useOrganization();
  return useQuery({
    enabled: !!selectedOrganizationId,
    // Giữ số cũ khi đổi filter/search để 2 thẻ đếm không nháy về 0.
    placeholderData: (previous, query) => query?.queryKey.at(-1) === selectedOrganizationId ? previous : undefined,
    queryKey: ["customer-stats", filters, selectedOrganizationId],
    queryFn: async (): Promise<CustomerStats> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");
      if (!selectedOrganizationId) throw new Error('Chưa chọn tổ chức.');

      // Cùng hàm với danh sách, không tải dòng nào: khối stats bỏ qua thẻ loại
      // đang chọn và đếm trên đúng tập lọc (trạng thái, tìm không dấu, toà/phòng)
      // của bảng, trong đúng công ty đang chọn. Thay get_customer_stats (không
      // tìm) và 4 HEAD-count (có tìm).
      const args = customerListArgs({ organizationId: selectedOrganizationId, filters, includeLocation: false, statsOnly: true });
      const { data, error } = await supabase.rpc("customer_list_v1", args);
      if (error) {
        console.error("useCustomerStats error:", error);
        throw error;
      }
      return parseCustomerList(data, args).stats;
    },
  });
};

// =============================================
// useCreateCustomer - Insert mutation
// Requirements: 2.10, 2.12
// =============================================

/**
 * Kết quả tạo khách.
 *
 * Là một OBJECT chứ không phải `Customer` trần vì việc tạo khách gồm HAI thao
 * tác không nằm trong cùng transaction: insert `customers` rồi insert `vehicles`.
 * Cái thứ hai hỏng thì kết quả không phải "thành công" cũng không phải "thất
 * bại" — nó là hỏng một phần, và kiểu trả về phải nói được điều đó. Trước đây
 * lỗi ở bước hai bị nuốt hoàn toàn: người dùng đọc "TẠO thành công" trong khi
 * xe không được lưu.
 */
export interface CreateCustomerResult {
  customer: Customer;
  /** Có giá trị ⇒ khách ĐÃ tạo, phương tiện kèm theo CHƯA lưu được. */
  vehicleError?: { message?: string; code?: string } | null;
}

export const useCreateCustomer = (options: {silent?:boolean} = {}) => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId} = useOrganization();
  const guard = persistentFinancialWorkflow('customer-create');
  const refresh = () => {for(const key of ['customers','customer-stats','vehicles']) queryClient.invalidateQueries({queryKey:[key]});};
  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn:async(formData:CustomerFormData):Promise<CreateCustomerResult>=>{
      const user=await getSessionUser(); if(!user)throw new Error('Not authenticated');
      const {vehicles,...customerData}=formData;
      vehicles?.forEach(vehicle=>validatedVehicleType(vehicle.vehicle_type));
      const payload=withOrg({...customerData,user_id:user.id,status_v2:'WALK_IN'} as any,selectedOrganizationId);
      let saved:Customer|undefined;
      try{return await guard.run('create','tạo khách hàng',async progress=>{
        const {data,error}=await supabase.from('customers').insert(withOrg(payload,selectedOrganizationId)).select().single();
        if(error)throw error;const id=confirmedRecordId(data,'tạo khách hàng');
        saved=data as unknown as Customer;
        progress.completed.push({id,label:'Đã tạo khách hàng'});
        if(vehicles?.length){
          progress.stage='lưu phương tiện của khách';
          const inserts=vehicles.map(v=>({user_id:user.id,customer_id:id,vehicle_type:validatedVehicleType(v.vehicle_type),vehicle_name:v.vehicle_name,color:v.color||null,license_plate:v.license_plate}));
          const {data:rows,error:vehicleError}=await supabase.from('vehicles').insert(withOrgAll(inserts,selectedOrganizationId) as any).select('id');
          if(vehicleError)throw vehicleError;
          const ids=confirmedRecordBatch(rows,inserts.length,'lưu phương tiện của khách');
          progress.completed.push(...ids.map(id=>({id,label:'Đã lưu phương tiện'})));
        }
        return {customer:saved};
      },undefined,payload.organization_id);}
      catch(error){
        // Keep the established partial result contract while the durable guard remains blocked.
        if(saved&&error instanceof FinancialWorkflowError&&error.outcome==='partial')return {customer:saved,vehicleError:error};
        throw error;
      }
    },
    onSuccess:result=>{
      refresh();if(options.silent)return;
      if(result.vehicleError){toast.error(`Khách hàng ${result.customer.full_name || result.customer.id} đã tạo, phương tiện chưa hoàn tất.`,{description:recordWriteMessage(result.vehicleError,'lưu phương tiện')});return;}
      toast.success(`Đã tạo khách hàng ${result.customer.full_name || result.customer.id}`);
    },
    onError:error=>{refresh();if(!options.silent)toast.error('Chưa tạo được khách hàng',{description:recordWriteMessage(error,'tạo khách hàng')});},
  });
};

function validatedVehicleType(value: string): VehicleType {
  switch (value) {
    case 'MOTORBIKE': case 'CAR': case 'BICYCLE': case 'ELECTRIC_BIKE': case 'OTHER': return value;
    default: throw new Error('Loại phương tiện không hợp lệ. Chọn lại trước khi lưu.');
  }
}
// Preserve main removal-update-insert order; receipts record each completed step.
async function syncCustomerVehicles(customerId:string,vehicles:NonNullable<CustomerFormData['vehicles']>,organizationId:string|null,completed:CompletedFinancialStep[]):Promise<void>{
  const user=await getSessionUser();if(!user)throw new Error('Not authenticated');
  const {data:existing,error:loadError}=await supabase.from('vehicles').select('id').eq('customer_id',customerId).is('deleted_at',null);
  if(loadError)throw loadError;
  if(!Array.isArray(existing)||existing.some(row=>typeof row?.id!=='string'||!row.id)||new Set(existing.map(row=>row.id)).size!==existing.length)throw new Error('Chưa xác nhận được danh sách phương tiện hiện tại.');
  const existingIds=existing.map(row=>row.id);
  const keptIds=vehicles.flatMap(v=>v.id?[v.id]:[]);
  if(new Set(keptIds).size!==keptIds.length||keptIds.some(id=>!existingIds.includes(id)))throw new Error('Phương tiện vừa thay đổi hoặc không thuộc khách này. Tải lại để đối chiếu.');
  const fields=(v:(typeof vehicles)[number])=>({vehicle_type:validatedVehicleType(v.vehicle_type),vehicle_name:v.vehicle_name,color:v.color||null,license_plate:v.license_plate});
  const removedIds=existingIds.filter(id=>!keptIds.includes(id));
  if(removedIds.length){
    const {data,error}=await supabase.from('vehicles').update({deleted_at:new Date().toISOString()}).in('id',removedIds).select('id');
    if(error)throw error;
    const ids=confirmedRecordBatch(data,removedIds.length,'gỡ phương tiện');
    if(removedIds.some(id=>!ids.includes(id)))throw new Error('Chưa xác nhận đủ phương tiện được gỡ.');
    completed.push(...ids.map(id=>({id,label:'Đã gỡ phương tiện'})));
  }
  for(const v of vehicles.filter(v=>v.id)){
    const {data,error}=await supabase.from('vehicles').update(fields(v)).eq('id',v.id!).select('id').single();
    if(error)throw error;const id=confirmedRecordId(data,'cập nhật phương tiện',v.id);
    completed.push({id,label:'Đã cập nhật phương tiện'});
  }
  const added=vehicles.filter(v=>!v.id);
  if(added.length){
    const payload=withOrgAll(added.map(v=>({...fields(v),user_id:user.id,customer_id:customerId})),organizationId);
    const {data,error}=await supabase.from('vehicles').insert(withOrgAll(payload,organizationId)).select('id');
    if(error)throw error;
    const ids=confirmedRecordBatch(data,added.length,'thêm phương tiện');
    completed.push(...ids.map(id=>({id,label:'Đã thêm phương tiện'})));
  }
}

export const useUpdateCustomer = () => {
  const queryClient=useQueryClient();const {selectedOrganizationId}=useOrganization();
  const guard=persistentFinancialWorkflow('customer-update');
  const refresh=()=>{for(const key of ['customers','customer-stats','vehicles'])queryClient.invalidateQueries({queryKey:[key]});};
  return useMutation({
    meta:{handlesFeedback:true},
    mutationFn:async({id,data:formData}:{id:string;data:Partial<CustomerFormData>}):Promise<CreateCustomerResult>=>{
      const {vehicles,...customerData}=formData;
      vehicles?.forEach(vehicle=>validatedVehicleType(vehicle.vehicle_type));let saved:Customer|undefined;
      try{return await guard.run(id,'cập nhật khách hàng',async progress=>{
        const {data,error}=await supabase.from('customers').update(customerData as any).eq('id',id).select().single();
        if(error)throw error;confirmedRecordId(data,'cập nhật khách hàng',id);
        saved=data as unknown as Customer;progress.completed.push({id,label:'Đã cập nhật khách hàng'});
        if(vehicles){progress.stage='đồng bộ phương tiện';await syncCustomerVehicles(id,vehicles,selectedOrganizationId,progress.completed);}
        return {customer:saved};
      });}
      catch(error){if(saved&&error instanceof FinancialWorkflowError&&error.outcome==='partial')return {customer:saved,vehicleError:error};throw error;}
    },
    onSuccess:result=>{
      refresh();
      if(result.vehicleError){toast.error(`Khách hàng ${result.customer.full_name || result.customer.id} đã cập nhật, phương tiện chưa hoàn tất.`,{description:recordWriteMessage(result.vehicleError,'đồng bộ phương tiện')});return;}
      toast.success(`Đã cập nhật khách hàng ${result.customer.full_name || result.customer.id}`);
    },
    onError:error=>{refresh();toast.error('Chưa cập nhật được khách hàng',{description:recordWriteMessage(error,'cập nhật khách hàng')});},
  });
};

// =============================================
// useDeleteCustomer - Soft-delete mutation
// Requirements: 5.4
// =============================================

export const useDeleteCustomer = () => {
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const guard = persistentFinancialWorkflow('customer-delete');
  const readDeletion = async (id: string) => {
    const { data: deleted, error } = await supabase.from('customers').select('id, deleted_at').eq('id', id).maybeSingle();
    if (error || !deleted || deleted.id !== id || typeof deleted.deleted_at !== 'string' || !Number.isFinite(Date.parse(deleted.deleted_at))) return null;
    return deleted;
  };

  return useMutation({
    mutationFn: async (id: string) => {
      // Khách đang có HĐ hiệu lực thì không được xoá. RPC soft_delete_customer
      // cũng chặn ở DB (migration 20260902042935) — đây là lớp báo sớm cho UI,
      // không phải hàng rào duy nhất.
      const { data: links, error: linkError } = await supabase
        .from("contract_customers")
        .select("contract_id")
        .eq("customer_id", id);
      if (linkError) throw linkError;
      if (!Array.isArray(links) || links.some(link => typeof link.contract_id !== 'string' || !link.contract_id)) {
        throw new Error('Chưa tải đủ liên kết hợp đồng để kiểm tra điều kiện xoá khách hàng.');
      }
      const contractIds = links.map((link) => link.contract_id);
      if (contractIds.length > 0) {
        const { data: active, error: activeError } = await supabase
          .from("contracts")
          .select("id")
          .in("id", contractIds)
          .in("status", ACTIVE_CONTRACT_STATUSES)
          .is("deleted_at", null);
        if (activeError) throw activeError;
        if (!Array.isArray(active) || active.some(contract => typeof contract.id !== 'string' || !contract.id)) {
          throw new Error('Chưa xác nhận đủ hợp đồng hiệu lực để kiểm tra điều kiện xoá khách hàng.');
        }
        if (active.length > 0) {
          throw new Error(
            `Không thể xoá khách hàng đang có ${active.length} hợp đồng hiệu lực — thanh lý hoặc kết thúc hợp đồng trước.`,
          );
        }
      }

      return guard.run(id, 'xoá khách hàng', async () => {
        const { error } = await supabase.rpc('soft_delete_customer' as any, { p_customer_id: id });
        if (error) throw error;
        // RPC trả void: xác nhận trạng thái bằng lần đọc, không ghi lần nữa.
        const deleted = await readDeletion(id);
        if (!deleted) throw new FinancialWorkflowError('Yêu cầu xoá đã được gửi nhưng chưa xác nhận được trạng thái khách hàng. Tải lại và đối chiếu bản ghi trước khi tiếp tục.', 'unknown', [{id, label:'Khách hàng cần đối chiếu'}]);
        return deleted;
      }, async () => {
        const deleted = await readDeletion(id);
        return deleted ? {result: deleted} : null;
      }, selectedOrganizationId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      queryClient.invalidateQueries({ queryKey: ["customer-stats"] });
      toast.success('Đã xác nhận xoá khách hàng');
    },
    onError: (error: any) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customer-stats'] });
      if (error instanceof FinancialWorkflowError) {
        toast.error('Chưa xác nhận xoá khách hàng', {description:recordWriteMessage(error, 'xoá khách hàng')});
        return;
      }
      const message: string = error?.message ?? "";
      if (message.startsWith("Không thể xoá khách hàng") || message.includes("CUSTOMER_HAS_ACTIVE_CONTRACT")) {
        toast.error("Không thể xoá khách hàng đang có hợp đồng hiệu lực — thanh lý hoặc kết thúc hợp đồng trước.");
      } else if (error?.code === "23503") {
        toast.error("Dữ liệu liên quan không tồn tại");
      } else {
        toast.error('Chưa xoá được khách hàng', {description:recordWriteMessage(error, 'xoá khách hàng')});
      }
      console.error("Error deleting customer:", error);
    },
  });
};
