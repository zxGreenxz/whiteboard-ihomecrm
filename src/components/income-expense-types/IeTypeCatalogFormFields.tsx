// Ô danh mục chi chuẩn (03/10/2026) dùng chung cho form Thêm/Sửa hạng mục: cụm từ hay nói,
// thứ tự, ẩn khỏi Báo chi nhanh; khi sửa thêm "Lưu trữ / gộp vào". Chỉ superadmin / chủ
// công ty mở được các form này (cờ useCanManageIeTypes) — máy chủ chặn người khác bằng RLS.
import type { Control } from 'react-hook-form';
import { useWatch } from 'react-hook-form';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { IncomeExpenseTypeFormValues } from '@/lib/incomeExpenseValidation';
import type { IncomeExpenseType } from '@/hooks/useIncomeExpenseTypes';
import { sortIeTypesForPicker } from '@/lib/ieTypeCatalog';
import { mergeTargetCandidates, mergedSourceCount } from '@/lib/ieTypeCatalogDraft';

const NO_MERGE = '__none__';

interface IeTypeCatalogFormFieldsProps {
  control: Control<IncomeExpenseTypeFormValues>;
  /** Hạng mục đang sửa — có thì hiện thêm khối "Lưu trữ / gộp vào". */
  editing?: Pick<IncomeExpenseType, 'id' | 'type' | 'merged_into_id'> | null;
  /** Danh sách hạng mục để chọn đích gộp (cùng tổ chức, đã lọc ở hook). */
  allTypes?: readonly IncomeExpenseType[];
}

const IeTypeCatalogFormFields = ({ control, editing, allTypes = [] }: IeTypeCatalogFormFieldsProps) => {
  const watchedType = useWatch({ control, name: 'type' });
  const archived = useWatch({ control, name: 'archived' }) === true;
  const currentType = watchedType ?? editing?.type;
  const candidates = editing && currentType
    ? sortIeTypesForPicker(mergeTargetCandidates(allTypes, { id: editing.id, type: currentType }))
    : [];
  // Đích đang lưu mà không còn trong danh sách (vd đã bị lưu trữ) vẫn phải hiện để không trắng ô.
  const savedTarget = editing?.merged_into_id && !candidates.some((t) => t.id === editing.merged_into_id)
    ? allTypes.find((t) => t.id === editing.merged_into_id)
    : undefined;
  const sources = editing ? mergedSourceCount(allTypes, editing.id) : 0;

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Danh mục chuẩn</p>
      <FormField
        control={control}
        name="keywords_text"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Cụm từ hay nói</FormLabel>
            <FormControl>
              <Input placeholder="VD: bơm gas, xả giàn, thợ điện lạnh" {...field} value={field.value ?? ''} />
            </FormControl>
            <p className="text-xs text-muted-foreground">
              Cách nhau bằng dấu phẩy. Ô tìm hạng mục và Báo chi nhanh dùng để nhận ra hạng mục này.
            </p>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="sort_order_text"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Thứ tự trong ô chọn</FormLabel>
            <FormControl>
              <Input inputMode="numeric" placeholder="Để trống = xếp cuối theo tên" {...field} value={field.value ?? ''} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="quick_entry_hidden"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between gap-3 space-y-0">
            <div className="space-y-0.5 leading-tight">
              <FormLabel className="cursor-pointer">Ẩn khỏi Báo chi nhanh</FormLabel>
              <p className="text-xs text-muted-foreground">Vẫn chọn được khi lập phiếu ở trang Thu chi.</p>
            </div>
            <FormControl>
              <Switch checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />
            </FormControl>
          </FormItem>
        )}
      />

      {editing && (
        <div className="space-y-3 border-t pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lưu trữ / gộp vào</p>
          <FormField
            control={control}
            name="archived"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between gap-3 space-y-0">
                <div className="space-y-0.5 leading-tight">
                  <FormLabel className="cursor-pointer">Lưu trữ hạng mục</FormLabel>
                  <p className="text-xs text-muted-foreground">
                    Ẩn khỏi mọi ô chọn. Phiếu cũ giữ nguyên hạng mục này.
                  </p>
                </div>
                <FormControl>
                  <Switch checked={field.value === true} onCheckedChange={(v) => field.onChange(v === true)} />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="merged_into_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Gộp vào</FormLabel>
                <Select
                  value={field.value || NO_MERGE}
                  onValueChange={(v) => field.onChange(v === NO_MERGE ? null : v)}
                  disabled={sources > 0}
                >
                  <FormControl>
                    <SelectTrigger aria-label="Gộp vào hạng mục">
                      <SelectValue placeholder="Không gộp" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_MERGE}>Không gộp</SelectItem>
                    {savedTarget && (
                      <SelectItem value={savedTarget.id}>{savedTarget.name} (đã lưu trữ)</SelectItem>
                    )}
                    {candidates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {sources > 0
                    ? `Đang có ${sources} hạng mục gộp vào mục này nên không gộp tiếp được (chỉ gộp một bậc).`
                    : archived
                      ? 'Báo cáo cộng số của mục này vào hạng mục được chọn.'
                      : 'Tuỳ chọn: báo cáo cộng số của mục này vào hạng mục được chọn.'}
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}
    </div>
  );
};

export default IeTypeCatalogFormFields;
