/** Format only a verified YYYY-MM-DD value; avoid timezone shifts from Date parsing. */
function displayDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  // The verified expression has exactly three numeric capture groups.
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function contractBillingBoundMessages(startDate?: string, endDate?: string) {
  const start = startDate && displayDate(startDate);
  const end = endDate && displayDate(endDate);
  return {
    start_billing_date: start
      ? `Ngày bắt đầu tính tiền không được trước ${start} (ngày bắt đầu hợp đồng).`
      : 'Ngày bắt đầu tính tiền không được trước ngày bắt đầu hợp đồng.',
    end_billing_date: end
      ? `Ngày kết thúc tính tiền không được sau ${end} (ngày kết thúc hợp đồng).`
      : 'Ngày kết thúc tính tiền không được sau ngày kết thúc hợp đồng.',
  };
}
