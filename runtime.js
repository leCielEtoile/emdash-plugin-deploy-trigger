import { definePlugin } from "emdash"
import { callDeployHook } from "./deploy.js"
import { CAPABILITIES, PLUGIN_ID, VERSION, getEnv, resolveOptions } from "./config.js"

const TASK = "daily-deploy"

export function createPlugin(options = {}) {
	const { schedule, allowedHosts, messages } = resolveOptions(options)
	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		capabilities: CAPABILITIES,
		allowedHosts,
		hooks: {
			// 設定ファイル登録のプラグインは、管理 API で「有効化」された時にのみ呼ばれる（利用側アプリの有効化手順）
			"plugin:activate": async (_event, ctx) => {
				await ctx.cron.schedule(TASK, { schedule })
				ctx.log.info(messages.registered, { schedule })
			},
			cron: async (event, ctx) => {
				if (event.name !== TASK) return
				await callDeployHook({
					fetchFn: (url, init) => ctx.http.fetch(url, init),
					url: await getEnv("DEPLOY_HOOK_URL"),
					allowedHosts,
					log: ctx.log,
					messages,
				})
			},
		},
	})
}

export default createPlugin
