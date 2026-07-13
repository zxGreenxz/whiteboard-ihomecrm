// Edge function: admin-create-user
// Cho phép super_admin tạo user mới qua Supabase Admin API.
// Phải verify caller là super_admin trước khi gọi auth.admin.createUser.
//
// Endpoint POST với body:
//   { email: string, password: string, full_name?: string, phone?: string }
//
// Trả về { user: {id, email}, success: true } hoặc { error: string }.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.81.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface CreateUserRequest {
  email: string;
  password: string;
  full_name?: string;
  phone?: string;
  // Metadata bổ sung để handle_new_user() dựng profiles đầy đủ (thay browser signUp).
  username?: string;
  contact_email?: string;
  employee_code?: string;
  department?: string;
  job_title?: string;
  is_active?: boolean;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // 1) Verify caller bằng JWT từ header (anon client + getUser)
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2) Kiểm tra caller là super_admin
    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: superRow } = await adminClient
      .from('super_admins')
      .select('user_id')
      .eq('user_id', caller.id)
      .maybeSingle();

    if (!superRow) {
      return new Response(JSON.stringify({ error: 'Forbidden: super_admin only' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3) Tạo user qua Admin API
    const body = (await req.json()) as CreateUserRequest;
    if (!body.email || !body.password) {
      return new Response(JSON.stringify({ error: 'email + password bắt buộc' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (body.password.length < 6) {
      return new Response(JSON.stringify({ error: 'Mật khẩu phải có ít nhất 6 ký tự' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: {
        // handle_new_user() đọc các field này từ raw_user_meta_data → profiles.
        username: body.username ?? null,
        full_name: body.full_name ?? body.username ?? '',
        phone: body.phone ?? null,
        email: body.contact_email ?? null,
        employee_code: body.employee_code ?? null,
        department: body.department ?? null,
        job_title: body.job_title ?? null,
        is_active: body.is_active ?? true,
      },
    });

    if (createErr) {
      return new Response(JSON.stringify({ error: createErr.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        user: { id: created.user.id, email: created.user.email },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
