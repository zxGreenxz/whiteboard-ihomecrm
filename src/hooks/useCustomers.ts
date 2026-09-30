import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError, type CompletedFinancialStep } from '@/lib/financialWorkflow';
import { confirmedRecordId, confirmedRecordBatch, recordWriteMessage } from '@/lib/recordWriteOutcome';
import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
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
import { isContractInEffect, ACTIVE_CONTRACT_STATUSES } from "@/types/contract";
import { useOrganization } from "@/contexts/OrganizationContext";
import { withOrg, withOrgAll } from "@/lib/orgPayload";
import { friendlyError } from '@/lib/friendlyError';

// Resolve building/room filter → customer IDs.
// contracts has no customer_id (link is via contract_customers) and no
// building_id (building is reached via rooms.building_id). Chỉ tính HĐ đang
// hiệu lực (khớp cột "Căn hộ đang ở" enrich phía dưới). Returns [] when
// nothing matches so callers can short-circuit.
async function resolveCustomerIdsByLocation(filters: {
  building_id?: string;
  room_id?: string;
}): Promise<string[]> {
  const sb = supabase as any;

  let contractQuery = sb
    .from("contracts")
    .select("id, room:rooms!contracts_room_id_fkey!inner(building_id)")
    .in("status", ACTIVE_CONTRACT_STATUSES)
    .is("deleted_at", null);
  if (filters.room_id) {
    contractQuery = contractQuery.eq("room_id", filters.room_id);
  }
  if (filters.building_id) {
    contractQuery = contractQuery.eq("room.building_id", filters.building_id);
  }

  const { data: contracts, error } = await contractQuery;
  if (error) {
    console.error("resolveCustomerIdsByLocation contracts error:", error);
    throw error;
  }
  const contractIds = ((contracts || []) as any[])
    .map((c) => c.id)
    .filter(Boolean) as string[];
  if (contractIds.length === 0) return [];

  // Chunk để URL .in() không phình quá dài khi toà có nhiều HĐ.
  const CHUNK = 100;
  const customerIds = new Set<string>();
  for (let i = 0; i < contractIds.length; i += CHUNK) {
    const { data: links, error: linkError } = await sb
      .from("contract_customers")
      .select("customer_id")
      .in("contract_id", contractIds.slice(i, i + CHUNK));
    if (linkError) {
      console.error("resolveCustomerIdsByLocation links error:", linkError);
      throw linkError;
    }
    for (const l of (links || []) as any[]) {
      if (l.customer_id) customerIds.add(l.customer_id);
    }
  }
  return [...customerIds];
}

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
): readonly unknown[] =>
  skipLocationEnrichment
    ? ["customers", filters, pagination, "no-loc"]
    : ["customers", filters, pagination];

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
  return useQuery({
    enabled: options?.enabled ?? true,
    // Giữ trang cũ khi đổi filter/search/trang để bảng không nhảy về "Đang tải".
    placeholderData: keepPreviousData,
    queryKey: customersQueryKey(
      filters,
      pagination,
      options?.skipLocationEnrichment,
    ),
    queryFn: async (): Promise<PaginatedData<Customer>> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      // count:'exact' bắt PostgREST chạy THÊM một nhánh đếm, quét lại toàn bộ
      // dòng khớp dưới cùng bộ predicate RLS và chạy lại InitPlan — đo được
      // ~2,2× trên chính query này. Chỉ trả giá đó khi thật sự có người phân
      // trang. Dùng LẠI ĐÚNG điều kiện của .range() bên dưới, không viết lại,
      // để count và range không bao giờ lệch nhau.
      const wantsPage = !!(pagination?.page && pagination?.pageSize);

      let query = (supabase
        .from("customers")
        .select("*", wantsPage ? { count: "exact" } : undefined) as any)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });

      // Filter by status_v2
      if (filters?.status) {
        query = query.eq("status_v2", filters.status);
      }

      // Filter by stat type
      if (filters?.statFilter && filters.statFilter !== "ALL") {
        if (filters.statFilter === "INDIVIDUAL") {
          query = query.eq("customer_type", "INDIVIDUAL");
        } else if (filters.statFilter === "ORGANIZATION") {
          query = query.eq("customer_type", "ORGANIZATION");
        } else if (filters.statFilter === "FOREIGN") {
          query = query.eq("is_foreign", true);
        }
      }

      // Search by name, phone, email, id_number
      if (filters?.search) {
        const search = filters.search.trim();
        if (search) {
          query = query.or(
            `full_name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%,id_number.ilike.%${search}%`
          );
        }
      }

      // Filter by building/room via contract_customers junction table
      if (filters?.building_id || filters?.room_id ) {
        const customerIds = await resolveCustomerIdsByLocation({
          building_id: filters.building_id,
          room_id: filters.room_id,
        });
        if (customerIds.length === 0) return { data: [], count: 0 };
        query = query.in("id", customerIds);
      }

      // Apply pagination
      if (wantsPage) {
        const offset = (pagination.page - 1) * pagination.pageSize;
        query = query.range(offset, offset + pagination.pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) {
        console.error("useCustomers error:", error);
        throw error;
      }

      const customers = (data || []) as Customer[];

      // Enrich with current room/building from latest ACTIVE contract.
      // Done as a follow-up query because PostgREST embed paths get
      // unwieldy through contract_customers. Cũng kèm building.id để FE
      // dùng check building scope (ẩn nút Sửa/Xoá khi không quản lý tòa).
      if (!options?.skipLocationEnrichment && customers.length > 0) {
        const ids = customers.map((c) => c.id);
        const CHUNK = 80;
        const map = new Map<
          string,
          { building_id: string | null; building_name: string; room_name: string }
        >();
        for (let i = 0; i < ids.length; i += CHUNK) {
          const slice = ids.slice(i, i + CHUNK).join(',');
          const { data: links } = await (supabase
            .from("contract_customers")
            .select(
              `customer_id,
               contract:contracts!contract_customers_contract_id_fkey (
                 status, end_date,
                 room:rooms!contracts_room_id_fkey (
                   name,
                   building:buildings!rooms_building_id_fkey ( id, name )
                 )
               )`
            ) as any)
            .in('customer_id', slice.split(','));
          for (const l of (links || []) as any[]) {
            if (!l.contract || !isContractInEffect(l.contract.status)) continue;
            const bid = l.contract.room?.building?.id || null;
            const bn = l.contract.room?.building?.name || '';
            const rn = l.contract.room?.name || '';
            if (!bid && !bn && !rn) continue;
            // Prefer the most recent contract if multiple
            const prev = map.get(l.customer_id);
            if (!prev) map.set(l.customer_id, { building_id: bid, building_name: bn, room_name: rn });
          }
        }
        for (const c of customers) {
          const cur = map.get(c.id);
          (c as any).current_building_id = cur?.building_id || null;
          (c as any).current_building_name = cur?.building_name || null;
          (c as any).current_room_name = cur?.room_name || null;
        }
      }

      return {
        data: customers,
        // postgrest-js chỉ đọc Content-Range khi request đã xin count, nên không
        // xin ⇒ `count === null`. Trả `customers.length` thay vì 0: một consumer
        // lỡ đọc `count` sẽ thấy "có bấy nhiêu khách" chứ không thấy "không có
        // khách nào" — sai lệch thì có, nhưng không phải sai lệch câm lặng biến
        // dữ liệu thành rỗng. `??` chứ không phải `||`: khi CÓ xin count thì
        // số 0 là số thật, phải giữ.
        count: count ?? customers.length,
      };
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
  return useCallback(
    (customer: Customer) => {
      queryClient.setQueryData<PaginatedData<Customer>>(
        CUSTOMER_PICKER_QUERY_KEY,
        (prev) => insertCustomerIntoPickerCache(prev, customer),
      );
    },
    [queryClient],
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

      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

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
  return useQuery({
    // Giữ số cũ khi đổi filter/search để 2 thẻ đếm không nháy về 0.
    placeholderData: keepPreviousData,
    queryKey: ["customer-stats", filters],
    queryFn: async (): Promise<CustomerStats> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");

      // 1 RPC thay 4 HEAD-count + resolve location trùng lặp (migration
      // 20260705210000). Trước đây khi lọc toà/phòng, hook này chạy LẠI
      // resolveCustomerIdsByLocation mà useCustomers vừa chạy (1 query contracts
      // + N query contract_customers), rồi thêm 4 count = burst request; giờ
      // toàn bộ gói trong 1 câu SQL, SECURITY INVOKER giữ RLS như cũ.
      const { data, error } = await supabase.rpc(
        "get_customer_stats",
        {
          // Cả 4 tham số đều `DEFAULT NULL` ở server (xem rpc-surface.json), nên
          // bỏ khoá khỏi payload = truyền NULL. Dùng `undefined` để khớp kiểu
          // `p_x?: T` mà bộ sinh Supabase tạo cho tham số CÓ DEFAULT.
          p_status: filters?.status ?? undefined,
          p_search: filters?.search?.trim() || undefined,
          p_building_id: filters?.building_id ?? undefined,
          p_room_id: filters?.room_id ?? undefined,
        },
      );
      if (error) {
        console.error("useCustomerStats error:", error);
        throw error;
      }
      if (!data || typeof data !== 'object') throw new Error('Chưa xác nhận được thống kê khách hàng');
      const row = data as Record<string, number>;
      if (['total', 'individual', 'organization', 'foreign'].some(key => !Number.isFinite(Number(row[key])))) {
        throw new Error('Thống kê khách hàng chưa đủ dữ liệu');
      }
      return {
        total: Number(row.total) || 0,
        individual: Number(row.individual) || 0,
        organization: Number(row.organization) || 0,
        foreign: Number(row.foreign) || 0,
      };
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
      const payload=withOrg({...customerData,user_id:user.id,status_v2:'RENTING'} as any,selectedOrganizationId);
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
