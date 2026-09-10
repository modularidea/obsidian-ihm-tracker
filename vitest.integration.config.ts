import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate Config statt nur anderem `include` in vitest.config.ts: braucht
// laufende Docker-Container (docker-compose.yml, `docker compose up -d`) —
// bewusst nicht Teil von `npm test`. Siehe docs/todos.md Phase 1.
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
