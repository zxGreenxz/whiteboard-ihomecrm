-- AI Copilot: thêm provider 9Router (github.com/decolua/9router) — proxy LOCAL
-- trên máy người dùng (localhost:20128, OpenAI-compatible, CORS * sẵn).
-- data_class 'local_only': browser gọi thẳng localhost, KHÔNG qua llm-proxy;
-- model TỰ PHÁT HIỆN qua GET /v1/models (không khai báo trong models jsonb).
INSERT INTO public.ai_providers (provider, enabled, label, models, default_model, data_class)
VALUES ('9router', true, '9Router (local)', '[]'::jsonb, NULL, 'local_only')
ON CONFLICT (provider) DO NOTHING;
