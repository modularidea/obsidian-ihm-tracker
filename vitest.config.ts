import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			// 'obsidian' ships types only — see src/test/obsidian-stub.ts.
			obsidian: fileURLToPath(new URL('./src/test/obsidian-stub.ts', import.meta.url)),
		},
	},
	test: {
		include: ['src/**/*.test.ts'],
		// Integration tests need running Docker containers; `npm test` stays
		// hermetic. See vitest.integration.config.ts.
		exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
	},
});
