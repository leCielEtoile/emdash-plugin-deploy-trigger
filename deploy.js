export const DEFAULT_MESSAGES = {
	hookCalled: "Deploy hook called",
	attemptFailed: "Deploy hook request failed; will retry",
	gaveUp: "Deploy hook request failed; giving up",
	urlMissing: "DEPLOY_HOOK_URL is not set; skipping the deploy hook",
	urlInvalid: "DEPLOY_HOOK_URL is not a valid URL; skipping the deploy hook",
	urlInsecure: "DEPLOY_HOOK_URL must use https; skipping the deploy hook",
	hostNotAllowed: "The deploy hook host is not in allowedHosts; skipping the deploy hook",
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 「リクエストがサーバーに届いていないことが確実」な接続失敗のコード（undici の cause.code）。
// ECONNRESET や受信後のタイムアウトは、サーバーが受理済みの可能性があるので含めない。
const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])

const errorCodeOf = (e) => {
	const code = e?.cause?.code ?? e?.code
	return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined
}
const errorNameOf = (e) => (typeof e?.name === "string" ? e.name.slice(0, 64) : "unknown")

// EmDash コアの isHostAllowed（ctx.http.fetch の許可判定）と同じ規則
const stripDots = (s) => s.toLowerCase().replace(/\.+$/, "")
function isHostAllowed(host, allowedHosts) {
	const h = stripDots(host)
	return allowedHosts.some((pattern) => {
		const p = stripDots(pattern)
		if (p === "*") return true
		if (p.startsWith("*.")) return h.endsWith(p.slice(1)) || h === p.slice(2)
		return h === p
	})
}

// Retry-After（秒または HTTP 日付）をミリ秒にする。解釈できなければ undefined
function retryAfterMs(res) {
	const v = res.headers?.get?.("retry-after")?.trim()
	if (!v) return undefined
	if (/^\d+$/.test(v)) return Number(v) * 1000
	const t = Date.parse(v)
	return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now())
}

/**
 * デプロイフックを POST する。POST は冪等でないため、再送するのは次の場合だけ:
 *   - 接続できなかった（リクエストが届いていないことが確実）
 *   - 429（Retry-After があれば尊重する。maxRetryAfterMs を超える場合は再送しない）
 * タイムアウト・5xx・その他の 4xx・その他の例外は再送しない（サーバーが受理済みの可能性があり、ビルドが重複するため）。
 * 失敗しても例外は投げない。ログには URL も例外メッセージも出さない（URL にフック ID（秘密）が含まれるため）。
 * 出すのはホスト名・HTTP ステータス・例外名（e.name）・試行回数・原因の分類（reason）だけ。
 */
export async function callDeployHook({
	fetchFn, url, allowedHosts, retries = 3, baseDelayMs = 1000, timeoutMs = 30_000, maxRetryAfterMs = 60_000,
	sleep = defaultSleep, log, messages = {},
}) {
	const msg = { ...DEFAULT_MESSAGES, ...messages }
	if (!url) {
		log.warn(msg.urlMissing, { reason: "missing_url" })
		return { ok: false, skipped: true, reason: "missing_url", attempts: 0 }
	}
	let parsed
	try { parsed = new URL(url) } catch {
		log.error(msg.urlInvalid, { reason: "invalid_url" })
		return { ok: false, skipped: true, reason: "invalid_url", attempts: 0 }
	}
	const host = parsed.host
	if (parsed.protocol !== "https:") {
		log.warn(msg.urlInsecure, { host, reason: "insecure_scheme" })
		return { ok: false, skipped: true, reason: "insecure_scheme", attempts: 0 }
	}
	if (allowedHosts && !isHostAllowed(parsed.hostname, allowedHosts)) {
		log.error(msg.hostNotAllowed, { host, reason: "host_not_allowed" })
		return { ok: false, skipped: true, reason: "host_not_allowed", attempts: 0 }
	}

	let attempts = 0
	for (let i = 0; i <= retries; i++) {
		attempts++
		let retry = false
		let delay = baseDelayMs * 2 ** i
		let detail
		let status
		try {
			const res = await fetchFn(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs) })
			await Promise.resolve(res.body?.cancel?.()).catch(() => {})
			if (res.ok) {
				log.info(msg.hookCalled, { host, status: res.status, attempts })
				return { ok: true, status: res.status, attempts }
			}
			status = res.status
			detail = { reason: "http_status" }
			if (res.status === 429) {
				const wait = retryAfterMs(res)
				if (wait === undefined) retry = true
				else if (wait <= maxRetryAfterMs) { retry = true; delay = wait }
				else detail = { reason: "retry_after_too_long" }
			}
		} catch (e) {
			const code = errorCodeOf(e)
			const name = errorNameOf(e)
			retry = CONNECT_ERROR_CODES.has(code)
			detail = { reason: retry ? "connect_error" : name === "TimeoutError" ? "timeout" : "network_error", errorName: name, errorCode: code }
		}
		const willRetry = retry && i < retries
		const data = { host, status, ...detail, attempt: attempts, willRetry }
		if (willRetry) {
			log.warn(msg.attemptFailed, data)
			await sleep(delay)
			continue
		}
		log.error(msg.gaveUp, data)
		return status === undefined ? { ok: false, reason: detail.reason, attempts } : { ok: false, status, reason: detail.reason, attempts }
	}
}
