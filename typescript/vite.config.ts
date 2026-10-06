import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI lives in web/ and builds to web/dist, which the server serves in production.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
