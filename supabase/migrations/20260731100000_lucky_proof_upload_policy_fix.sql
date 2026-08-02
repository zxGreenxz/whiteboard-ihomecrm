-- =============================================
-- Migration: Vá policy upload giấy cọc — anon không upload được.
--
-- GOTCHA (mất 1 lần cắn): policy trên storage.objects được đánh giá DƯỚI QUYỀN
-- NGƯỜI GỌI (anon). Điều kiện cũ có subquery đọc thẳng `public.lucky_events`,
-- mà bảng đó bật RLS và KHÔNG có policy nào → subquery luôn trả 0 dòng với
-- anon ⇒ mọi upload bị "new row violates row-level security policy" (403).
--
-- Sửa: bọc phép kiểm vào hàm SECURITY DEFINER (chạy quyền owner, xuyên RLS)
-- rồi gọi từ policy. Đây là khuôn chung cho MỌI policy cần đọc bảng RLS-kín.
-- =============================================

-- Kiểm "thư mục gốc có phải một sự kiện còn mở không".
-- plpgsql (không phải sql) để nuốt lỗi cast khi tên thư mục không phải uuid.
create or replace function public.lucky_event_open_v1(p_folder text)
returns boolean
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_id uuid;
begin
  if p_folder is null or p_folder = '' then
    return false;
  end if;
  begin
    v_id := p_folder::uuid;
  exception when others then
    return false;                      -- thư mục rác, không phải uuid
  end;
  return exists (
    select 1 from public.lucky_events
    where id = v_id and status <> 'closed'
  );
end;
$$;

comment on function public.lucky_event_open_v1(text) is
'Dùng trong policy INSERT của bucket lucky-proofs: policy chạy dưới quyền anon nên không tự đọc được lucky_events (RLS kín) — phải qua SECURITY DEFINER.';

revoke execute on function public.lucky_event_open_v1(text) from public;
grant execute on function public.lucky_event_open_v1(text) to anon, authenticated;

drop policy if exists "lucky proofs upload" on storage.objects;
create policy "lucky proofs upload"
  on storage.objects for insert to anon, authenticated
  with check (
    bucket_id = 'lucky-proofs'
    and public.lucky_event_open_v1((storage.foldername(name))[1])
  );
