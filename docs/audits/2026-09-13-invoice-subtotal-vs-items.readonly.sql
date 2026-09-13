-- Chỉ đọc. Không ghi. So tạm tính đã lưu (invoices.subtotal) với tổng thành tiền
-- các dòng (invoice_items.amount), và soát dòng có amount ≠ đơn giá × số lượng × hệ số.
-- Mục đích: quyết định trước khi vá create_invoice_v1/update_invoice_v1 (guard tạm tính)
-- xem đã có hoá đơn nào lệch trong sổ chưa. Kết quả ghi ở file .md cùng tên.
SELECT i.organization_id, i.status, i.kind,
       count(*) AS so_hoa_don,
       count(*) FILTER (WHERE abs(coalesce(i.subtotal,0) - s.sum_amount) >= 0.01) AS lech_tam_tinh,
       count(*) FILTER (WHERE s.bad_lines > 0) AS co_dong_amount_sai
FROM public.invoices i
JOIN LATERAL (
  SELECT coalesce(sum(it.amount),0) AS sum_amount,
         count(*) FILTER (WHERE abs(coalesce(it.amount,0) - coalesce(it.unit_price,0)*coalesce(it.quantity,1)*coalesce(it.coefficient,1)) >= 0.01) AS bad_lines
  FROM public.invoice_items it WHERE it.invoice_id = i.id
) s ON true
WHERE i.deleted_at IS NULL
GROUP BY 1,2,3 ORDER BY 1,2,3;
