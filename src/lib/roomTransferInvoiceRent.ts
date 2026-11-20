export const transferRentPeriodNote = 'Tiền phòng đã tính theo ngày chuyển. Khoảng ngày nhập ở đây dùng để chia tiền nước và phí dịch vụ.';

export function transferRentMismatch(expected: number | undefined, entered: number) {
  return expected !== undefined && expected !== entered
    ? `Tiền thuê kỳ chuyển phòng phải bằng ${expected.toLocaleString('vi-VN')} đ. Hãy dùng mức đã tính.`
    : null;
}
