import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { env as virtualEnv } from "virtual:emdash/env"
import { createPlugin } from "../runtime.js"
import { DEFAULT_MESSAGES } from "../deploy.js"
import pkg from "../package.json" with { type: "json" }

const SECRET_ID = "SECRET-ID-123"
const HOOK = `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/${SECRET_ID}`
const res = (status) => ({ ok: status >= 200 && status < 300, status, headers: new Headers() })
const connectError = () => Object.assign(new TypeError(`fetch failed ${HOOK}`), { cause: Object.assign(new Error(HOOK), { code: "ECONNREFUSED" }) })

const mkCtx = (fetchImpl = async () => res(200)) => ({
	cron: { schedule: vi.fn(async () => {}) },
	http: { fetch: vi.fn(fetchImpl) },
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
})
const logsOf = (ctx) => JSON.stringify(["debug", "info", "warn", "error"].flatMap((k) => ctx.log[k].mock.calls))
const fire = (plugin, ctx, name = "daily-deploy") => plugin.hooks.cron({ name, scheduledAt: new Date().toISOString() }, ctx)

let savedEnv
beforeEach(() => { savedEnv = process.env.DEPLOY_HOOK_URL; process.env.DEPLOY_HOOK_URL = HOOK })
afterEach(() => {
	if (savedEnv === undefined) delete process.env.DEPLOY_HOOK_URL
	else process.env.DEPLOY_HOOK_URL = savedEnv
	delete virtualEnv.DEPLOY_HOOK_URL
	vi.useRealTimers()
})

describe("createPlugin: 定義", () => {
	it("id・version（package.json）・ケーパビリティ・allowedHosts", () => {
		const p = createPlugin()
		expect(p).toMatchObject({ id: "deploy-trigger", version: pkg.version, capabilities: ["network:request"], allowedHosts: ["api.cloudflare.com"] })
		expect(createPlugin({ allowedHosts: ["hooks.example.com"] }).allowedHosts).toEqual(["hooks.example.com"])
	})
})

describe("plugin:activate", () => {
	it("既定の schedule で cron タスク daily-deploy を登録する", async () => {
		const ctx = mkCtx()
		await createPlugin().hooks["plugin:activate"]({}, ctx)
		expect(ctx.cron.schedule).toHaveBeenCalledWith("daily-deploy", { schedule: "0 21 * * *" })
		expect(ctx.log.info).toHaveBeenCalledWith("deploy-trigger registered", { schedule: "0 21 * * *" })
	})

	it("schedule オプションを使う。undefined なら既定", async () => {
		const ctx = mkCtx()
		await createPlugin({ schedule: "30 4 * * *" }).hooks["plugin:activate"]({}, ctx)
		expect(ctx.cron.schedule).toHaveBeenCalledWith("daily-deploy", { schedule: "30 4 * * *" })
		const ctx2 = mkCtx()
		await createPlugin({ schedule: undefined }).hooks["plugin:activate"]({}, ctx2)
		expect(ctx2.cron.schedule).toHaveBeenCalledWith("daily-deploy", { schedule: "0 21 * * *" })
	})

	it("messages.registered で登録ログの文言を上書きできる", async () => {
		const ctx = mkCtx()
		await createPlugin({ messages: { registered: "登録しました" } }).hooks["plugin:activate"]({}, ctx)
		expect(ctx.log.info).toHaveBeenCalledWith("登録しました", expect.any(Object))
	})
})

