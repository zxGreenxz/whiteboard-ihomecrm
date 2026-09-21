import type {SettlementFinancialContext} from '@/lib/contractSettlementFinancialContext';
import type {SettlementMoneyFact} from '@/lib/contractSettlementFinancialFacts';
import {formatVND} from '@/lib/utils';
import {buildTerminationCardFromBreakdown} from '@/lib/terminationRefundNote';
/** Shared read-safe business note; raw notes/supplements/history remain separate. */
export function SettlementFinancialNote({context}:{context:SettlementFinancialContext}){
 const rows:[string,SettlementMoneyFact][]=[['Cọc phải đóng',context.depositRequired],['Cọc thực thu',context.depositReceived],['Tiền khác thực thu (gồm khoản giữ hộ, ngoài doanh thu)',context.otherReceived],[`Công nợ hiện tại — theo hóa đơn, đọc ${context.today}`,context.currentDebt]];
 if(context.terminationId)rows.push(['Công nợ theo hồ sơ thanh lý',context.terminationDebt],['Nghĩa vụ hoàn',context.refundOwed],['Thực hoàn',context.refunded],['Còn phải hoàn',context.refundRemaining]);
 const detail=context.terminationBreakdown.state==='verified'?context.terminationBreakdown.value:null;
 const targetVoucher=context.voucherId?context.receipts.find(receipt=>receipt.id===context.voucherId):null;
 const card=detail?buildTerminationCardFromBreakdown(detail,targetVoucher?.amount??null):null;
 return <section className="space-y-2 text-sm" aria-label="Thông tin nghiệp vụ đã đối chiếu">
  <div>{context.notes?.contractNumber??'Nguồn chưa có hợp đồng'} · Phòng {context.notes?.roomName??'chưa xác minh'}</div>
  <div>Ngày ký: {context.notes?.signedDate??'Chưa xác minh'} · Thời gian thuê: {context.notes?.startDate??'—'} — {context.notes?.endDate??'—'}</div>
  {context.termination?<div>Thanh lý: {context.termination.date??'Chưa xác minh'} · {context.termination.status}</div>:null}
  <dl className="space-y-1">{rows.map(([label,value])=><div key={label} className="flex justify-between gap-3"><dt>{label}</dt><dd className="whitespace-nowrap">{value.state==='verified'?formatVND(value.amount):'Chưa xác minh'}</dd></div>)}</dl>
 {card?<section className="rounded-lg border p-3 space-y-2" aria-label="Chi tiết quyết toán thanh lý">
   <h3 className="font-semibold">Chi tiết quyết toán thanh lý</h3>
   <div className="flex justify-between gap-3"><span>Ngày trả phòng thực tế</span><span>{detail?.actualMoveOutDate?detail.actualMoveOutDate.split('-').reverse().join('/'):'Chưa xác minh'}</span></div>
   <dl className="space-y-1">{card.rows.map(row=><div key={row.label}>
    <div className="flex justify-between gap-3"><dt>{row.label}</dt><dd className="whitespace-nowrap">{formatVND(row.amount)}</dd></div>
    {row.sub?.map(item=><div key={`${row.label}:${item.label}`} className="flex justify-between gap-3 pl-4 text-muted-foreground"><dt>{item.label}</dt><dd className="whitespace-nowrap">{formatVND(item.amount)}</dd></div>)}
   </div>)}</dl>
   <div className="flex justify-between gap-3 border-t pt-2 font-semibold"><span>Tổng khấu trừ</span><span>{formatVND(card.totalDeductions)}</span></div>
   <div className="flex justify-between gap-3 rounded-md bg-emerald-50 px-3 py-2 font-semibold text-emerald-800"><span>{card.netLabel}</span><span>{formatVND(Math.abs(card.net))}</span></div>
   {card.warning?<p role="alert" className="text-amber-700">{card.warning}</p>:null}
  </section>:context.terminationId?<p className="text-muted-foreground">Chưa tải đủ chi tiết các khoản quyết toán thanh lý.</p>:null}
  {context.termination?.notes?<details><summary>Ghi chú hồ sơ thanh lý — tham khảo</summary><div className="whitespace-pre-line">{context.termination.notes}</div></details>:null}
  {context.terminationId?<p className="text-muted-foreground">Chọn sổ tại bước chi tiền khi thao tác đó sẵn sàng.</p>:null}
 </section>;
}
