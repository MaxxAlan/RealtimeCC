import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], base: './', server: { strictPort: true }, build: { outDir: 'dist/renderer', assetsInlineLimit: 0 } });
