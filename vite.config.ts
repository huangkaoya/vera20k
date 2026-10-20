import {defineConfig} from 'vite';

export default defineConfig({
  server: {host: '127.0.0.1', port: 5280, strictPort: true,
    watch: {ignored: ['**/.build/**', '**/vendor/**', '**/validation/**', '**/target/**']}},
  build: {target: 'es2022', outDir: 'dist', emptyOutDir: true},
  worker: {format: 'es'},
});
