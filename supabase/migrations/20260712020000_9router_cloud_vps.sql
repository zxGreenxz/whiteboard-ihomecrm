-- AI Copilot: chuyển 9Router từ LOCAL (máy user) sang CLOUD (VPS self-host).
-- 9Router chạy trên VPS Vultr ai.chillhome.io.vn (Docker + Caddy TLS), llm-proxy
-- route tới nó qua secret NINEROUTER_BASE_URL/NINEROUTER_API_KEY → mọi user dùng
-- được ở BẤT CỨ ĐÂU (không cần cài local) + có quota/usage log/cost như provider cloud.
--
-- Model seed (đã verify tool-calling + tiếng Việt qua VPS):
--   cx/* = OpenAI Codex (ChatGPT sub, ổn định nhất — named tool_choice ép tool tốt)
--   ag/* = Google Antigravity (Gemini)
--   mmf/* = MiMo Free (free tier, hay rate-limit — để dự phòng)
-- 9Router expose ~445 model; admin thêm/bớt tại /settings/ai-copilot ("Sửa models").
UPDATE public.ai_providers
SET
  data_class = 'cloud',
  label = '9Router (VPS)',
  models = '[
    {"id":"cx/gpt-5.4-mini","label":"GPT-5.4 Mini (Codex)","input_price":0,"output_price":0},
    {"id":"cx/gpt-5.5","label":"GPT-5.5 (Codex)","input_price":0,"output_price":0},
    {"id":"cx/gpt-5.6-luna","label":"GPT-5.6 Luna (Codex)","input_price":0,"output_price":0},
    {"id":"ag/gemini-3-flash","label":"Gemini 3 Flash (Antigravity)","input_price":0,"output_price":0},
    {"id":"mmf/mimo-auto","label":"MiMo Auto (free, hay nghẽn)","input_price":0,"output_price":0}
  ]'::jsonb,
  default_model = 'cx/gpt-5.4-mini',
  updated_at = now()
WHERE provider = '9router';
