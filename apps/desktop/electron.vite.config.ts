import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
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
    build: { outDir: 'dist/renderer' },
    resolve: { alias: { '@': resolve('src/renderer') } },
    plugins: [
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: resolve('src/renderer/routes'),
        generatedRouteTree: resolve('src/renderer/routeTree.gen.ts'),
      }),
      react(),
      tailwindcss(),
      // Absolute asset paths, so a nested route such as `/sessions/<id>` resolves them
      // under the `app://` protocol. electron-vite sets `base: './'` for a production
      // build, whatever the config says, so this runs after it.
      { name: 'absolute-base', enforce: 'post', config: () => ({ base: '/' }) },
    ],
  },
});
