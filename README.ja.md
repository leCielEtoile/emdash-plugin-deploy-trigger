# emdash-plugin-deploy-trigger

[English](./README.md) | 日本語

EmDash 用のネイティブプラグイン。cron でデプロイフック（Cloudflare Pages など）を定期的に呼ぶ。静的サイトの定期ビルドに使う。

## 概要

- プラグインが「有効化」されたとき（`plugin:activate`）に cron タスク `daily-deploy` を登録する。
- 実行時に環境変数 `DEPLOY_HOOK_URL`（https のみ）へ POST する。
- 再送するのは「リクエストが届いていないことが確実な接続失敗」と 429（`Retry-After` を尊重）だけ。タイムアウト・5xx・その他は**再送しない**（デプロイフックは冪等でない POST で、再送するとビルドが重複して起動しうるため）。詳細は「再送の方針」。
- 失敗しても例外は投げない。ログにはホスト名・HTTP ステータス・例外名・試行回数だけを出し、URL も例外メッセージも出さない（URL にフック ID（秘密）が含まれるため）。
- schedule は起動時に検証し、既定では 15 分未満の間隔を拒否する（書き間違いでビルド枠を使い切らないため）。

**手動実行の機能は無い**（管理画面のボタンも API ルートも無い）。起動するのは cron タスクだけ。

## インストール

npm にはまだ公開していない。GitHub からリリースタグを指定して入れる:

```bash
pnpm add github:leCielEtoile/emdash-plugin-deploy-trigger#semver:v0.1.0
```

### npm 公開後

リリースノートに npm 公開済みと書かれた後は、名前でも入れられる:

```bash
pnpm add emdash-plugin-deploy-trigger
```

公開済みとリリースノートに書かれるまでは実行しないこと（それまで npm 上のこの名前は本プロジェクトの管理下にない）。

ピア依存: `emdash >=1.1.0`（プラグイン API の利用は `emdash` 1.2.0 のソースで確認）。

## セットアップ

1. **インストール**して `astro.config.mjs` に登録する:

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

2. **環境変数 `DEPLOY_HOOK_URL`** を EmDash サーバーに設定する（git にコミットしない）。Cloudflare Pages なら Settings > Builds > Deploy hooks で作成する。URL は `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/<id>` の形。それ以外のホストなら `allowedHosts` にそのホストを追加する（下のオプション参照）。

3. **プラグインを有効化する。** 設定ファイルで登録しただけでは動かない。使っている EmDash の管理画面にプラグイン一覧があればそこで「deploy-trigger」を有効にするか、`plugins:manage` 権限のあるユーザー（例: admin スコープの個人アクセストークン）で管理 API を呼ぶ:

   ```bash
   curl -X POST "https://your-site.example/_emdash/api/admin/plugins/deploy-trigger/enable" \
     -H "Authorization: Bearer $EMDASH_ADMIN_TOKEN"
   ```

   エンドポイントは `emdash` 1.2.0 のソースによる。使っているバージョンで確認すること。cron タスクは有効化時に登録されるため、**`schedule` を変えたら無効化して再度有効化する**。

4. **動作を確認する。** 有効化すると、サーバーログに `deploy-trigger registered`（schedule つき）が出る。次の実行時に `status: 200` つきの `Deploy hook called` が出て、Cloudflare Pages に新しいデプロイが作られる。1 日待たずに試すには、ステージング環境で一時的に `schedule: "*/15 * * * *"` にして有効化し、ログを見る（確認後に本来の schedule に戻す）。エラーが出た場合は `reason` フィールドを見る（「ログ文言」参照）。

## オプション（`deployTrigger({...})`）

| オプション | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `schedule` | `string` | `"0 21 * * *"` | 5 フィールドの cron 式（UTC で評価。既定は JST 6:00）。`undefined` なら既定 |
| `allowedHosts` | `string[]` | `["api.cloudflare.com"]` | プラグインが通信してよいホスト。フック URL のホストそのものに合わせる。**`"*"` や `"*.example.com"` などのワイルドカードは使わない**（必要以上のホストへ送信できてしまう） |
| `minIntervalMinutes` | `number` | `15` | `schedule` の実行間隔の下限（分）。これより短い schedule は起動時に例外。意図して頻繁に実行したい場合だけ下げる |
| `messages` | `Record<string, string>` | 英語の文言 | ログ文言の上書き（「ログ文言」参照） |

上の例の `DEPLOY_TRIGGER_SCHEDULE` はアプリ側が読んで `schedule` に渡すだけの環境変数で、プラグイン自身は読まない。

