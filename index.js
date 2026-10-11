import { fileURLToPath } from "node:url"
import { CAPABILITIES, PLUGIN_ID, VERSION, resolveOptions } from "./config.js"

/**
 * 日次で Cloudflare Pages のデプロイフックを呼ぶネイティブプラグイン。
 * @param {{
 *   schedule?: string,
 *   allowedHosts?: string[],
 *   minIntervalMinutes?: number,
 *   messages?: Record<string, string>,
 * }} [options]
 *   schedule: 5 フィールドの cron 式（UTC で評価）。既定 "0 21 * * *"（JST 6:00）
 *   allowedHosts: 通信を許可するホスト。既定 ["api.cloudflare.com"]（ワイルドカードは使わない）
 *   minIntervalMinutes: schedule の最小間隔（分）。既定 15。これより短い schedule は例外にする
 *   messages: ログ文言の上書き（キーは README を参照）
 */
export function deployTrigger(options = {}) {
	const { allowedHosts } = resolveOptions(options)
	return {
		id: PLUGIN_ID,
		version: VERSION,
		format: "native",
		entrypoint: fileURLToPath(new URL("./runtime.js", import.meta.url)),
		capabilities: CAPABILITIES,
		allowedHosts,
		options,
	}
}
