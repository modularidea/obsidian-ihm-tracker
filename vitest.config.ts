import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// 'obsidian' ships types only (no runtime) — siehe src/test/obsidian-stub.ts.
			obsidian: fileURLToPath(new URL('./src/test/obsidian-stub.ts', import.meta.url)),
		},
	},
	test: {
		include: ['src/**/*.test.ts'],
		// Integrationstests brauchen laufende Docker-Container (docker-compose.yml)
		// -- raus aus dem Standard-`npm test` (muss offline/hermetisch bleiben),
		// separat über `npm run test:integration` erreichbar.
		exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
	},
});
