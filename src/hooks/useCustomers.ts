import { customerListArgs, parseCustomerList } from '@/lib/customerList';
import { FinancialAlreadyRecordedError, FinancialWorkflowError, type CompletedFinancialStep } from '@/lib/financialWorkflow';
import { confirmedRecordId, confirmedRecordBatch, recordWriteMessage, repeatableWrite } from '@/lib/recordWriteOutcome';
// Nạp động: hai module của đợt 4 chỉ cần lúc tạo, nạp tĩnh từ nhiều trang làm Vite tách thành chunk dùng chung và
// thêm tên chunk vào danh sách phụ thuộc của chunk entry (cửa bundle-inventory).
import type { FinancialPendingRecord } from '@/lib/financialPending';
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
/** Một trang danh sách khách; `stats` = khối thẻ đếm (bỏ qua thẻ loại) của cùng lời gọi. */
export type CustomerListPage = PaginatedData<Customer> & { stats?: CustomerStats };

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
    queryFn: async (): Promise<CustomerListPage> => {
      const user = await getSessionUser();
      if (!user) throw new Error("Not authenticated");
      if (!selectedOrganizationId) throw new Error("Chưa chọn tổ chức.");

      // Một lời gọi thay chuỗi PostgREST cũ (customers + count + location ids
      // phân trang + 1 request nhúng toà/80 khách + get_customer_stats/4 HEAD-count):
      // RLS, tìm không dấu, lọc toà/phòng, sắp xếp, phân trang, tổng, thẻ thống kê và
      // toà hiện tại đều nằm trong customer_list_v1 — cùng công thức với Hermes/báo cáo.
      // `stats` bỏ qua thẻ loại đang chọn (đúng nghĩa thẻ đếm cũ), nên màn đọc thẳng từ
      // đây, không gọi thêm. Không phân trang (picker HĐ) ⇒ toàn bộ danh sách.
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
      return { data: list.rows, count: list.total, stats: list.stats };
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
  /** Khách đã được tạo ở lần gửi trước (mất phản hồi); lần này chỉ đọc lại đúng mã, không tạo thêm. */
  replayed?: boolean;
}

/** Đầu vào tạo khách. `clientId`: nơi gọi tự giữ mã khách cho từng dòng (nhập Excel), để gửi lại đúng mã đó. */
export type CreateCustomerInput = CustomerFormData & { clientId?: string };

/**
 * Dấu khoá chung của bản trước đợt 4 (`customer-create`/`create`, một dấu cho mọi khách mới): đọc một lần, tra
 * khách người này đã tạo quanh giờ kẹt (chưa xoá), gỡ dấu. Khách đang tạo giống một khách như thế (cùng SĐT hoặc số
 * giấy tờ; không có SĐT thì cùng tên) thì báo «có thể đã tạo» kèm mã và không tạo; lần bấm sau là lượt mới.
 */
async function checkLegacyCustomerPending(matchKeys: readonly string[]): Promise<void> {
  const {settleLegacyPending}=await import('@/lib/legacyPendingExit');
  const {personMatchKeys}=await import('@/lib/clientRecordCreate');
  const settled = await settleLegacyPending({namespace:'customer-create',businessKey:'create'}, (pending, context) => legacyCustomerCandidates(pending, context));
  const match = settled?.verdict.find(candidate => personMatchKeys({name:candidate.full_name,phone:candidate.phone,idNumber:candidate.id_number}).some(key => matchKeys.includes(key)));
  if (match) throw new FinancialAlreadyRecordedError(`Có thể khách hàng ${match.full_name || ''} đã được tạo ở lần gửi trước bị kẹt (mã ${match.id}). Mở danh sách khách để kiểm tra; bấm lưu lại nếu vẫn muốn tạo thêm.`.replace(/\s+/g, ' '), [match.id]);
}

