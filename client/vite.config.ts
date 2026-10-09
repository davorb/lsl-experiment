import { defineConfig } from 'vite';

// The Node server owns /ws and /content; Vite proxies both so one URL works for friends on the LAN.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/content': 'http://localhost:8787',
    },
  },
  build: { target: 'es2022' },
});
