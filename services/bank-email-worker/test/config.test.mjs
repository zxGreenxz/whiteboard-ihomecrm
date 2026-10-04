import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';

const env = { APP_ORIGIN: 'https://app.example.test', BANK_EMAIL_PUBLIC_URL: 'https://worker.example.test',
  SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service',
  GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://worker.example.test/oauth/callback',
  GOOGLE_PUBSUB_TOPIC: 'projects/test/topics/gmail', GOOGLE_PUBSUB_AUDIENCE: 'https://worker.example.test/pubsub',
  GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL: 'push@test.iam.gserviceaccount.com',
  BANK_EMAIL_TOKEN_KEY_BASE64: Buffer.alloc(32, 1).toString('base64') };

test('requires exact public routes, HTTPS, and a 32-byte token key', () => {
  assert.equal(loadConfig(env).key.length, 32);
  assert.throws(() => loadConfig({ ...env, BANK_EMAIL_TOKEN_KEY_BASE64: 'short' }));
  assert.throws(() => loadConfig({ ...env, GOOGLE_OAUTH_REDIRECT_URI: 'https://other.example.test/oauth/callback' }));
  assert.throws(() => loadConfig({ ...env, APP_ORIGIN: 'http://app.example.test' }));
});
