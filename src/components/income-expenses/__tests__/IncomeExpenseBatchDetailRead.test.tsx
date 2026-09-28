// @vitest-environment jsdom
import { cleanup,render,screen } from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import type {IncomeExpenseBatchSummary} from "@/hooks/useIncomeExpenses";
const state=vi.hoisted(()=>({data:null as unknown,isFetching:true,isFetchedAfterMount:false,isSuccess:false,refetch:vi.fn()}));
vi.mock("@/hooks/useVoucherDetail",()=>({useVoucherWithBatch:()=>state}));
vi.mock("@/hooks/useIncomeExpenses",()=>({useUpdateBatchAccount:()=>({mutate:vi.fn(),isPending:false})}));
vi.mock("@/hooks/useIsAdmin",()=>({useIsAdmin:()=>({data:true})}));
vi.mock("@/hooks/useAccounts",()=>({useAccounts:()=>({data:[]})}));
vi.mock("@/components/ui/attachment-lightbox",()=>({AttachmentLightbox:()=>null}));
vi.mock("../IncomeExpenseDetailMobile",()=>({default:()=>null}));
vi.mock("../BatchAccountReasonDialog",()=>({default:()=>null}));
import {IncomeExpenseBatchDetailMobile} from "../IncomeExpenseBatchDetailMobile";
const batch={id:"batch",name:"Cached batch",type:"INCOME",total_amount:100,voucher_count:1,building_names:[],attachments:[],vouchers:[{id:"v",items:[],total_amount:100,approval_status:"UNAPPROVED",account_id:"a"}],has_approved:false,all_cancelled:false} as unknown as IncomeExpenseBatchSummary;
afterEach(cleanup);
it("does not expose cached batch amounts or account actions during detail refresh",()=>{state.isFetching=true;render(<IncomeExpenseBatchDetailMobile batch={batch} onClose={()=>{}}/>);expect(screen.queryByText("Cached batch")).toBeNull();expect(screen.getByText("Đang tải chi tiết đợt…")).toBeTruthy();});
it("shows retry when batch detail is unavailable",()=>{state.isFetching=false;state.isFetchedAfterMount=true;state.isSuccess=false;render(<IncomeExpenseBatchDetailMobile batch={batch} onClose={()=>{}}/>);expect(screen.queryByText("Cached batch")).toBeNull();expect(screen.getByText("Thử lại")).toBeTruthy();});
