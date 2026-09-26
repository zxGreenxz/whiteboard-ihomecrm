import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root,
  publicDir: false,
  envDir: root,
  plugins: [react()],
  resolve: { alias: { '@': `${repo}src` } },
  css: { postcss: repo },
  build: { outDir: `${root}dist`, emptyOutDir: true, sourcemap: false },
});
