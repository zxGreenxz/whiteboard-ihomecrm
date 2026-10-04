export function loadConfig(env = process.env) {
  const required = [
    'APP_ORIGIN', 'BANK_EMAIL_PUBLIC_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI',
    'GOOGLE_PUBSUB_TOPIC', 'GOOGLE_PUBSUB_AUDIENCE', 'GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL',
    'BANK_EMAIL_TOKEN_KEY_BASE64',
  ];
  for (const name of required) {
    if (typeof env[name] !== 'string' || !env[name].trim()) throw new Error(`Missing ${name}`);
  }
  const appOrigin = new URL(env.APP_ORIGIN);
  const publicUrl = new URL(env.BANK_EMAIL_PUBLIC_URL);
  const supabaseUrl = new URL(env.SUPABASE_URL);
  if ([appOrigin, publicUrl, supabaseUrl].some(url => url.protocol !== 'https:') ||
      appOrigin.origin !== env.APP_ORIGIN || publicUrl.origin !== env.BANK_EMAIL_PUBLIC_URL ||
      env.GOOGLE_OAUTH_REDIRECT_URI !== `${publicUrl.origin}/oauth/callback` ||
      env.GOOGLE_PUBSUB_AUDIENCE !== `${publicUrl.origin}/pubsub` ||
      !/^projects\/[A-Za-z0-9_.~-]+\/topics\/[A-Za-z0-9_.~-]+$/u.test(env.GOOGLE_PUBSUB_TOPIC)) {
    throw new Error('Invalid public endpoint configuration');
  }
  const key = Buffer.from(env.BANK_EMAIL_TOKEN_KEY_BASE64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== env.BANK_EMAIL_TOKEN_KEY_BASE64) {
    throw new Error('Invalid encryption key');
  }
  const port = Number(env.BANK_EMAIL_PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  return {
    appOrigin: env.APP_ORIGIN, publicUrl: publicUrl.origin, port, key,
    supabaseUrl: supabaseUrl.origin, anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    googleClientId: env.GOOGLE_OAUTH_CLIENT_ID, googleClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    googleRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI, googlePubsubTopic: env.GOOGLE_PUBSUB_TOPIC,
    pubsubAudience: env.GOOGLE_PUBSUB_AUDIENCE, pubsubServiceAccountEmail: env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL,
  };
}
