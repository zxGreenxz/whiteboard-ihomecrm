/**
 * One-shot helper: create the income-expense-attachments storage bucket.
 *
 * Run with the SERVICE ROLE key (keeps the anon key safe):
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node scripts/setup-attachment-bucket.mjs
 *
 * Find the service role key in Supabase Dashboard → Project Settings → API.
 * Do NOT commit it.
 */
import { createClient } from '@supabase/supabase-js';

const url =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  'https://tryymsxyyckgbrmmvozx.supabase.co';
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

if (!serviceKey) {
  console.error('Thiếu SUPABASE_SERVICE_ROLE_KEY env var.');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

const BUCKET = 'income-expense-attachments';

const { data: existing } = await supabase.storage.getBucket(BUCKET);
if (existing) {
  console.log('OK — bucket đã tồn tại:', existing.id, 'public=', existing.public);
} else {
  const { data, error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  });
  if (error) {
    console.error('Lỗi tạo bucket:', error);
    process.exit(1);
  }
  console.log('Tạo bucket xong:', data);
}

// Quick smoke: list buckets
const { data: list } = await supabase.storage.listBuckets();
console.log(
  'Buckets hiện tại:',
  list?.map((b) => `${b.name}${b.public ? ' (public)' : ''}`).join(', ')
);
console.log(
  '\n→ Để upload từ client (anon) bạn vẫn cần RLS policy trên storage.objects.'
);
console.log(
  '   Migration 20260426000002 đã thêm policies; nếu chưa apply, mở Supabase SQL Editor và chạy lại file đó.'
);
