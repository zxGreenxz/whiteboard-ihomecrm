import { useId } from 'react';
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { useDistricts, useProvinces, useWards } from '@/hooks/useAddressData';

interface AddressCascadingDropdownsProps {
  provinceValue?: string | null;
  districtValue?: string | null;
  wardValue?: string | null;
  onProvinceChange: (value: string) => void;
  onDistrictChange: (value: string) => void;
  onWardChange: (value: string) => void;
}

interface AddressFieldProps {
  id: string;
  label: string;
  value?: string | null;
  options: SearchableSelectOption[];
  loading: boolean;
  error: Error | null;
  retry: () => unknown;
  disabled: boolean;
  placeholder: string;
  searchPlaceholder: string;
  onChange: (value: string) => void;
}

function optionsWithUnknown(
  items: Array<{ code: number; name: string }>,
  value?: string | null,
): SearchableSelectOption[] {
  const options = items.map(({ code, name }) => ({ value: String(code), label: name }));
  return value && !options.some((option) => option.value === value)
    ? [{ value, label: value }, ...options]
    : options;
}

function AddressField({
  id,
  label,
  value,
  options,
  loading,
  error,
  retry,
  disabled,
  placeholder,
  searchPlaceholder,
  onChange,
}: AddressFieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">{label}</label>
      <SearchableSelect modal
        id={id}
        aria-label={label}
        value={value ?? ''}
        onValueChange={onChange}
        options={options}
        disabled={disabled || loading}
        placeholder={loading ? 'Đang tải...' : placeholder}
        searchPlaceholder={searchPlaceholder}
        contentClassName="z-[100]"
      />
      {error && (
        <div role="status" className="space-y-1 text-xs text-red-600">
          <p>Không tải được {label.toLocaleLowerCase('vi-VN')}.</p>
          <button
            type="button"
            className="underline"
            aria-label={`Tải lại ${label.toLocaleLowerCase('vi-VN')}`}
            onClick={() => void retry()}
          >
            Tải lại
          </button>
        </div>
      )}
    </div>
  );
}

export default function AddressCascadingDropdowns({
  provinceValue,
  districtValue,
  wardValue,
  onProvinceChange,
  onDistrictChange,
  onWardChange,
}: AddressCascadingDropdownsProps) {
  const idPrefix = useId();
  const provincesQuery = useProvinces();
  const districtsQuery = useDistricts(provinceValue);
  const wardsQuery = useWards(districtValue);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <AddressField
        id={`${idPrefix}-province`}
        label="Tỉnh/Thành phố"
        value={provinceValue}
        options={optionsWithUnknown(provincesQuery.provinces, provinceValue)}
        loading={provincesQuery.isLoading}
        error={provincesQuery.error}
        retry={provincesQuery.retry}
        disabled={false}
        placeholder="Chọn Tỉnh/TP"
        searchPlaceholder="Tìm tỉnh/thành phố..."
        onChange={(value) => {
          onProvinceChange(value);
          onDistrictChange('');
          onWardChange('');
        }}
      />
      <AddressField
        id={`${idPrefix}-district`}
        label="Quận/Huyện"
        value={districtValue}
        options={optionsWithUnknown(districtsQuery.districts, districtValue)}
        loading={districtsQuery.isLoading}
        error={districtsQuery.error}
        retry={districtsQuery.retry}
        disabled={!provinceValue}
        placeholder="Chọn Quận/Huyện"
        searchPlaceholder="Tìm quận/huyện..."
        onChange={(value) => {
          onDistrictChange(value);
          onWardChange('');
        }}
      />
      <AddressField
        id={`${idPrefix}-ward`}
        label="Xã/Phường"
        value={wardValue}
        options={optionsWithUnknown(wardsQuery.wards, wardValue)}
        loading={wardsQuery.isLoading}
        error={wardsQuery.error}
        retry={wardsQuery.retry}
        disabled={!districtValue}
        placeholder="Chọn Xã/Phường"
        searchPlaceholder="Tìm xã/phường..."
        onChange={onWardChange}
      />
    </div>
  );
}
