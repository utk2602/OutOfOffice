import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'], outDir: 'dist', format: ['esm'], platform: 'node', target: 'node22',
  sourcemap: true, clean: true, splitting: false,
  noExternal: [/^@outofoffice\//],
  external: ['@electric-sql/pglite', 'pg', '@nestjs/common', '@nestjs/core', '@nestjs/platform-express', 'reflect-metadata', 'rxjs', 'proper-lockfile', 'zod'],
});