type LegacyCustomerCandidate = {id:string;full_name:string|null;phone:string|null;id_number:string|null};
/** Khách do chính người này tạo quanh giờ kẹt (cửa sổ ±60 phút) và các mã khách dấu cũ đã nhận; mới nhất trước. */
export async function legacyCustomerCandidates(pending: FinancialPendingRecord, context: {userId:string;organizationId:string}): Promise<LegacyCustomerCandidate[]> {
  const {legacyWindow}=await import('@/lib/legacyPendingExit');
  const {from,to}=legacyWindow(pending);
  const columns='id, full_name, phone, id_number, created_at';
  const {data,error}=await supabase.from('customers').select(columns).eq('user_id',context.userId).eq('organization_id',context.organizationId).is('deleted_at',null).gte('created_at',from).lte('created_at',to).order('created_at',{ascending:false}).limit(50);
  if(error||!Array.isArray(data))throw error??new Error('Chưa đọc được khách quanh giờ kẹt.');
  const rows=[...data] as LegacyCustomerCandidate[];
  const known=pending.completedIds.filter(id=>!rows.some(row=>row.id===id));
  if(known.length){
    const {data:byId,error:byIdError}=await supabase.from('customers').select(columns).in('id',known).is('deleted_at',null);
    if(byIdError||!Array.isArray(byId))throw byIdError??new Error('Chưa đọc được khách của dấu cũ.');
    rows.push(...(byId as LegacyCustomerCandidate[]));
  }
  return rows;
}

