import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { useProvinces, useDistricts, useWards } from '@/hooks/useAddressData';
import { useId } from 'react';
interface Props { provinceValue?: string | null; districtValue?: string | null; wardValue?: string | null; onProvinceChange: (value: string) => void; onDistrictChange: (value: string) => void; onWardChange: (value: string) => void }
const optionsWithUnknown = (items: Array<{ code: number; name: string }>, value?: string | null): SearchableSelectOption[] => {
  const options = items.map(({ code, name }) => ({ value: String(code), label: name }));
  return value && !options.some((option) => option.value === value) ? [{ value, label: value }, ...options] : options;
};
export default function AddressCascadingDropdowns(props: Props) {
  const idPrefix = useId();
  const pq = useProvinces(); const dq = useDistricts(props.provinceValue); const wq = useWards(props.districtValue);
  const fields = [
    { label: 'Tỉnh/Thành phố', value: props.provinceValue, options: optionsWithUnknown(pq.provinces, props.provinceValue), loading: pq.isLoading, error: pq.error, retry: pq.retry, placeholder: 'Chọn Tỉnh/TP', search: 'Tìm tỉnh/thành phố...', disabled: false, change: (v: string) => { props.onProvinceChange(v); props.onDistrictChange(''); props.onWardChange(''); } },
    { label: 'Quận/Huyện', value: props.districtValue, options: optionsWithUnknown(dq.districts, props.districtValue), loading: dq.isLoading, error: dq.error, retry: dq.retry, placeholder: 'Chọn Quận/Huyện', search: 'Tìm quận/huyện...', disabled: !props.provinceValue, change: (v: string) => { props.onDistrictChange(v); props.onWardChange(''); } },
    { label: 'Xã/Phường', value: props.wardValue, options: optionsWithUnknown(wq.wards, props.wardValue), loading: wq.isLoading, error: wq.error, retry: wq.retry, placeholder: 'Chọn Xã/Phường', search: 'Tìm xã/phường...', disabled: !props.districtValue, change: props.onWardChange },
  ];
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-3">{fields.map((field, index) => { const id = `${idPrefix}-${index}`; return <div className="space-y-1.5" key={field.label}><label htmlFor={id} className="text-sm font-medium text-gray-700">{field.label}</label><SearchableSelect id={id} aria-label={field.label} value={field.value ?? ''} onValueChange={field.change} options={field.options} disabled={field.disabled || field.loading} placeholder={field.loading ? 'Đang tải...' : field.placeholder} searchPlaceholder={field.search} contentClassName="z-[100]" />{field.error && <button type="button" className="text-xs text-red-600 underline" onClick={() => void field.retry()}>Tải lại dữ liệu</button>}</div>; })}</div>;
}
