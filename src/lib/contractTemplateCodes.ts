// Contract template variable codes — 99 placeholders auto-substituted at print time.
// Grouped exactly as the CRM template-print spec lists them.

export interface TemplateCodeEntry {
  code: string;
  label: string;
}

export interface TemplateCodeSection {
  title: string;
  codes: TemplateCodeEntry[];
}

export const CONTRACT_TEMPLATE_CODE_SECTIONS: TemplateCodeSection[] = [
  {
    title: "Thông tin hợp đồng",
    codes: [
      { code: "{CONTRACT_NUMBER}", label: "Số hợp đồng" },
      { code: "{SIGN_DATE}", label: "Ngày ký (DD-MM-YYYY)" },
      { code: "{SIGN_DAY}", label: "Ngày ký (số)" },
      { code: "{SIGN_MONTH}", label: "Tháng ký (số)" },
      { code: "{SIGN_YEAR}", label: "Năm ký" },
      { code: "{BILLING_DATE}", label: "Ngày chốt hóa đơn" },
      { code: "{START_DATE}", label: "Ngày bắt đầu HĐ" },
      { code: "{END_DATE}", label: "Ngày kết thúc HĐ" },
      { code: "{CONTRACT_MONTH}", label: "Số tháng hợp đồng" },
      { code: "{CODE}", label: "Mã hợp đồng" },
      { code: "{NOTE}", label: "Ghi chú" },
      { code: "{END_DATE_BEFORE_30_DAYS}", label: "Trước 30 ngày hết HĐ" },
      { code: "{END_DAY}", label: "Ngày kết thúc" },
      { code: "{END_MONTH}", label: "Tháng KT" },
      { code: "{END_YEAR}", label: "Năm KT" },
    ],
  },
  {
    title: "Tòa nhà & Phòng",
    codes: [
      { code: "{APARTMENT_NAME}", label: "Tên tòa nhà" },
      { code: "{APARTMENT_ADDRESS}", label: "Địa chỉ tòa nhà" },
      { code: "{LOCATION_NAME}", label: "Tên vị trí/khu vực" },
      { code: "{ROOM_NAME}", label: "Tên phòng" },
      { code: "{ROOM_SIZE}", label: "Diện tích phòng (m²)" },
      { code: "{ROOM_NUMBER_BEDS}", label: "Số giường trong phòng" },
      { code: "{MAX_TENANTS}", label: "Số người tối đa" },
      { code: "{BED_NAME}", label: "Tên giường" },
      { code: "{FLOOR_NAME}", label: "Tên tầng" },
    ],
  },
  {
    title: "Giá thuê & Thanh toán",
    codes: [
      { code: "{RENT_PRICE}", label: "Giá thuê/tháng (VNĐ)" },
      { code: "{RENT_PRICE_TEXT}", label: "Giá thuê bằng chữ (VN)" },
      { code: "{RENT_PRICE_TEXT_EN}", label: "Giá thuê bằng chữ (EN)" },
      { code: "{RENT_PRICE_PER_SQUARE}", label: "Giá thuê/m²" },
      { code: "{RENT_PRICE_TWO_MONTHS}", label: "Tiền thuê 2 tháng" },
      { code: "{RENT_PRICE_THREE_MONTHS}", label: "Tiền thuê 3 tháng" },
      { code: "{RENT_PRICE_PER_YEAR}", label: "Tiền thuê/năm" },
      { code: "{RENT_PRICE_TWO_MONTH_TEXT}", label: "Tiền 2 tháng bằng chữ" },
      { code: "{RENT_PRICE_THREE_MONTH_TEXT}", label: "Tiền 3 tháng bằng chữ" },
      { code: "{RENT_PRICE_PER_YEAR_TEXT}", label: "Tiền/năm bằng chữ" },
      { code: "{RENT_PRICE_PER_MONTH_INCREASE_10_PERCENT}", label: "Giá thuê tăng 10%" },
      { code: "{RENT_PRICE_PER_MONTH_INCREASE_15_PERCENT}", label: "Giá thuê tăng 15%" },
      { code: "{RENT_PRICE_PER_YEAR_INCREASE_10_PERCENT}", label: "Giá/năm tăng 10%" },
      { code: "{RENT_PRICE_PER_YEAR_INCREASE_15_PERCENT}", label: "Giá/năm tăng 15%" },
      { code: "{RENT_PRICE_2_YEAR}", label: "Tiền thuê 2 năm" },
      { code: "{RENT_PRICE_2_YEAR_INCREASE_10_PERCENT}", label: "Tiền 2 năm tăng 10%" },
      { code: "{CONTRACT_PAYMENT_DAY}", label: "Ngày thanh toán" },
      { code: "{PAYMENT_PERIOD}", label: "Chu kỳ thanh toán (tháng)" },
      { code: "{PAYMENT_PERIOD_AND_DEPOSIT}", label: "Mô tả chu kỳ & cọc" },
      { code: "{FIRST_PERIOD_END_DATE}", label: "Ngày kết thúc kỳ đầu" },
    ],
  },
  {
    title: "Tiền cọc & Khuyến mãi",
    codes: [
      { code: "{DEPOSIT}", label: "Tiền cọc (VNĐ)" },
      { code: "{DEPOSIT_TEXT}", label: "Tiền cọc bằng chữ (VN)" },
      { code: "{DEPOSIT_TEXT_EN}", label: "Tiền cọc bằng chữ (EN)" },
      { code: "{DEPOSIT_MONTH}", label: "Số tháng cọc" },
      { code: "{DEPOSIT_MONTH_TEXT}", label: "Số tháng cọc bằng chữ" },
      { code: "{DEPOSIT_DATE}", label: "Ngày đặt cọc" },
      { code: "{DEPOSIT_NOTE}", label: "Ghi chú cọc" },
      { code: "{PROMOTION_MONTH}", label: "Số tháng khuyến mãi" },
      { code: "{PROMOTION_PRICE_PER_MONTH}", label: "Giá KM/tháng" },
    ],
  },
  {
    title: "Khách thuê",
    codes: [
      { code: "{REPRESENT_CODE}", label: "Mã người đại diện" },
      { code: "{REPRESENT_NAME}", label: "Tên người đại diện" },
      { code: "{REPRESENT_GENDER}", label: "Giới tính" },
      { code: "{REPRESENT_BIRTHDAY}", label: "Ngày sinh" },
      { code: "{REPRESENT_PHONE_NUMBER}", label: "Số điện thoại" },
      { code: "{REPRESENT_EMAIL}", label: "Email" },
      { code: "{REPRESENT_ID_NUMBER}", label: "CMND/CCCD" },
      { code: "{REPRESENT_PLACE_OF_ISSUE}", label: "Nơi cấp" },
      { code: "{REPRESENT_ID_NUMBER_DATE}", label: "Ngày cấp" },
      { code: "{REPRESENT_ADDRESS}", label: "Địa chỉ thường trú" },
      { code: "{REPRESENT_CURRENT_ADDRESS}", label: "Địa chỉ hiện tại" },
      { code: "{REPRESENT_WORKPLACE}", label: "Nơi làm việc" },
      { code: "{REPRESENT_CONTACT_NAME}", label: "Tên người liên hệ" },
      { code: "{REPRESENT_CONTACT_PHONE}", label: "SĐT liên hệ" },
      { code: "{REPRESENT_COUNTRY}", label: "Quốc tịch" },
      { code: "{REPRESENT_PASSPORT_NUMBER}", label: "Số hộ chiếu" },
      { code: "{REPRESENT_PASSPORT_DUE_DATE}", label: "Hạn hộ chiếu" },
      { code: "{REPRESENT_BUSINESS_DOMAIN}", label: "Lĩnh vực KD" },
      { code: "{REPRESENT_ACCOUNT_NUMBER}", label: "Số TK ngân hàng" },
      { code: "{REPRESENT_BANK_NAME}", label: "Tên ngân hàng" },
      { code: "{REPRESENT_CONSULTANT_NAME}", label: "Tên cố vấn" },
      { code: "{REPRESENT_CONSULTANT_PHONE}", label: "SĐT cố vấn" },
      { code: "{REPRESENT_BUSINESS_CODE}", label: "Mã số doanh nghiệp" },
    ],
  },
  {
    title: "Chủ nhà",
    codes: [
      { code: "{CHU_HOP_DONG}", label: "Chủ hợp đồng" },
      { code: "{OWNER_NAME}", label: "Tên chủ nhà" },
      { code: "{OWNER_PHONE}", label: "SĐT chủ nhà" },
      { code: "{OWNER_BIRTHDAY}", label: "Ngày sinh chủ nhà" },
      { code: "{OWNER_ID_NUMBER}", label: "CMND chủ nhà" },
      { code: "{OWNER_PLACE_OF_ISSUE}", label: "Nơi cấp (chủ nhà)" },
      { code: "{OWNER_ID_NUMBER_DATE}", label: "Ngày cấp (chủ nhà)" },
    ],
  },
  {
    title: "Thống kê & Dịch vụ",
    codes: [
      { code: "{NUMBER_TENANTS}", label: "Số người thuê" },
      { code: "{TOTAL_TENANTS}", label: "Tổng số người" },
      { code: "{NUMBER_VEHICLES}", label: "Số phương tiện" },
      { code: "{TOTAL_VEHICLES}", label: "Tổng PT" },
      { code: "{FINGER_PRINT_CODE}", label: "Mã vân tay" },
      { code: "{ELECTRIC_NUMBER}", label: "Chỉ số điện ban đầu" },
      { code: "{WATER_NUMBER}", label: "Chỉ số nước ban đầu" },
    ],
  },
  {
    title: "Thanh lý",
    codes: [
      { code: "{LIQUID_DATE}", label: "Ngày thanh lý" },
      { code: "{LIQUID_DAY}", label: "Ngày TL (số)" },
      { code: "{LIQUID_MONTH}", label: "Tháng TL" },
      { code: "{LIQUID_YEAR}", label: "Năm TL" },
    ],
  },
  {
    title: "Bảng dữ liệu",
    codes: [
      { code: "{#TENANTS_TABLE}...{/TENANTS_TABLE}", label: "Bảng người thuê" },
      { code: "{#ASSETS_TABLE}...{/ASSETS_TABLE}", label: "Bảng tài sản" },
      { code: "{#FEES_TABLE}...{/FEES_TABLE}", label: "Bảng phí DV" },
      { code: "{#VEHICLES_TABLE}...{/VEHICLES_TABLE}", label: "Bảng phương tiện" },
      { code: "{#fees}...{/fees}", label: "Danh sách phí" },
    ],
  },
];

export const TOTAL_CONTRACT_CODES = CONTRACT_TEMPLATE_CODE_SECTIONS.reduce(
  (sum, s) => sum + s.codes.length,
  0,
);
