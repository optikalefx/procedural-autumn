import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { target: 'esnext', sourcemap: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
