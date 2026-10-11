import { describe, it, expect, vi, afterEach } from "vitest"
import { callDeployHook, DEFAULT_MESSAGES } from "../deploy.js"

const res = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers) })
const noSleep = async () => {}
const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const SECRET_ID = "SECRET-ID-123"
const SECRET_URL = `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/${SECRET_ID}`
const connectError = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code }) })
const allLogs = (log) => JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls])
const run = (over) => callDeployHook({ fetchFn: vi.fn(async () => res(200)), url: SECRET_URL, sleep: noSleep, log: mkLog(), ...over })

afterEach(() => vi.restoreAllMocks())

describe("callDeployHook: 成功", () => {
	it("成功したら 1 回で ok。POST で、タイムアウト付きの signal を渡す", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout")
		const fetchFn = vi.fn(async () => res(200))
		const r = await run({ fetchFn })
		expect(r).toEqual({ ok: true, status: 200, attempts: 1 })
		expect(fetchFn).toHaveBeenCalledTimes(1)
		expect(fetchFn).toHaveBeenCalledWith(SECRET_URL, expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }))
		expect(timeout).toHaveBeenCalledWith(30_000)
	})

	it("成功時は info にホスト名・ステータス・試行回数だけを出す", async () => {
		const log = mkLog()
		await run({ log })
		expect(log.info).toHaveBeenCalledWith(DEFAULT_MESSAGES.hookCalled, { host: "api.cloudflare.com", status: 200, attempts: 1 })
		expect(log.warn).not.toHaveBeenCalled()
		expect(log.error).not.toHaveBeenCalled()
	})
})

describe("callDeployHook: スキップ（fetch しない）", () => {
	it("URL 未設定", async () => {
		const fetchFn = vi.fn()
		const log = mkLog()
		expect(await run({ fetchFn, url: "", log })).toEqual({ ok: false, skipped: true, reason: "missing_url", attempts: 0 })
		expect(await run({ fetchFn, url: undefined, log })).toEqual({ ok: false, skipped: true, reason: "missing_url", attempts: 0 })
		expect(fetchFn).not.toHaveBeenCalled()
		expect(log.warn).toHaveBeenCalledWith(DEFAULT_MESSAGES.urlMissing, { reason: "missing_url" })
	})

	it("https 以外は警告してスキップ", async () => {
		const fetchFn = vi.fn()
		const log = mkLog()
		const r = await run({ fetchFn, url: `http://api.cloudflare.com/hook/${SECRET_ID}`, log })
		expect(r).toEqual({ ok: false, skipped: true, reason: "insecure_scheme", attempts: 0 })
		expect(fetchFn).not.toHaveBeenCalled()
		expect(log.warn).toHaveBeenCalledWith(DEFAULT_MESSAGES.urlInsecure, { host: "api.cloudflare.com", reason: "insecure_scheme" })
		expect(allLogs(log)).not.toContain(SECRET_ID)
	})

	it("URL として不正ならスキップ（再送しない）。入力文字列はログに出ない", async () => {
		const fetchFn = vi.fn()
		const log = mkLog()
		const r = await run({ fetchFn, url: `not a url ${SECRET_ID}`, log })
		expect(r).toEqual({ ok: false, skipped: true, reason: "invalid_url", attempts: 0 })
		expect(fetchFn).not.toHaveBeenCalled()
		expect(log.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.urlInvalid, { reason: "invalid_url" })
		expect(allLogs(log)).not.toContain(SECRET_ID)
	})

	it("allowedHosts に無いホストは原因が分かる分類でスキップ", async () => {
		const fetchFn = vi.fn()
		const log = mkLog()
		const r = await run({ fetchFn, allowedHosts: ["example.com"], log })
		expect(r).toEqual({ ok: false, skipped: true, reason: "host_not_allowed", attempts: 0 })
		expect(fetchFn).not.toHaveBeenCalled()
		expect(log.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.hostNotAllowed, { host: "api.cloudflare.com", reason: "host_not_allowed" })
	})

	it("allowedHosts は完全一致と *.example.com 形式を EmDash と同じ規則で判定する", async () => {
		const url = "https://hooks.example.com/x"
		expect((await run({ url, allowedHosts: ["hooks.example.com"] })).ok).toBe(true)
		expect((await run({ url, allowedHosts: ["*.example.com"] })).ok).toBe(true)
		expect((await run({ url, allowedHosts: ["HOOKS.EXAMPLE.COM."] })).ok).toBe(true)
		expect((await run({ url, allowedHosts: ["example.com"] })).skipped).toBe(true)
		expect((await run({ url: "https://evilexample.com/x", allowedHosts: ["*.example.com"] })).skipped).toBe(true)
	})
})

