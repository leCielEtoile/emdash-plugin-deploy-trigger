import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { deployTrigger } from "../index.js"
import { resolveOptions, DEFAULT_MIN_INTERVAL_MINUTES } from "../config.js"
import { createPlugin } from "../runtime.js"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

describe("deployTrigger（descriptor）", () => {
	it("既定: 形式・id・ケーパビリティ・allowedHosts・version（package.json と同じ）", () => {
		const d = deployTrigger()
		expect(d).toMatchObject({ id: "deploy-trigger", version: pkg.version, format: "native", capabilities: ["network:request"], allowedHosts: ["api.cloudflare.com"] })
		expect(d.entrypoint).toBe(fileURLToPath(new URL("../runtime.js", import.meta.url)))
	})

	it("allowedHosts オプションが反映され、options はそのまま渡る", () => {
		const options = { schedule: "0 3 * * *", allowedHosts: ["hooks.example.com"] }
		const d = deployTrigger(options)
		expect(d.allowedHosts).toEqual(["hooks.example.com"])
		expect(d.options).toBe(options)
	})

	it("schedule が undefined（環境変数が未設定）なら既定を使い、例外にならない", () => {
		expect(() => deployTrigger({ schedule: undefined })).not.toThrow()
	})

	it("短すぎる schedule は設定時に例外（既定の下限 15 分）", () => {
		expect(() => deployTrigger({ schedule: "* * * * *" })).toThrow(/minimum interval of 15 minutes/)
		expect(() => deployTrigger({ schedule: "*/14 * * * *" })).toThrow(/minimum interval/)
		expect(() => deployTrigger({ schedule: "*/15 * * * *" })).not.toThrow()
	})

	it("minIntervalMinutes で下限を調整できる", () => {
		expect(() => deployTrigger({ schedule: "*/5 * * * *", minIntervalMinutes: 5 })).not.toThrow()
		expect(() => deployTrigger({ schedule: "*/5 * * * *", minIntervalMinutes: 6 })).toThrow()
		expect(() => deployTrigger({ schedule: "0 * * * *", minIntervalMinutes: 120 })).toThrow()
	})

	it.each([
		[{ schedule: "not cron" }, /invalid schedule/],
		[{ schedule: "" }, /invalid schedule/],
		[{ schedule: 123 }, /invalid schedule/],
		[{ allowedHosts: [] }, /allowedHosts/],
		[{ allowedHosts: "api.cloudflare.com" }, /allowedHosts/],
		[{ allowedHosts: [""] }, /allowedHosts/],
		[{ allowedHosts: [1] }, /allowedHosts/],
		[{ minIntervalMinutes: 0 }, /minIntervalMinutes/],
		[{ minIntervalMinutes: 1.5 }, /minIntervalMinutes/],
		[{ minIntervalMinutes: "15" }, /minIntervalMinutes/],
		[{ messages: "x" }, /messages/],
		[{ messages: { hookCalled: 1 } }, /messages/],
	])("不正なオプション %j は例外", (options, re) => {
		expect(() => deployTrigger(options)).toThrow(re)
		expect(() => createPlugin(options)).toThrow(re)
	})
})

describe("resolveOptions", () => {
	it("既定値", () => {
		const r = resolveOptions()
		expect(r).toMatchObject({ schedule: "0 21 * * *", allowedHosts: ["api.cloudflare.com"], minIntervalMinutes: DEFAULT_MIN_INTERVAL_MINUTES })
		expect(DEFAULT_MIN_INTERVAL_MINUTES).toBe(15)
		expect(r.messages.registered).toBeTypeOf("string")
	})

	it("messages は既定にマージされる", () => {
		const r = resolveOptions({ messages: { hookCalled: "OK" } })
		expect(r.messages.hookCalled).toBe("OK")
		expect(r.messages.gaveUp).toBeTypeOf("string")
	})
})
