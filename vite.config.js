import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    // /monad is a separate standalone page (its own entry, own bundle) so
    // the hackathon demo flow never touches the existing app's code path —
    // Vite needs every HTML entry point listed explicitly once there's more
    // than one, otherwise the build only emits index.html.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        monad: resolve(__dirname, 'monad.html'),
      },
    },
  },
});
