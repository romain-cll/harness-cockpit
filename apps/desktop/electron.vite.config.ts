import { resolve } from 'node:path';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: { outDir: 'dist/main' },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      // Sandboxed preload scripts cannot be ES modules.
      rolldownOptions: { output: { format: 'cjs' } },
    },
  },
  renderer: {
    // Absolute asset paths, so nested routes resolve them under the `app://` protocol.
    base: '/',
    build: { outDir: 'dist/renderer' },
    plugins: [
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: resolve('src/renderer/routes'),
        generatedRouteTree: resolve('src/renderer/routeTree.gen.ts'),
      }),
      react(),
    ],
  },
});
