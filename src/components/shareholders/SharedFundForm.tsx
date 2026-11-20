import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { todayISO } from '@/lib/collect';
import { formatVND } from '@/lib/utils';
import type { FundSourceKind, FundWrite, SharedFundState } from '@/hooks/profit-ledger/useSharedFund';

export type FundAction = FundWrite['action'];
const amountText = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().safe().nonnegative());
const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-2 text-sm';
const labelClass = 'grid gap-1 text-sm font-medium';
const sourceLabels: Record<FundSourceKind, string> = {
  OPENING: 'Số dư quỹ đầu kỳ',
  CREDIT: 'Tăng nguồn quỹ',
  DEBIT: 'Giảm nguồn quỹ',
};
export { sourceLabels };
const newLine = () => ({ person: '', gross: '', offset: '0' });
type FormData = {
  day: string;
  reference: string;
  evidence: string;
  kind: FundSourceKind;
  money: string;
  total: string;
  person: string;
  month: string;
  confirmed: boolean;
  lines: ReturnType<typeof newLine>[];
};

function requiredAmount(text: string, caption: string) {
  const value = amountText.safeParse(text);
  if (!value.success) throw new Error(caption + ' phải là số đồng nguyên từ 0 trở lên.');
  return value.data;
}

export function prepareFundWrite(
  action: FundAction,
  v: FormData,
  state: SharedFundState,
  today = todayISO(),
): FundWrite {
  const date = z.string().date().safeParse(v.day);
  if (!date.success || v.day > today) throw new Error('Chọn ngày ghi nhận hợp lệ đến hôm nay.');
  const evidence = v.evidence.trim(),
    reference = v.reference.trim();
  const minEvidence = action === 'opening' ? 8 : 1,
    maxEvidence = action === 'opening' ? 1000 : 2000;
  if (evidence.length < minEvidence || evidence.length > maxEvidence)
    throw new Error('Ghi căn cứ đối chiếu từ ' + minEvidence + ' đến ' + maxEvidence + ' ký tự.');
  if (action === 'opening') {
    const person = state.shareholders.find((r) => r.shareholder_id === v.person);
    if (!person || state.openings.some((r) => r.shareholder_id === v.person))
      throw new Error('Chọn cổ đông chưa ghi mốc ứng lịch sử.');
    const through = v.month + '-01';
    if (!z.string().date().safeParse(through).success || through >= today.slice(0, 7) + '-01')
      throw new Error('Chọn kỳ lợi nhuận đã kết thúc.');
    const last = new Date(through + 'T00:00:00Z');
    last.setUTCMonth(last.getUTCMonth() + 1);
    last.setUTCDate(0);
    if (v.day < last.toISOString().slice(0, 10))
      throw new Error('Ngày đối chiếu phải từ ngày cuối cùng của kỳ trở đi.');
    if (!v.confirmed) throw new Error('Xác nhận số dư thay thế lịch sử trước khi tiếp tục.');
    return {
      action,
      shareholderId: v.person,
      throughMonth: through,
      asOfDate: v.day,
      advance: requiredAmount(v.money, 'Ứng dư'),
      expectedUnpaid: person.unpaid_profit,
      expectedApproved: person.advance_outstanding,
      evidence,
    };
  }
  if (!reference || reference.length > 160)
    throw new Error('Điền số hoặc ký hiệu biên bản đối chiếu, tối đa 160 ký tự.');
  if (state.last_effective_date && v.day < state.last_effective_date)
    throw new Error('Ngày ghi nhận phải từ ngày quỹ ghi gần nhất trở đi.');
  const common = { effectiveDate: v.day, reference, evidence, expected: state.available_amount };
  if (action === 'source') {
    const amount = requiredAmount(v.money, 'Nguồn quỹ');
    if (v.kind === 'OPENING' ? state.has_opening : !state.has_opening || amount === 0)
      throw new Error('Kiểm tra loại nguồn và số tiền ghi quỹ.');
    if (v.kind === 'DEBIT' && amount > state.available_amount) throw new Error('Số giảm vượt quỹ khả dụng.');
    if (!v.confirmed) throw new Error('Xác nhận nguồn quỹ đã tách khỏi lợi nhuận cá nhân.');
    return { action, ...common, kind: v.kind, amount };
  }
  if (!state.has_opening || !v.lines.length)
    throw new Error('Mở số dư quỹ và thêm cổ đông trước khi phân bổ.');
  const seen = new Set<string>();
  const lines = v.lines.map((row) => {
    const person = state.shareholders.find((p) => p.shareholder_id === row.person);
    if (!person || seen.has(row.person)) throw new Error('Chọn một cổ đông khác nhau cho từng dòng.');
    seen.add(row.person);
    const amount = requiredAmount(row.gross, 'Phần được chia'),
      offset = requiredAmount(row.offset, 'Số cấn ứng');
    if (amount === 0 || offset > amount || offset > person.advance_outstanding)
      throw new Error('Kiểm tra phần chia và số cấn ứng của ' + person.name + '.');
    return { shareholder_id: row.person, amount, advance_offset_amount: offset };
  });
  const total = lines.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isSafeInteger(total) || total > state.available_amount)
    throw new Error('Tổng phân bổ vượt số quỹ khả dụng.');
  return { action, ...common, lines };
}

