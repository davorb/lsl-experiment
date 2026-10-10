import { defineConfig } from 'vite';

// The Node server owns /ws and /content; Vite proxies both so one URL works for friends on the LAN.
const SERVER = process.env.LSL_SERVER_PORT ?? '8787';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER}`, ws: true },
      '/content': `http://localhost:${SERVER}`,
    },
  },
  build: { target: 'es2022' },
});
