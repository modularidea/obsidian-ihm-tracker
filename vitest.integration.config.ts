import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Requires the containers from docker-compose.yml (`docker compose up -d`).
// Run with `npm run test:integration`.
export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./src/test/obsidian-stub.ts', import.meta.url)),
		},
	},
	test: {
		include: ['src/**/*.integration.test.ts'],
		testTimeout: 20000,
	},
});
