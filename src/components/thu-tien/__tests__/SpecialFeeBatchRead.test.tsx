import type {ReactNode} from 'react';
// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {SpecialFeeBatchDialog} from '../SpecialFeeBatchDialog';
vi.mock('@/hooks/useSpecialFeeBatch',()=>({FEE_LABEL:{wifi:'Wifi'},useSpecialFeePreview:()=>({data:[{buildingId:'b1',buildingName:'A',feeCategory:'wifi',amount:1000,status:'SẼ_SINH'}],isLoading:false,isError:false}),useGenerateSpecialFees:()=>({isPending:false,mutateAsync:vi.fn()})}));
vi.mock('@/hooks/useAccounts',()=>({useAccounts:()=>({data:undefined,isError:true,isPending:false,refetch:vi.fn()})}));
vi.mock('@/components/ui/select',()=>({Select:({children}:{children:ReactNode})=><div>{children}</div>,SelectContent:({children}:{children:ReactNode})=><div>{children}</div>,SelectItem:({children}:{children:ReactNode})=><span>{children}</span>,SelectTrigger:({children}:{children:ReactNode})=><button>{children}</button>,SelectValue:()=>null}));
afterEach(cleanup);
it('giải thích và cho tải lại sổ quỹ thay vì chỉ khóa nút sinh phiếu',()=>{render(<SpecialFeeBatchDialog open onOpenChange={()=>{}} period="2026-09"/>);expect(screen.getByText(/Chưa tải được danh sách sổ quỹ/)).toBeTruthy();expect(screen.getByRole('button',{name:'Tải lại sổ quỹ'})).toBeTruthy();expect((screen.getByRole('button',{name:'Sinh 1 phiếu chờ duyệt'}) as HTMLButtonElement).disabled).toBe(true);});