describe("callDeployHook: 再送の方針（冪等でない POST）", () => {
	it.each([500, 502, 503, 504])("%i は再送しない（受理済みの可能性があるため）", async (status) => {
		const fetchFn = vi.fn(async () => res(status))
		const sleep = vi.fn(async () => {})
		const log = mkLog()
		const r = await run({ fetchFn, sleep, log })
		expect(r).toEqual({ ok: false, status, reason: "http_status", attempts: 1 })
		expect(fetchFn).toHaveBeenCalledTimes(1)
		expect(sleep).not.toHaveBeenCalled()
		expect(log.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.gaveUp, expect.objectContaining({ host: "api.cloudflare.com", status, willRetry: false }))
	})

	it.each([400, 401, 404, 408, 425])("4xx（429 以外。%i）は再送しない", async (status) => {
		const fetchFn = vi.fn(async () => res(status))
		expect(await run({ fetchFn })).toEqual({ ok: false, status, reason: "http_status", attempts: 1 })
		expect(fetchFn).toHaveBeenCalledTimes(1)
	})

	it("失敗ログに出る項目は決まったものだけ（ホスト名・ステータス・分類・例外名/コード・試行回数）", async () => {
		const log = mkLog()
		await run({ fetchFn: vi.fn(async () => res(502)), log })
		expect(log.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.gaveUp, { host: "api.cloudflare.com", status: 502, reason: "http_status", attempt: 1, willRetry: false })
		const log2 = mkLog()
		await run({ fetchFn: vi.fn(async () => { throw connectError("ECONNREFUSED") }), retries: 0, log: log2 })
		expect(log2.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.gaveUp, { host: "api.cloudflare.com", reason: "connect_error", errorName: "TypeError", errorCode: "ECONNREFUSED", attempt: 1, willRetry: false })
	})

	it("タイムアウトは再送しない", async () => {
		const fetchFn = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError") })
		const sleep = vi.fn(async () => {})
		const log = mkLog()
		const r = await run({ fetchFn, sleep, log })
		expect(r).toEqual({ ok: false, reason: "timeout", attempts: 1 })
		expect(fetchFn).toHaveBeenCalledTimes(1)
		expect(sleep).not.toHaveBeenCalled()
		expect(log.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.gaveUp, expect.objectContaining({ reason: "timeout", errorName: "TimeoutError", willRetry: false }))
	})

	it.each(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"])("接続確立後に起こりうる例外（%s）は再送しない", async (code) => {
		const fetchFn = vi.fn(async () => { throw connectError(code) })
		const r = await run({ fetchFn })
		expect(r).toEqual({ ok: false, reason: "network_error", attempts: 1 })
		expect(fetchFn).toHaveBeenCalledTimes(1)
	})

	it("素の Error（allowedHosts 拒否など）は再送しない", async () => {
		const fetchFn = vi.fn(async () => { throw new Error(`not allowed ${SECRET_URL}`) })
		expect(await run({ fetchFn })).toEqual({ ok: false, reason: "network_error", attempts: 1 })
		expect(fetchFn).toHaveBeenCalledTimes(1)
	})

	it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])("接続できなかった（%s）は指数バックオフで再送し、成功すれば ok", async (code) => {
		const fetchFn = vi.fn().mockRejectedValueOnce(connectError(code)).mockRejectedValueOnce(connectError(code)).mockResolvedValueOnce(res(200))
		const sleep = vi.fn(async () => {})
		const log = mkLog()
		const r = await run({ fetchFn, sleep, baseDelayMs: 1000, log })
		expect(r).toEqual({ ok: true, status: 200, attempts: 3 })
		expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000])
		expect(log.warn).toHaveBeenCalledTimes(2)
		expect(log.warn).toHaveBeenCalledWith(DEFAULT_MESSAGES.attemptFailed, expect.objectContaining({ reason: "connect_error", errorName: "TypeError", errorCode: code, attempt: 1, willRetry: true }))
	})

	it("接続失敗が続けば retries 回で諦め、最終失敗を error で記録する。最終試行の後は待たない", async () => {
		const fetchFn = vi.fn(async () => { throw connectError("ECONNREFUSED") })
		const sleep = vi.fn(async () => {})
		const log = mkLog()
		const r = await run({ fetchFn, sleep, retries: 2, log })
		expect(r).toEqual({ ok: false, reason: "connect_error", attempts: 3 })
		expect(fetchFn).toHaveBeenCalledTimes(3)
		expect(sleep).toHaveBeenCalledTimes(2)
		expect(log.warn).toHaveBeenCalledTimes(2)
		expect(log.error).toHaveBeenCalledTimes(1)
		expect(log.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.gaveUp, expect.objectContaining({ errorCode: "ECONNREFUSED", attempt: 3, willRetry: false }))
	})

	it("再送のあとに非再送のエラーになれば、そこで止まる", async () => {
		const fetchFn = vi.fn().mockRejectedValueOnce(connectError("ECONNREFUSED")).mockResolvedValueOnce(res(500))
		expect(await run({ fetchFn })).toEqual({ ok: false, status: 500, reason: "http_status", attempts: 2 })
		expect(fetchFn).toHaveBeenCalledTimes(2)
	})

	it("429 は再送する（Retry-After が無ければ指数バックオフ）", async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200))
		const sleep = vi.fn(async () => {})
		expect(await run({ fetchFn, sleep, baseDelayMs: 1000 })).toEqual({ ok: true, status: 200, attempts: 2 })
		expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000])
	})

	it("429 の Retry-After（秒）を尊重する", async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(res(429, { "Retry-After": "7" })).mockResolvedValueOnce(res(200))
		const sleep = vi.fn(async () => {})
		await run({ fetchFn, sleep, baseDelayMs: 1000 })
		expect(sleep.mock.calls.map((c) => c[0])).toEqual([7000])
	})

	it("429 の Retry-After（HTTP 日付）を尊重する", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
		try {
			const fetchFn = vi.fn().mockResolvedValueOnce(res(429, { "Retry-After": "Thu, 01 Jan 2026 00:00:12 GMT" })).mockResolvedValueOnce(res(200))
			const sleep = vi.fn(async () => {})
			await run({ fetchFn, sleep })
			expect(sleep.mock.calls.map((c) => c[0])).toEqual([12_000])
		} finally { vi.useRealTimers() }
	})

	it("Retry-After が上限を超えるなら再送せず、理由を記録する", async () => {
		const fetchFn = vi.fn(async () => res(429, { "Retry-After": "3600" }))
		const sleep = vi.fn(async () => {})
		const log = mkLog()
		const r = await run({ fetchFn, sleep, log })
		expect(r).toEqual({ ok: false, status: 429, reason: "retry_after_too_long", attempts: 1 })
		expect(fetchFn).toHaveBeenCalledTimes(1)
		expect(sleep).not.toHaveBeenCalled()
		expect(log.error).toHaveBeenCalledWith(DEFAULT_MESSAGES.gaveUp, expect.objectContaining({ status: 429, reason: "retry_after_too_long" }))
	})

	it("Retry-After が上限ちょうどなら再送し、1 秒でも超えれば再送しない", async () => {
		const at = vi.fn().mockResolvedValueOnce(res(429, { "Retry-After": "5" })).mockResolvedValueOnce(res(200))
		expect((await run({ fetchFn: at, maxRetryAfterMs: 5000 })).ok).toBe(true)
		const over = vi.fn(async () => res(429, { "Retry-After": "6" }))
		expect(await run({ fetchFn: over, maxRetryAfterMs: 5000 })).toMatchObject({ ok: false, attempts: 1 })
	})

	it("429 が続けば retries 回で諦める", async () => {
		const fetchFn = vi.fn(async () => res(429))
		expect(await run({ fetchFn, retries: 2 })).toEqual({ ok: false, status: 429, reason: "http_status", attempts: 3 })
		expect(fetchFn).toHaveBeenCalledTimes(3)
	})
})

