import { FormProvider, type UseFormReturn } from 'react-hook-form';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { BuildingLegalOwner } from '@/lib/buildingLegalOwner';

interface Props {
  form: UseFormReturn<BuildingLegalOwner>;
  loading: boolean;
  error: string | null;
  retry: () => void;
}
export function BuildingLegalOwnerFields({ form, loading, error, retry }: Props) {
  return <section className="space-y-4 rounded-lg border p-4" aria-label="Chủ sở hữu pháp lý">
    <h3 className="font-semibold text-sm">Chủ sở hữu pháp lý (bên cho thuê)</h3>
    <p className="text-sm text-muted-foreground">Người đứng tên sở hữu tòa nhà, dùng làm bên A trong hợp đồng thuê.</p>
    {loading ? <p role="status">Đang tải chủ sở hữu...</p> : error ? <div role="alert">{error} <Button type="button" variant="outline" onClick={retry}>Tải lại</Button></div> :
      <FormProvider {...form}><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {([
          ['full_name', 'Họ tên chủ sở hữu', 'text'],
          ['birth_year', 'Năm sinh chủ sở hữu', 'number'],
          ['id_number', 'CCCD/CMND chủ sở hữu', 'text'],
          ['id_issue_date', 'Ngày cấp CCCD/CMND', 'date'],
          ['id_issue_place', 'Nơi cấp CCCD/CMND', 'text'],
          ['permanent_address', 'Địa chỉ thường trú chủ sở hữu', 'text'],
        ] as const).map(([name, label, type]) => <FormField key={name} control={form.control} name={name} render={({ field }) =>
          <FormItem><FormLabel>{label}</FormLabel><FormControl><Input {...field} type={type} value={field.value ?? ''}
            onChange={event => field.onChange(name === 'birth_year' ? (event.target.value === '' ? null : Number(event.target.value)) : name === 'id_issue_date' ? event.target.value || null : event.target.value)}
            autoComplete="off" /></FormControl><FormMessage /></FormItem>
        } />)}
      </div></FormProvider>}
  </section>;
}
