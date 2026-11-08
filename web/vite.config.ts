import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative paths so the built site works from any folder, such as GitHub Pages.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  server: { port: 5183, strictPort: true },
});