schedule の検証: 5 フィールドの cron 式（と `@hourly` `@daily` `@weekly` `@monthly` `@yearly`）だけ受け付ける。秒つきの 6 フィールドや ISO 日時（ワンショット）は拒否する。最短間隔は分・時フィールドから計算する。既定の 15 分なら `*/15 * * * *` が通る最も頻繁な schedule。

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DEPLOY_HOOK_URL` | 必須（秘密） | デプロイフックの URL。**https のみ**（それ以外は警告してスキップ）。フック ID を含むので、コミット・ログ出力・共有しない。未設定なら警告ログを出して何もしない |

`process.env` を先に読み、無ければ `virtual:emdash/env`（Cloudflare Workers での EmDash の環境変数）を読む。Workers 側は代役を使った単体テストのみで、実際の Workers 環境では試していない。

## 再送の方針

デプロイフックは冪等でない POST なので、二重に送らないようにしている。

| 状況 | 再送 |
| --- | --- |
| 接続できなかった（`ECONNREFUSED` `ENOTFOUND` `EAI_AGAIN`、接続タイムアウト） | する（最大 3 回、1 秒からの指数バックオフ） |
| `429` | する（最大 3 回）。`Retry-After` を尊重。60 秒を超える場合は諦める |
| タイムアウト（1 回 30 秒）・`5xx`・その他の `4xx`・その他の例外（`ECONNRESET` を含む） | しない |

1 回の実行で試行は最大 4 回。

## ログ文言

ログは EmDash のプラグイン用ロガー（`ctx.log`）に出る。構造化フィールド: `host` `status` `reason` `errorName` `errorCode` `attempt` `willRetry`。URL と例外メッセージは出さない。`reason` の値: `missing_url` `invalid_url` `insecure_scheme` `host_not_allowed` `http_status` `connect_error` `timeout` `network_error` `retry_after_too_long`。

再送する失敗は `warn`、最終的な失敗は `error`。**失敗の通知機能（メール・Webhook）は無い**ので、ログ監視で `deploy-trigger` の `error` を検知すること。

既定の文言は英語。`messages` オプションで上書きできる（指定しなかったキーは既定のまま）。日本語にする設定例:

```js
deployTrigger({
	messages: {
		registered: "deploy-trigger を登録しました",
		hookCalled: "デプロイフックを呼びました",
		attemptFailed: "デプロイフックの呼び出しに失敗しました（再送します）",
		gaveUp: "デプロイフックの呼び出しに失敗しました（再送しません）",
		urlMissing: "DEPLOY_HOOK_URL が未設定のためデプロイフックを呼びません",
		urlInvalid: "DEPLOY_HOOK_URL が URL として不正なためデプロイフックを呼びません",
		urlInsecure: "DEPLOY_HOOK_URL は https のみ使えるためデプロイフックを呼びません",
		hostNotAllowed: "フックのホストが allowedHosts に無いためデプロイフックを呼びません",
	},
})
```

## 制限事項・セキュリティ上の注意

- `DEPLOY_HOOK_URL` は秘密として扱う。
- `network:request` ケーパビリティを使い、通信は `allowedHosts` のホストに限られる。送信前にプラグイン自身もホストを確認し、不一致は汎用エラーではなく `host_not_allowed` として記録する。
- `emdash` のネイティブプラグイン API（`definePlugin`、`ctx.cron`、`ctx.http`）に依存する。`emdash` のマイナーバージョンで変わりうる。
- cron の時刻は UTC。
- プラグインを無効化すると cron タスクも無効になる（EmDash 側の動作。削除はされない）。
- 脆弱性の報告方法は [SECURITY.md](./SECURITY.md) を参照。

## 開発

```bash
pnpm install
pnpm test    # 単体テスト（deploy・runtime・index・schedule）+ パッケージ検査のテスト
pnpm check   # `pnpm pack` で公開される同梱ファイルの検査（分離性・固有名・必須項目）
```

`runtime.js` と `index.js` は模擬 `ctx`（`cron.schedule` / `http.fetch` / `log`）と `emdash` の代役でテストしている。`pnpm-workspace.yaml` はこのパッケージを単独で開発するための設定。

## メンテナ向け

- リリースは `main` 上の `v*` タグから `.github/workflows/release.yml` が npm Trusted Publishing（トークン不要）で公開する。npmjs.com で、このリポジトリ・ワークフローファイル `release.yml`・環境名 `npm-publish` を Trusted Publisher に登録し、GitHub のリポジトリ設定に `npm-publish` 環境を作る。
- Trusted Publisher の登録にはパッケージが存在している必要があるため、初回バージョンだけ手動で公開する。
- リポジトリ設定（Settings > Code security）で **Private vulnerability reporting を有効化する**。[SECURITY.md](./SECURITY.md) はこれを前提にしている。
- 固有名の検査は、任意の外部ファイル `.check-package.private-terms`（gitignore 済み・1行1語。環境変数 `CHECK_PACKAGE_PRIVATE_TERMS_FILE` でも指定可）を使って `pnpm check` が行う。ファイルが無ければこの検査はスキップされる。

## ライセンス

[MIT](./LICENSE)