export const useCreateCustomer = (options: {silent?:boolean} = {}) => {
  const queryClient = useQueryClient();
  const {selectedOrganizationId} = useOrganization();
  const refresh = () => {for(const key of ['customers','vehicles']) queryClient.invalidateQueries({queryKey:[key]});};
  return useMutation({
    meta:{handlesFeedback:true},
    // Không còn khoá chung (đợt 4): mã khách do trình duyệt sinh, gửi lại cùng mã cho cùng khách; khoá chính của
    // `customers` chặn khách thứ hai. Một lần kẹt chỉ liên quan đúng khách đó.
    mutationFn:async({clientId,...formData}:CreateCustomerInput):Promise<CreateCustomerResult>=>{
      const user=await getSessionUser(); if(!user)throw new Error('Not authenticated');
      const {vehicles,...customerData}=formData;
      vehicles?.forEach(vehicle=>validatedVehicleType(vehicle.vehicle_type));
      const payload=withOrg({...customerData,user_id:user.id,status_v2:'WALK_IN'} as Record<string,unknown>,selectedOrganizationId);
      const person={name:customerData.full_name,phone:customerData.phone,idNumber:customerData.id_number};
      const {createWithClientMemory,personMatchKeys}=await import('@/lib/clientRecordCreate');
      if(!clientId)await checkLegacyCustomerPending(personMatchKeys(person));
      const {row,replayed}=await createWithClientMemory<Customer&{id:string}>({
        table:'customers',userId:user.id,organizationId:payload.organization_id,payload,person,clientId,
        personOf:row=>({name:row.full_name,phone:row.phone,idNumber:row.id_number}),
        operation:'tạo khách hàng',describe:row=>`Khách hàng ${String(row.full_name ?? '')}`.trim(),
        alreadyNote:vehicles?.length?'Xe nhập ở lần này chưa được lưu; thêm xe trong trang khách.':undefined,
      });
      const customer=row as Customer;
      if(!vehicles?.length)return {customer,replayed};
      // Khách đã có. Bước lưu xe hỏng thì báo «chưa lưu được xe» kèm mã khách, không giữ dấu nào: người dùng mở
      // khách để thêm xe.
      try{
        if(replayed){
          // Khách do một lần gửi trước tạo. Lần đó có thể đã (hoặc đang) lưu xe: khách mới tinh mà đã có xe thì xe là của
          // lần đó, không lưu thêm.
          const {data:existing,error:readError}=await supabase.from('vehicles').select('id').eq('customer_id',customer.id).is('deleted_at',null);
          if(readError||!Array.isArray(existing))throw readError??new Error('Chưa đọc được xe hiện có của khách.');
          if(existing.length)return {customer,replayed};
        }
        const inserts=vehicles.map(v=>({user_id:user.id,customer_id:customer.id,vehicle_type:validatedVehicleType(v.vehicle_type),vehicle_name:v.vehicle_name,color:v.color||null,license_plate:v.license_plate}));
        const {data:rows,error:vehicleError}=await supabase.from('vehicles').insert(withOrgAll(inserts,payload.organization_id) as never).select('id');
        if(vehicleError)throw vehicleError;
        confirmedRecordBatch(rows,inserts.length,'lưu phương tiện của khách');
      }catch(error){
        return {customer,replayed,vehicleError:new FinancialWorkflowError(`Khách hàng đã tạo (mã ${customer.id}) nhưng chưa lưu được xe: ${recordWriteMessage(error,'lưu phương tiện')} Mở khách để kiểm tra và thêm xe; không tạo lại khách.`,'partial',[{id:customer.id,label:'Khách đã tạo'}],error)};
      }
      return {customer,replayed};
    },
    onSuccess:result=>{
      refresh();if(options.silent)return;
      if(result.vehicleError){toast.error(`Khách hàng ${result.customer.full_name || result.customer.id} đã tạo, phương tiện chưa hoàn tất.`,{description:recordWriteMessage(result.vehicleError,'lưu phương tiện')});return;}
      toast.success(result.replayed
        ? `Khách hàng ${result.customer.full_name || result.customer.id} đã có trên máy chủ (lần gửi trước hoặc lần gửi mất phản hồi đã tạo); không tạo thêm.`
        : `Đã tạo khách hàng ${result.customer.full_name || result.customer.id}`);
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
/**
 * Khoá so một xe trong form với xe đã có của khách: biển số bỏ dấu cách, gạch, chấm, chữ hoa. Xe không có biển số thì
 * so đủ loại, tên và màu (cùng cách chuẩn hoá).
 */
function vehicleMatchKey(vehicle:{vehicle_type?:unknown;vehicle_name?:unknown;color?:unknown;license_plate?:unknown}):string{
  const text=(value:unknown)=>typeof value==='string'?value.normalize('NFKC').toUpperCase().replace(/[\s.\-_/]+/g,''):'';
  const plate=text(vehicle.license_plate);
  return plate?`p:${plate}`:`x:${text(vehicle.vehicle_type)}|${text(vehicle.vehicle_name)}|${text(vehicle.color)}`;
}

// Preserve main removal-update-insert order; receipts record each completed step.
async function syncCustomerVehicles(customerId:string,vehicles:NonNullable<CustomerFormData['vehicles']>,organizationId:string|null,completed:CompletedFinancialStep[]):Promise<void>{
  const user=await getSessionUser();if(!user)throw new Error('Not authenticated');
  const {data:existing,error:loadError}=await supabase.from('vehicles').select('id, vehicle_type, vehicle_name, color, license_plate').eq('customer_id',customerId).is('deleted_at',null);
  if(loadError)throw loadError;
  if(!Array.isArray(existing)||existing.some(row=>typeof row?.id!=='string'||!row.id)||new Set(existing.map(row=>row.id)).size!==existing.length)throw new Error('Chưa xác nhận được danh sách phương tiện hiện tại.');
  const existingIds=existing.map(row=>row.id);
  const keptIds=vehicles.flatMap(v=>v.id?[v.id]:[]);
  if(new Set(keptIds).size!==keptIds.length||keptIds.some(id=>!existingIds.includes(id)))throw new Error('Phương tiện vừa thay đổi hoặc không thuộc khách này. Tải lại để đối chiếu.');
  const fields=(v:(typeof vehicles)[number])=>({vehicle_type:validatedVehicleType(v.vehicle_type),vehicle_name:v.vehicle_name,color:v.color||null,license_plate:v.license_plate});
  // Đợt 8 (cách A, chạy lại): lần lưu trước có thể đã thêm xe rồi mất phản hồi. Xe chưa có mã trong form khớp một xe
  // hiện có của khách (ngoài danh sách giữ lại) theo biển số chuẩn hoá thì là CẬP NHẬT xe đó: không thêm xe trùng, không
  // gỡ rồi thêm lại xe vừa thêm. Mỗi xe hiện có khớp tối đa một xe trong form.
  const matched=new Map<(typeof vehicles)[number],string>();
  for(const v of vehicles){
    if(v.id)continue;
    const key=vehicleMatchKey(v);
    const hit=existing.find(row=>!keptIds.includes(row.id)&&![...matched.values()].includes(row.id)&&vehicleMatchKey(row)===key);
    if(hit)matched.set(v,hit.id);
  }
  const claimedIds=[...keptIds,...matched.values()];
  const removedIds=existingIds.filter(id=>!claimedIds.includes(id));
  if(removedIds.length){
    const {data,error}=await supabase.from('vehicles').update({deleted_at:new Date().toISOString()}).in('id',removedIds).select('id');
    if(error)throw error;
    const ids=confirmedRecordBatch(data,removedIds.length,'gỡ phương tiện');
    if(removedIds.some(id=>!ids.includes(id)))throw new Error('Chưa xác nhận đủ phương tiện được gỡ.');
    completed.push(...ids.map(id=>({id,label:'Đã gỡ phương tiện'})));
  }
  const updates=[...vehicles.flatMap(v=>v.id?[{v,id:v.id}]:[]),...[...matched].map(([v,id])=>({v,id}))];
  for(const {v,id:vehicleId} of updates){
    const {data,error}=await supabase.from('vehicles').update(fields(v)).eq('id',vehicleId).select('id').single();
    if(error)throw error;const id=confirmedRecordId(data,'cập nhật phương tiện',vehicleId);
    completed.push({id,label:'Đã cập nhật phương tiện'});
  }
  const added=vehicles.filter(v=>!v.id&&!matched.has(v));
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
  const refresh=()=>{for(const key of ['customers','vehicles'])queryClient.invalidateQueries({queryKey:[key]});};
  return useMutation({
    meta:{handlesFeedback:true},
    // Đợt 8 (luật 5): sửa khách là đặt giá trị theo mã, chạy lại cho cùng kết quả: không giữ dấu «chờ đối chiếu»; kết
    // quả chưa rõ báo rõ và cho lưu lại. Xe: gỡ / sửa theo mã lặp lại được, xe thêm ở lần trước được nhận lại theo biển số.
    mutationFn:async({id,data:formData}:{id:string;data:Partial<CustomerFormData>}):Promise<CreateCustomerResult>=>{
      const {vehicles,...customerData}=formData;
      vehicles?.forEach(vehicle=>validatedVehicleType(vehicle.vehicle_type));
      const customer=await repeatableWrite('cập nhật khách hàng',async()=>{
        const {data,error}=await supabase.from('customers').update(customerData as any).eq('id',id).select().single();
        if(error)throw error;confirmedRecordId(data,'cập nhật khách hàng',id);
        return data as unknown as Customer;
      });
      let vehicleError:FinancialWorkflowError|undefined;
      if(vehicles){
        // Khách đã cập nhật. Xe hỏng giữa chừng: báo «xe chưa xong», không giữ dấu; lưu lại cùng form đồng bộ tiếp.
        const completed:CompletedFinancialStep[]=[{id,label:'Đã cập nhật khách hàng'}];
        try{await syncCustomerVehicles(id,vehicles,selectedOrganizationId,completed);}
        catch(error){
          const reason=error instanceof FinancialWorkflowError?error.message:recordWriteMessage(error,'đồng bộ phương tiện');
          vehicleError=new FinancialWorkflowError(`Khách hàng đã cập nhật (mã ${id}) nhưng phương tiện chưa đồng bộ xong: ${reason} Bấm lưu lại để đồng bộ tiếp: xe đã lưu ở lần trước được nhận lại theo biển số, không tạo trùng.`,'partial',completed,error);
        }
      }
      // Lần ghi khách đã xác nhận: dấu bản trước của đúng khách này (công ty đang chọn) không còn chặn gì.
      try{const {forgetLegacyPending}=await import('@/lib/legacyPendingExit');await forgetLegacyPending({namespace:'customer-update',businessKey:id});}
      catch{/* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần ghi sau gỡ lại. */}
      return vehicleError?{customer,vehicleError}:{customer};
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

/** Kết quả xoá khách. `alreadyDeleted`: khách đã bị xoá trước lần bấm này (lần gửi trước mất phản hồi, hoặc người khác). */
export interface DeleteCustomerResult { id: string; deleted_at: string; alreadyDeleted?: boolean }

export const useDeleteCustomer = () => {
  const queryClient = useQueryClient();
  /** Đọc đúng khách: `null` khi không thấy (không có quyền xem); lỗi đọc ném nguyên; dòng lạ dạng là chưa rõ. */
  const readState = async (id: string): Promise<{ id: string; deleted_at: string | null } | null> => {
    const { data, error } = await supabase.from('customers').select('id, deleted_at').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.id !== id || (data.deleted_at !== null && (typeof data.deleted_at !== 'string' || !Number.isFinite(Date.parse(data.deleted_at))))) {
      throw new FinancialWorkflowError('Chưa đọc được trạng thái khách hàng. Tải lại danh sách rồi thử lại.', 'unknown', [{id, label:'Khách hàng cần đối chiếu'}]);
    }
    return data;
  };
  const forgetPrior = async (id: string) => {
    try { const { forgetLegacyPending } = await import('@/lib/legacyPendingExit'); await forgetLegacyPending({ namespace: 'customer-delete', businessKey: id }); }
    catch { /* Dấu bản trước không còn chặn gì; gỡ hỏng thì lần xoá sau gỡ lại. */ }
  };

  return useMutation({
    // Đợt 8 (luật 5, cách C «chưa xoá thì chạy lại»): xoá mềm theo mã lặp lại được nên không giữ dấu «chờ đối chiếu».
    // Đọc trạng thái trước: khách đã xoá thì báo thành công, không gửi lần nữa; chưa xoá thì gửi. Hàm xoá trên máy chủ chỉ
    // xoá khách còn sống (khoá dòng), nên gửi lại sau một lần mất phản hồi không xoá hai lần, không đổi giờ xoá.
    mutationFn: async (id: string): Promise<DeleteCustomerResult> => {
      const before = await readState(id);
      if (before?.deleted_at) { await forgetPrior(id); return { id, deleted_at: before.deleted_at, alreadyDeleted: true }; }
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

      return repeatableWrite('xoá khách hàng', async (): Promise<DeleteCustomerResult> => {
        const { error } = await supabase.rpc('soft_delete_customer' as any, { p_customer_id: id });
        if (error) {
          // Hàm production (md5 6ace1f95…) chỉ khoá khách CÒN SỐNG; khách đã xoá thì trả 42501 như khi không có quyền. Đọc
          // lại đúng khách: đã xoá ⇒ thành công «đã xoá trước đó»; còn nguyên ⇒ lời từ chối đi nguyên.
          if (String((error as { code?: unknown }).code ?? '') === '42501') {
            const after = await readState(id);
            if (after?.deleted_at) { await forgetPrior(id); return { id, deleted_at: after.deleted_at, alreadyDeleted: true }; }
          }
          throw error;
        }
        // RPC trả void: xác nhận trạng thái bằng lần đọc, không ghi lần nữa.
        const deleted = await readState(id);
        if (!deleted?.deleted_at) throw new FinancialWorkflowError('Yêu cầu xoá đã được gửi nhưng chưa xác nhận được trạng thái khách hàng.', 'unknown', [{id, label:'Khách hàng cần đối chiếu'}]);
        await forgetPrior(id);
        return { id, deleted_at: deleted.deleted_at };
      });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      toast.success(result.alreadyDeleted ? 'Khách hàng đã được xoá trước đó (lần gửi trước hoặc người khác đã xoá).' : 'Đã xác nhận xoá khách hàng');
    },
    onError: (error: any) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
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
