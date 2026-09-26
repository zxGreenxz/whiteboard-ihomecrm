import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from './local-config.mjs';
import { LabError } from './evaluation.mjs';
import { createLabServer } from './server.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const common = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim();
const vaultPath = process.env.IHOMECRM_VAULT || join(dirname(common), 'CLAUDE.local.md');
const config = loadRuntimeConfig(process.env, () => readFileSync(vaultPath, 'utf8'));
if (config) {
  process.env.NINEROUTER_API_KEY = config.apiKey;
  process.env.NINEROUTER_BASE_URL = config.baseUrl;
}
const captureMessage = 'Đang mở chế độ thử micro. Chưa bật kết nối 9Router; bạn có thể ghi âm và nghe lại trên điện thoại.';
const captureOnly = {
  capabilities: async () => ({chatModels:[],sttModels:[],defaultChatModel:null,defaultSttModel:null,providerReady:false,capabilityError:captureMessage}),
  transcribe: async () => {throw new LabError('CAPTURE_ONLY', captureMessage, 503);},
  extract: async () => {throw new LabError('CAPTURE_ONLY', captureMessage, 503);},
};

const port = Number(process.env.VOICE_LAB_PORT || 4179);
const server = await createLabServer({
  ...(config === null ? {provider:captureOnly} : {}),
  accessCode: process.env.VOICE_LAB_ACCESS_CODE,
  publicOrigin: process.env.VOICE_LAB_PUBLIC_ORIGIN,
  dataDir: process.env.VOICE_LAB_DATA_DIR,
  port,
});
server.listen(port, '127.0.0.1', () => console.log(`Voice task lab listening on 127.0.0.1:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
