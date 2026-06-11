import { useMemo } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { RECIPIENT_BANKS } from "@/lib/vietqrDeeplink";

interface Props {
  /** Giá trị lưu = shortName của bank ("VietinBank", "MB Bank"...). */
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

/**
 * Dropdown chọn ngân hàng người nhận (gõ-để-tìm, khớp cả tên không dấu/alias
 * như "viettinbank"). Lưu shortName dạng text vào receive_bank_name —
 * PayViaBankAppSheet nhận diện lại qua matchRecipientBankCode.
 */
export function BankSelect({
  value,
  onChange,
  disabled,
  className,
  placeholder = "Chọn ngân hàng",
}: Props) {
  const options = useMemo(
    () =>
      RECIPIENT_BANKS.map((b) => ({
        value: b.shortName,
        label: b.shortName,
        keywords: b.aliases,
      })),
    []
  );

  return (
    <SearchableSelect
      value={value || undefined}
      onValueChange={onChange}
      options={options}
      placeholder={placeholder}
      searchPlaceholder="Gõ tên ngân hàng..."
      emptyText="Không tìm thấy ngân hàng"
      className={className}
      disabled={disabled}
      aria-label="Ngân hàng người nhận"
    />
  );
}

export default BankSelect;
