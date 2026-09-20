import type {SettlementFinancialContext} from '@/lib/contractSettlementFinancialContext';
import type {SettlementMoneyFact} from '@/lib/contractSettlementFinancialFacts';
import {formatVND} from '@/lib/utils';
/** Shared read-safe business note; raw notes/supplements/history remain separate. */
export function SettlementFinancialNote({context}:{context:SettlementFinancialContext}){
 const rows:[string,SettlementMoneyFact][]=[['Cọc phải đóng',context.depositRequired],['Cọc thực thu',context.depositReceived],['Tiền khác thực thu (gồm khoản giữ hộ, ngoài doanh thu)',context.otherReceived],[`Công nợ hiện tại — theo hóa đơn, đọc ${context.today}`,context.currentDebt]];
 if(context.terminationId)rows.push(['Công nợ theo hồ sơ thanh lý',context.terminationDebt],['Nghĩa vụ hoàn',context.refundOwed],['Thực hoàn',context.refunded],['Còn phải hoàn',context.refundRemaining]);
 return <section className="space-y-2 text-sm" aria-label="Thông tin nghiệp vụ đã đối chiếu">
  <div>{context.notes?.contractNumber??'Nguồn chưa có hợp đồng'} · Phòng {context.notes?.roomName??'chưa xác minh'}</div>
  <div>Ngày ký: {context.notes?.signedDate??'Chưa xác minh'} · Thời gian thuê: {context.notes?.startDate??'—'} — {context.notes?.endDate??'—'}</div>
  {context.termination?<div>Thanh lý: {context.termination.date??'Chưa xác minh'} · {context.termination.status}</div>:null}
  <dl className="space-y-1">{rows.map(([label,value])=><div key={label} className="flex justify-between gap-3"><dt>{label}</dt><dd className="whitespace-nowrap">{value.state==='verified'?formatVND(value.amount):'Chưa xác minh'}</dd></div>)}</dl>
  {context.termination?.notes?<details><summary>Ghi chú hồ sơ thanh lý — tham khảo</summary><div className="whitespace-pre-line">{context.termination.notes}</div></details>:null}
  {context.terminationId?<p className="text-muted-foreground">Chọn sổ tại bước chi tiền khi thao tác đó sẵn sàng.</p>:null}
 </section>;
}
