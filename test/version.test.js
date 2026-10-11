import { describe, it, expect, vi } from "vitest"

// package.json の version だけを差し替え、ソース側に版が直書きされていないことを確かめる
vi.mock("../package.json", () => ({ default: { name: "emdash-plugin-deploy-trigger", version: "9.8.7" } }))

describe("version は package.json から取る", () => {
	it("index.js（descriptor）と runtime.js（definePlugin）の両方", async () => {
		const { deployTrigger } = await import("../index.js")
		const { createPlugin } = await import("../runtime.js")
		expect(deployTrigger().version).toBe("9.8.7")
		expect(createPlugin().version).toBe("9.8.7")
	})
})