describe("cron フック", () => {
	it("タスク名が daily-deploy 以外なら何もしない", async () => {
		const ctx = mkCtx()
		await fire(createPlugin(), ctx, "other-task")
		expect(ctx.http.fetch).not.toHaveBeenCalled()
		expect(ctx.log.info).not.toHaveBeenCalled()
		expect(ctx.log.warn).not.toHaveBeenCalled()
	})

	it("環境変数 DEPLOY_HOOK_URL へ ctx.http.fetch で POST する", async () => {
		const ctx = mkCtx()
		await fire(createPlugin(), ctx)
		expect(ctx.http.fetch).toHaveBeenCalledTimes(1)
		expect(ctx.http.fetch).toHaveBeenCalledWith(HOOK, expect.objectContaining({ method: "POST" }))
	})

	it("process.env に無ければ virtual:emdash/env にフォールバックする（Workers）", async () => {
		delete process.env.DEPLOY_HOOK_URL
		virtualEnv.DEPLOY_HOOK_URL = HOOK
		const ctx = mkCtx()
		await fire(createPlugin(), ctx)
		expect(ctx.http.fetch).toHaveBeenCalledWith(HOOK, expect.any(Object))
	})

	it("どちらにも無ければ警告してスキップする", async () => {
		delete process.env.DEPLOY_HOOK_URL
		const ctx = mkCtx()
		await fire(createPlugin(), ctx)
		expect(ctx.http.fetch).not.toHaveBeenCalled()
		expect(ctx.log.warn).toHaveBeenCalledWith(DEFAULT_MESSAGES.urlMissing, { reason: "missing_url" })
	})

	it("http の URL は fetch せずスキップ", async () => {
		process.env.DEPLOY_HOOK_URL = HOOK.replace("https:", "http:")
		const ctx = mkCtx()
		await fire(createPlugin(), ctx)
		expect(ctx.http.fetch).not.toHaveBeenCalled()
		expect(ctx.log.warn).toHaveBeenCalledWith(DEFAULT_MESSAGES.urlInsecure, expect.objectContaining({ reason: "insecure_scheme" }))
	})

	it("allowedHosts にフックのホストが無ければ host_not_allowed で記録してスキップ", async () => {
		const ctx = mkCtx()
		await fire(createPlugin({ allowedHosts: ["example.com"] }), ctx)
		expect(ctx.http.fetch).not.toHaveBeenCalled()
		expect(ctx.log.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.hostNotAllowed, { host: "api.cloudflare.com", reason: "host_not_allowed" })
	})

	it("messages でログ文言を上書きできる", async () => {
		const ctx = mkCtx()
		await fire(createPlugin({ messages: { hookCalled: "デプロイフックを呼びました" } }), ctx)
		expect(ctx.log.info).toHaveBeenCalledWith("デプロイフックを呼びました", expect.objectContaining({ host: "api.cloudflare.com", status: 200 }))
	})
})

describe("ログに URL が出ない（runtime 経由の全経路）", () => {
	const scenarios = {
		成功: () => async () => res(200),
		"再送のあと成功": () => {
			let n = 0
			return async () => { if (n++ === 0) throw connectError(); return res(200) }
		},
		"5xx 失敗": () => async () => res(502),
		"接続失敗を尽くす": () => async () => { throw connectError() },
		"URL 入りの例外": () => async () => { throw new Error(`boom ${HOOK}`) },
	}
	for (const [name, mk] of Object.entries(scenarios)) {
		it(name, async () => {
			vi.useFakeTimers()
			const ctx = mkCtx(mk())
			const p = fire(createPlugin(), ctx)
			await vi.runAllTimersAsync()
			await p
			const logs = logsOf(ctx)
			expect(logs).not.toContain(SECRET_ID)
			expect(logs).not.toContain("deploy_hooks")
			expect(logs).not.toContain("https://")
			expect(logs).toContain("api.cloudflare.com")
		})
	}

	it("再送のあと成功の経路では、実際に再送している", async () => {
		vi.useFakeTimers()
		let n = 0
		const ctx = mkCtx(async () => { if (n++ === 0) throw connectError(); return res(200) })
		const p = fire(createPlugin(), ctx)
		await vi.runAllTimersAsync()
		await p
		expect(ctx.http.fetch).toHaveBeenCalledTimes(2)
		expect(ctx.log.warn).toHaveBeenCalledTimes(1)
		expect(ctx.log.info).toHaveBeenCalledWith(DEFAULT_MESSAGES.hookCalled, { host: "api.cloudflare.com", status: 200, attempts: 2 })
	})

	it("失敗しても cron フックは例外を投げない", async () => {
		const ctx = mkCtx(async () => res(500))
		await expect(fire(createPlugin(), ctx)).resolves.toBeUndefined()
		expect(ctx.log.error).toHaveBeenCalledTimes(1)
	})
})
