import pkg from "./package.json" with { type: "json" }
import { DEFAULT_MESSAGES } from "./deploy.js"
import { minIntervalMinutes } from "./schedule.js"

export const PLUGIN_ID = "deploy-trigger"
export const VERSION = pkg.version
export const CAPABILITIES = ["network:request"]
export const DEFAULT_SCHEDULE = "0 21 * * *"
export const DEFAULT_ALLOWED_HOSTS = ["api.cloudflare.com"]
export const DEFAULT_MIN_INTERVAL_MINUTES = 15
export const MESSAGES = { ...DEFAULT_MESSAGES, registered: "deploy-trigger registered" }

/**
 * オプションを検証して既定値を補う。不正なら例外（設定時・起動時に気付けるようにする）。
 * schedule は undefined 可（環境変数が未設定のとき既定を使うため）。
 */
export function resolveOptions(options = {}) {
	const { schedule = DEFAULT_SCHEDULE, allowedHosts = DEFAULT_ALLOWED_HOSTS, minIntervalMinutes: minInterval = DEFAULT_MIN_INTERVAL_MINUTES, messages = {} } = options
	if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || allowedHosts.some((h) => typeof h !== "string" || h.trim() === "")) {
		throw new Error("deploy-trigger: allowedHosts must be a non-empty array of host names")
	}
	if (!Number.isInteger(minInterval) || minInterval < 1) {
		throw new Error("deploy-trigger: minIntervalMinutes must be a positive integer")
	}
	if (typeof messages !== "object" || messages === null || Array.isArray(messages) || Object.values(messages).some((v) => typeof v !== "string")) {
		throw new Error("deploy-trigger: messages must be an object whose values are strings")
	}
	let interval
	try { interval = minIntervalMinutes(schedule) } catch (e) {
		throw new Error(`deploy-trigger: invalid schedule: ${e.message}`)
	}
	if (interval < minInterval) {
		throw new Error(`deploy-trigger: schedule "${schedule}" runs every ${interval} minute(s), which is shorter than the minimum interval of ${minInterval} minutes (see the minIntervalMinutes option)`)
	}
	return { schedule, allowedHosts, minIntervalMinutes: minInterval, messages: { ...MESSAGES, ...messages } }
}

// ネイティブプラグインは process.env を読む（import.meta.env はビルド時に埋め込まれるため使わない）。
// Cloudflare Workers では process.env に無いため virtual:emdash/env にフォールバックする。
export async function getEnv(key) {
	const fromProcess = typeof process !== "undefined" ? process.env[key] : undefined
	if (fromProcess) return fromProcess
	try {
		const { env } = await import("virtual:emdash/env")
		return env?.[key]
	} catch {
		return undefined
	}
}
