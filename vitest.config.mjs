import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const stub = (name) => fileURLToPath(new URL(`./test/stubs/${name}`, import.meta.url))

export default defineConfig({
	resolve: { alias: { emdash: stub("emdash.js"), "virtual:emdash/env": stub("emdash-env.js") } },
	test: { environment: "node", include: ["test/*.test.{js,mjs}", "scripts/test/*.test.mjs"] },
})