describe("callDeployHook: 文言の上書き", () => {
	it("messages で既定の文言を差し替えられる（指定しなかった分は既定のまま）", async () => {
		const log = mkLog()
		await run({ log, messages: { hookCalled: "デプロイフックを呼びました" } })
		expect(log.info).toHaveBeenCalledWith("デプロイフックを呼びました", expect.any(Object))
		await run({ log, url: "", messages: { hookCalled: "x" } })
		expect(log.warn).toHaveBeenCalledWith(DEFAULT_MESSAGES.urlMissing, expect.any(Object))
	})
})

describe("ログにフック URL（秘密）が現れない（全経路）", () => {
	const secretError = () => Object.assign(new TypeError(`fetch failed ${SECRET_URL}`), { cause: Object.assign(new Error(SECRET_URL), { code: "ECONNREFUSED" }) })
	const cases = {
		成功: () => ({ fetchFn: vi.fn(async () => res(200)) }),
		"再送のあと成功": () => ({ fetchFn: vi.fn().mockRejectedValueOnce(secretError()).mockResolvedValueOnce(res(200)) }),
		"429 のあと成功": () => ({ fetchFn: vi.fn().mockResolvedValueOnce(res(429, { "Retry-After": "1" })).mockResolvedValueOnce(res(200)) }),
		"5xx 失敗": () => ({ fetchFn: vi.fn(async () => res(503)) }),
		"接続失敗を尽くす": () => ({ fetchFn: vi.fn(async () => { throw secretError() }), retries: 1 }),
		"例外メッセージに URL を含む失敗": () => ({ fetchFn: vi.fn(async () => { throw new Error(`failed ${SECRET_URL}`) }) }),
		"タイムアウト": () => ({ fetchFn: vi.fn(async () => { throw new DOMException(SECRET_URL, "TimeoutError") }) }),
		"host 不許可": () => ({ fetchFn: vi.fn(), allowedHosts: ["example.com"] }),
		"http スキーム": () => ({ fetchFn: vi.fn(), url: `http://api.cloudflare.com/${SECRET_ID}` }),
		"不正な URL": () => ({ fetchFn: vi.fn(), url: `::${SECRET_ID}` }),
	}
	for (const [name, mk] of Object.entries(cases)) {
		it(name, async () => {
			const log = mkLog()
			await run({ ...mk(), log })
			const all = allLogs(log)
			expect(all).not.toContain(SECRET_ID)
			expect(all).not.toContain("deploy_hooks")
			expect(all).not.toContain("fetch failed")
			expect(all).not.toContain("https://")
		})
	}

	it("ログには何かが出ており、ホスト名は出る（上の否定検査が空振りしていない）", async () => {
		const log = mkLog()
		await run({ log })
		expect(allLogs(log)).toContain("api.cloudflare.com")
	})
})
