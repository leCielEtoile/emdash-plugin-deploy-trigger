# emdash-plugin-deploy-trigger

English | [日本語](./README.ja.md)

A native EmDash plugin that calls a deploy hook (for example a Cloudflare Pages deploy hook) on a cron schedule. Use it to rebuild a static site periodically.

## Features

- Registers a cron task named `daily-deploy` when the plugin is enabled (`plugin:activate`).
- At run time, sends a `POST` to the https URL in the `DEPLOY_HOOK_URL` environment variable.
- Retries only when it is certain the request never reached the server (connection refused, DNS failure, connect timeout) and on `429` (honoring `Retry-After`). Timeouts, 5xx and other errors are **not** retried, because a deploy hook is not idempotent and a retry could start the build twice. See [Retry policy](#retry-policy).
- Never throws on failure. The log contains only the host name, HTTP status, error name and attempt count. It never contains the URL or the exception message, because the URL contains the (secret) hook ID.
- Validates the schedule when your app starts and refuses schedules shorter than 15 minutes by default, so a typo cannot exhaust your build quota.

There is **no manual "run now" feature** (no admin button, no API route). The only trigger is the cron task.

## Requirements

- Node.js >= 22
- Peer dependency (provided by your app): `emdash >=1.1.0 <2`. The plugin API usage was checked against the `emdash` 1.2.0 source.

## Installation

Install it from npm:

```bash
pnpm add emdash-plugin-deploy-trigger
```

Releases are published by this repository's release workflow with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so the npm page links back to `github.com/leCielEtoile/emdash-plugin-deploy-trigger`. To pin a specific version, use `pnpm add emdash-plugin-deploy-trigger@<version>` (for example `0.1.2`).

## Setup

1. **Install the plugin** (see above) and register it in `astro.config.mjs`:

   ```js
   import { defineConfig } from "astro/config"
   import emdash from "emdash/astro"
   import { deployTrigger } from "emdash-plugin-deploy-trigger"

   export default defineConfig({
   	integrations: [
   		emdash({
   			plugins: [deployTrigger({ schedule: process.env.DEPLOY_TRIGGER_SCHEDULE })],
   		}),
   	],
   })
   ```

2. **Set the environment variable** `DEPLOY_HOOK_URL` for the EmDash server (not committed to git). For Cloudflare Pages, create a deploy hook under Settings > Builds > Deploy hooks; the URL looks like `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/<id>`. For any other host, add that host to `allowedHosts` (see Options).

3. **Enable the plugin.** A plugin registered in the config file does not run until it is enabled. Use the plugin list in the EmDash admin if your version offers one, or call the admin API as a user with the `plugins:manage` permission, for example with a personal access token that has the admin scope:

   ```bash
   curl -X POST "https://your-site.example/_emdash/api/admin/plugins/deploy-trigger/enable" \
     -H "Authorization: Bearer $EMDASH_ADMIN_TOKEN"
   ```

   The endpoint comes from the `emdash` 1.2.0 source; check it against the version you run. The cron task is registered at enable time, so **enable the plugin again (disable, then enable) after you change `schedule`**.

4. **Check that it works.** After enabling, the server log shows `deploy-trigger registered` with the schedule. On the next run you should see `Deploy hook called` with `status: 200` and a new deployment in the Cloudflare Pages dashboard. To test without waiting a day, temporarily use `schedule: "*/15 * * * *"` in a staging environment, enable the plugin, and watch the log. Switch back to the real schedule afterwards. If the log shows an error instead, look at the `reason` field (see [Log messages](#log-messages)).

## Options (`deployTrigger({...})`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `schedule` | `string` | `"0 21 * * *"` | 5-field cron expression, evaluated in UTC (the default is 06:00 JST). `undefined` uses the default. |
| `allowedHosts` | `string[]` | `["api.cloudflare.com"]` | Hosts the plugin may contact. Set this to the exact host of your hook URL. **Do not use wildcards** such as `"*"` or `"*.example.com"`: they let the plugin (and anyone who can change `DEPLOY_HOOK_URL`) send requests to many more hosts than needed. |
| `minIntervalMinutes` | `number` | `15` | Shortest allowed gap between two runs of `schedule`. A shorter schedule makes `deployTrigger()` throw at startup. Lower it deliberately if you really want a more frequent build. |
| `messages` | `Record<string, string>` | English messages | Overrides log messages. See [Log messages](#log-messages). |

`DEPLOY_TRIGGER_SCHEDULE` in the example above is just an environment variable your app reads and passes as `schedule`; the plugin itself does not read it.

Schedule validation: only 5-field cron expressions (and the `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` macros) are accepted; six-field (seconds) expressions and one-shot ISO dates are rejected. The shortest gap is computed from the minute and hour fields. The default of 15 minutes means `*/15 * * * *` is the most frequent schedule that passes.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DEPLOY_HOOK_URL` | Yes (secret) | Deploy hook URL. **Only `https://` is accepted**; any other scheme is skipped with a warning. It contains the hook ID, so never commit, log, or share it. If unset, the plugin logs a warning and does nothing. |

The variable is read from `process.env` first and then from `virtual:emdash/env` (the EmDash runtime environment on Cloudflare Workers). The Workers path is covered only by unit tests with a stub; it has not been tried on a real Workers deployment.

## Retry policy

A deploy hook is a non-idempotent `POST`, so the plugin avoids sending it twice.

| Situation | Retried? |
| --- | --- |
| Connection could not be established (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, connect timeout) | Yes, up to 3 retries, exponential backoff from 1 second |
| `429` | Yes, up to 3 retries. `Retry-After` is honored; if it is longer than 60 seconds the plugin gives up |
| Timeout (30 seconds per attempt), `5xx`, other `4xx`, other errors (including `ECONNRESET`) | No |

A single run makes at most 4 attempts.

## Log messages

Logs are written through the EmDash plugin logger (`ctx.log`). Structured fields: `host`, `status`, `reason`, `errorName`, `errorCode`, `attempt`, `willRetry`. The URL and exception messages are never logged. `reason` values: `missing_url`, `invalid_url`, `insecure_scheme`, `host_not_allowed`, `http_status`, `connect_error`, `timeout`, `network_error`, `retry_after_too_long`.

Failed attempts that will be retried are logged with `warn`; the final failure is logged with `error`. **There is no failure notification** (no e-mail or webhook): monitor your logs for `error` entries from `deploy-trigger`.

The default messages are English. Override any of them with the `messages` option (unspecified keys keep the default):

| Key | Default |
| --- | --- |
| `registered` | `deploy-trigger registered` |
| `hookCalled` | `Deploy hook called` |
| `attemptFailed` | `Deploy hook request failed; will retry` |
| `gaveUp` | `Deploy hook request failed; giving up` |
| `urlMissing` | `DEPLOY_HOOK_URL is not set; skipping the deploy hook` |
| `urlInvalid` | `DEPLOY_HOOK_URL is not a valid URL; skipping the deploy hook` |
| `urlInsecure` | `DEPLOY_HOOK_URL must use https; skipping the deploy hook` |
| `hostNotAllowed` | `The deploy hook host is not in allowedHosts; skipping the deploy hook` |

A Japanese set is shown in [README.ja.md](./README.ja.md).

## Security notes and limitations

- Treat `DEPLOY_HOOK_URL` as a secret.
- The plugin uses the `network:request` capability, and requests are limited to the hosts in `allowedHosts`. The plugin also checks the host itself before sending, so a mismatch is reported as `host_not_allowed` instead of a generic error.
- Depends on EmDash's native plugin API (`definePlugin`, `ctx.cron`, `ctx.http`), which may change in `emdash` minor versions.
- Cron times are in UTC.
- Disabling the plugin disables its cron task (EmDash side); it is not deleted.
- To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Development

```bash
pnpm install
pnpm test     # unit tests (deploy, runtime, index, schedule) and the package check tests
pnpm check    # inspects the files that `pnpm pack` would publish (isolation, names, required fields)
```

`runtime.js` and `index.js` are tested with a mock `ctx` (`cron.schedule`, `http.fetch`, `log`) and a stub of `emdash`. `pnpm-workspace.yaml` configures stand-alone development of this package.

## Maintainers

- Releases are published by `.github/workflows/release.yml` from a `v*` tag on `main`, using npm Trusted Publishing (no token). Register the Trusted Publisher on npmjs.com with this repository, the workflow file `release.yml` and the environment `npm-publish`, and create the `npm-publish` environment in the GitHub repository settings.
- npm requires the package to exist before a Trusted Publisher can be registered, so the first version is published manually.
- Enable **Private vulnerability reporting** in the repository settings (Settings > Code security). [SECURITY.md](./SECURITY.md) relies on it.
- Project-specific names are checked by `pnpm check` through an optional, git-ignored `.check-package.private-terms` file (one term per line; or set `CHECK_PACKAGE_PRIVATE_TERMS_FILE`). The check is skipped when the file is absent.

## License

[MIT](./LICENSE)