export default function SharedFundForm({
  action,
  state,
  onReview,
  onCancel,
}: {
  action: FundAction;
  state: SharedFundState;
  onReview: (op: FundWrite) => void;
  onCancel: () => void;
}) {
  const { register, control, watch, handleSubmit, setValue } = useForm<FormData>({
    defaultValues: {
      day: todayISO(),
      reference: '',
      evidence: '',
      kind: state.has_opening ? 'CREDIT' : 'OPENING',
      money: '',
      total: '',
      month: '',
      person: '',
      confirmed: false,
      lines: [newLine()],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const [error, setError] = useState('');
  const values = watch();
  const openingHolder =
    action === 'opening' ? state.shareholders.find((p) => p.shareholder_id === values.person) : undefined;
  const chooseEqual = () => {
    try {
      const total = requiredAmount(values.total, 'Tổng chia đều');
      if (!total || total > state.available_amount)
        throw new Error('Nhập tổng chia đều trong số quỹ khả dụng.');
      const people = values.lines.map((r) => r.person);
      if (people.some((p) => !p) || new Set(people).size !== people.length)
        throw new Error('Chọn các cổ đông trước khi chia đều.');
      const each = Math.floor(total / people.length);
      if (!each) throw new Error('Tổng chia phải đủ ít nhất 1 đồng mỗi người.');
      people.forEach((_, i) => setValue(`lines.${i}.gross`, String(each)));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kiểm tra số chia đều.');
    }
  };
  const submit = (v: FormData) => {
    try {
      const op = prepareFundWrite(action, v, state);
      setError('');
      onReview(op);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kiểm tra nội dung biểu mẫu.');
    }
  };
  return (
    <form className="grid gap-3 rounded-lg border p-4" onSubmit={handleSubmit(submit)}>
      <h3 className="font-semibold">
        {action === 'source'
          ? 'Ghi nguồn quỹ'
          : action === 'opening'
            ? 'Ghi mốc ứng lịch sử'
            : 'Phân bổ quỹ cho cổ đông'}
      </h3>
      {action === 'source' && (
        <label className={labelClass}>
          Loại nguồn
          <select className={selectClass} {...register('kind')}>
            {(state.has_opening ? (['CREDIT', 'DEBIT'] as const) : (['OPENING'] as const)).map((k) => (
              <option key={k} value={k}>
                {sourceLabels[k]}
              </option>
            ))}
          </select>
        </label>
      )}
      {action === 'opening' && (
        <>
          <label className={labelClass}>
            Cổ đông mở mốc
            <select className={selectClass} {...register('person')}>
              <option value="">Chọn cổ đông</option>
              {state.shareholders
                .filter((p) => !state.openings.some((o) => o.shareholder_id === p.shareholder_id))
                .map((p) => (
                  <option key={p.shareholder_id} value={p.shareholder_id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label className={labelClass}>
            Đã đối chiếu đến hết kỳ
            <Input type="month" required {...register('month')} />
          </label>
          {openingHolder && (
            <p className="text-sm text-muted-foreground">
              Sổ hiện có {formatVND(openingHolder.advance_outstanding)} ứng đã duyệt còn dư và{' '}
              {formatVND(openingHolder.unpaid_profit)} lợi nhuận chưa chi. Nhập số dư cuối cùng theo biên bản
              sau khi đối chiếu từng phiếu và ngày thực chi.
            </p>
          )}
        </>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          {action === 'opening' ? 'Ngày đối chiếu số dư' : 'Ngày ghi nhận'}
          <Input type="date" max={todayISO()} required {...register('day')} />
        </label>
        {action !== 'opening' && (
          <label className={labelClass}>
            Mã biên bản / chứng từ
            <Input required maxLength={160} {...register('reference')} />
          </label>
        )}
        {action !== 'distribute' && (
          <label className={labelClass}>
            {action === 'source' ? 'Số tiền nguồn quỹ (đồng)' : 'Ứng dư chuyển sang (đồng)'}
            <Input inputMode="numeric" required {...register('money')} />
          </label>
        )}
      </div>
      {action === 'distribute' && (
        <>
          {fields.map((field, i) => {
            const row = values.lines[i],
              person = state.shareholders.find((p) => p.shareholder_id === row?.person);
            const a = amountText.safeParse(row?.gross),
              b = amountText.safeParse(row?.offset);
            return (
              <fieldset key={field.id} className="grid gap-2 rounded-md border p-3">
                <legend className="px-1 text-sm">Cổ đông {i + 1}</legend>
                <div className="flex gap-2">
                  <select
                    aria-label={'Cổ đông ' + (i + 1)}
                    className={selectClass}
                    {...register(`lines.${i}.person`)}
                  >
                    <option value="">Chọn cổ đông</option>
                    {state.shareholders.map((p) => (
                      <option key={p.shareholder_id} value={p.shareholder_id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {fields.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => remove(i)}
                      aria-label={'Bỏ dòng ' + (i + 1)}
                    >
                      Bỏ
                    </Button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className={labelClass}>
                    Phần chia (đồng)
                    <Input required inputMode="numeric" {...register(`lines.${i}.gross`)} />
                  </label>
                  <label className={labelClass}>
                    Cấn ứng (đồng)
                    <Input required inputMode="numeric" {...register(`lines.${i}.offset`)} />
                  </label>
                </div>
                {person && (
                  <p className="text-sm text-muted-foreground">
                    Ứng còn dư {formatVND(person.advance_outstanding)}
                    {a.success && b.success && b.data <= a.data
                      ? ' · Phải trả ' + formatVND(a.data - b.data)
                      : ''}
                  </p>
                )}
              </fieldset>
            );
          })}
          <Button
            type="button"
            variant="outline"
            disabled={fields.length >= state.shareholders.length}
            onClick={() => append(newLine())}
          >
            Thêm cổ đông
          </Button>
          {fields.length > 1 && (
            <div className="flex flex-wrap items-end gap-2">
              <label className={labelClass}>
                Tổng muốn chia đều (đồng)
                <Input inputMode="numeric" {...register('total')} />
              </label>
              <Button type="button" variant="outline" onClick={chooseEqual}>
                Chia đều
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                Phần lẻ đồng giữ lại quỹ. Có thể sửa số của từng người.
              </p>
            </div>
          )}
        </>
      )}
      <label className={labelClass}>
        Căn cứ đối chiếu
        <Textarea
          required
          minLength={action === 'opening' ? 8 : 1}
          maxLength={action === 'opening' ? 1000 : 2000}
          {...register('evidence')}
        />
      </label>
      {action !== 'distribute' && (
        <label className="flex items-start gap-2 text-sm">
          <input className="mt-1" type="checkbox" {...register('confirmed')} />
          {action === 'opening'
            ? 'Tôi xác nhận lợi nhuận đến kỳ đã quyết toán. Ứng dư chuyển sang là toàn bộ số đã đối chiếu đến ngày ghi nhận, đã gồm các phiếu ứng CRM trong phạm vi này đúng một lần.'
            : 'Tôi xác nhận số nguồn đã tách khỏi lợi nhuận cá nhân và đã đối chiếu theo chứng từ.'}
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Xem lại trước khi ghi</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Đóng biểu mẫu
        </Button>
      </div>
    </form>
  );
}
