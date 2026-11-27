import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { defineConfig, type Plugin } from 'vite';

function browserCoverage(): Plugin {
  const source = `${resolve('src')}/`;
  const instrumenter = createInstrumenter({ esModules: true, parserPlugins: ['typescript', 'jsx'] });
  return {
    name: 'caudal-browser-coverage',
    enforce: 'pre',
    apply: 'serve',
    transform(code, id) {
      if (!process.env.CAUDAL_WEB_COVERAGE || !id.startsWith(source) || !/\.(tsx|ts)$/.test(id) ||
         id.startsWith(`${source}aspect/`) || id === `${source}main.tsx` || id.endsWith('.test.ts')) return;
      return instrumenter.instrumentSync(code, id);
    },
  };
}

export default defineConfig({
  plugins: [browserCoverage(), react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/downloads': 'http://127.0.0.1:8080',
      '/mcp': 'http://127.0.0.1:8080',
    },
  },
});
