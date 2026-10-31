import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5193,
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:8093', ws: true } },
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
