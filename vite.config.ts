import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Lit le .env à la racine du projet (le root de Vite est web/).
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number(env.API_PORT || 8787);
  const webPort = Number(env.WEB_PORT || 5176);

  return {
    root: 'web',
    plugins: [react()],
    server: {
      // Port fixe et strict : IndexedDB est propre à chaque origine (hôte + port).
      // Si Vite changeait de port, les jeux de données et dashboards enregistrés « disparaîtraient ».
      host: 'localhost',
      port: webPort,
      strictPort: true,
      // Le frontend n'appelle jamais le LLM directement : tout passe par le proxy.
      proxy: { '/api': `http://localhost:${apiPort}` },
    },
    optimizeDeps: {
      // DuckDB-WASM charge ses propres workers et fichiers .wasm.
      exclude: ['@duckdb/duckdb-wasm'],
    },
    build: { outDir: '../dist', emptyOutDir: true },
  };
});
