// 使い方: node scripts/check-package.mjs [パッケージのディレクトリ]（省略時はこのスクリプトの親 = リポジトリ直下）
// 公開パッケージとして問題がないかを検査する。違反があれば一覧を出して終了コード 1（検査自体が失敗した場合も 1）。
// 検査対象はリポジトリのツリーではなく、`pnpm pack --dry-run --json` が返す「実際に公開 tarball へ同梱されるファイル」。
//   (a) パッケージの外を指す参照（相対・絶対パス・file:）がない（文字列リテラルを字句的に走査。import 文の書き方に依存しない）
//   (b) 非公開語（外部ファイルで指定。無ければスキップ）と、秘密情報・ホームパス・内部ホスト名などの機微情報を、同梱される全テキストファイルの本文とファイル名に含まない
//   (c) package.json の必須項目が揃っており、exports / main / bin が指すファイルが同梱される
//   (d) README.md がある
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const CODE_EXT = /\.(?:[cm]?[jt]sx?|html?|svelte|vue|astro)$/i
const REQUIRED_MANIFEST = ["name", "version", "type", "exports", "files", "peerDependencies", "license", "repository", "scripts"]
const MAX_TEXT_BYTES = 5 * 1024 * 1024

// 非公開語は外部ファイルで管理する（リポジトリには語を一切書かない）。
//   既定: パッケージ直下の .check-package.private-terms（gitignore 済み）。環境変数 CHECK_PACKAGE_PRIVATE_TERMS_FILE でパス指定も可。
//   書式: 1行1語。# 始まりはコメント、空行は無視。大文字小文字を区別せず部分一致（NFKC 正規化後に照合）。
//         半角/全角・空白/ハイフンなどの表記揺れは、揺れごとに別の行として書く。
//   ファイルが無い場合は検査をスキップする（失敗にはしない）。
const PRIVATE_TERMS_FILE = ".check-package.private-terms"
const PRIVATE_TERMS_ENV = "CHECK_PACKAGE_PRIVATE_TERMS_FILE"
const foldTerm = (s) => s.normalize("NFKC").replace(/[​-‏⁠﻿]/g, "").toLowerCase()

export function privateTermsPath(root, env = process.env) {
	return env[PRIVATE_TERMS_ENV] ? resolve(env[PRIVATE_TERMS_ENV]) : join(root, PRIVATE_TERMS_FILE)
}

/** 非公開語ファイルを読む。無ければ null（スキップ） */
export function loadPrivateTerms(root, env = process.env) {
	const path = privateTermsPath(root, env)
	if (!existsSync(path)) return null
	const terms = readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(foldTerm).filter(Boolean)
	return { path, terms }
}

const mentionsPrivate = (text, terms) => {
	const t = foldTerm(text)
	return terms.some((w) => t.includes(w))
}

// 汎用の機微情報パターン（公開 OSS として同梱してはいけないもの）
const PLACEHOLDER_USER = "(?!(?:someone|user|username|you|name|example|runner)\\b)"
const SENSITIVE = [
	{ label: "秘密鍵", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
	{ label: "トークン", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|npm_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,})\b/ },
	{ label: "ユーザーホームのパス", re: new RegExp(`(?:/Users/|/home/|[A-Za-z]:\\\\+Users\\\\+)${PLACEHOLDER_USER}[A-Za-z0-9._-]+`, "i") },
	{ label: "内部ホスト名・私設 IP", re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|lan|intranet|local)\b|\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/i },
]
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g
const SAFE_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|invalid|example|localhost))$|^users\.noreply\.github\.com$|^noreply\./i

/** 機微情報の疑いのあるパターンのラベル一覧 */
export function findSensitive(text) {
	const out = SENSITIVE.filter(({ re }) => re.test(text)).map((s) => s.label)
	for (const m of text.matchAll(EMAIL)) if (!SAFE_EMAIL_DOMAIN.test(m[1])) { out.push("メールアドレス"); break }
	return out
}

// 文字列リテラル（'…' "…" `…`）
const LITERAL = /"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'|`((?:\\.|[^`\\])*)`/g
// import / require / from / new URL の直後にある指定子（絶対パス検出用）
const SPECIFIER_CONTEXT = /(?:\bimport\b|\brequire\b|\bfrom\b|new\s+URL)\s*\(?\s*(["'`])([^"'`\n]+)\1/g
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\|file:)/i
const ABSOLUTE_PATH_LITERAL = /^(?:\/(?:Users|home|private|tmp|var|etc|opt|mnt|root|Volumes|usr)\/|[A-Za-z]:[\\/]|\\\\|file:)/i

function escapes(root, file, spec) {
	const target = resolve(dirname(file), spec)
	return target !== root && !target.startsWith(root + sep)
}

function exportTargets(value, out = []) {
	if (typeof value === "string") out.push(value)
	else if (value && typeof value === "object") for (const v of Object.values(value)) exportTargets(v, out)
	return out
}

// pnpm pack が同梱すると判断したファイル（パッケージ内の相対パス）の一覧
function packedFiles(root) {
	const r = spawnSync("pnpm", ["pack", "--dry-run", "--json", "--dir", root], { encoding: "utf8" })
	if (r.status !== 0) throw new Error(`pnpm pack に失敗しました: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`)
	const start = r.stdout.indexOf("{")
	const json = JSON.parse(r.stdout.slice(start))
	if (!Array.isArray(json.files)) throw new Error("pnpm pack の出力に files がありません")
	return json.files.map((f) => f.path)
}

export function findViolations(pkgDir, { env = process.env } = {}) {
	const root = resolve(pkgDir)
	const priv = loadPrivateTerms(root, env)
	const violations = []
	const add = (rule, file, detail) => violations.push({ rule, file, detail })

	let manifest
	const manifestPath = join(root, "package.json")
	if (!existsSync(manifestPath)) add("manifest", "package.json", "package.json がありません")
	else {
		try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) } catch (e) { add("manifest", "package.json", `JSON として読めません: ${e.message}`) }
		if (manifest) {
			for (const key of REQUIRED_MANIFEST) if (manifest[key] === undefined) add("manifest", "package.json", `${key} がありません`)
			if (manifest.scripts && !manifest.scripts.test) add("manifest", "package.json", "scripts.test がありません")
			if (manifest.type !== undefined && manifest.type !== "module") add("manifest", "package.json", 'type は "module" にしてください')
		}
	}
	if (!existsSync(join(root, "README.md"))) add("readme", "README.md", "README.md がありません")
	// 同梱ファイルを確定できない（package.json が読めない）場合は、本文の検査に進まない
	if (!manifest) return violations

	const files = packedFiles(root)
	const packed = new Set(files)
	for (const target of [...exportTargets(manifest.exports), ...exportTargets(manifest.main), ...exportTargets(manifest.bin)]) {
		if (target.startsWith("./") && !packed.has(target.slice(2))) add("manifest", "package.json", `exports / main / bin が指す ${target} が同梱されません`)
	}

	for (const rel of files) {
		if (priv && mentionsPrivate(rel, priv.terms)) add("no-private-terms", rel, "ファイル名に非公開語（外部ファイル指定）を含みます")
		const file = join(root, rel)
		if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > MAX_TEXT_BYTES) continue
		const buf = readFileSync(file)
		if (buf.includes(0)) continue // バイナリ
		const text = buf.toString("utf8")
		if (priv && mentionsPrivate(text, priv.terms)) add("no-private-terms", rel, "非公開語（外部ファイル指定）を含みます。オプションで受け取ってください")
		for (const label of findSensitive(text)) add("no-sensitive-info", rel, `機微情報の疑い: ${label}`)
		if (!CODE_EXT.test(rel)) continue
		for (const m of text.matchAll(LITERAL)) {
			const v = m[1] ?? m[2] ?? m[3]
			if (/^\.{1,2}(?:[\\/]|$)/.test(v) && escapes(root, file, v)) add("no-escaping-import", rel, `パッケージの外を指す相対参照: ${v}`)
			else if (ABSOLUTE_PATH_LITERAL.test(v)) add("no-escaping-import", rel, `絶対パスまたは file: の参照: ${v}`)
		}
		for (const m of text.matchAll(SPECIFIER_CONTEXT)) {
			if (ABSOLUTE.test(m[2]) && !ABSOLUTE_PATH_LITERAL.test(m[2])) add("no-escaping-import", rel, `絶対パスまたは file: の指定子: ${m[2]}`)
		}
	}
	return violations
}

// 直接実行の判定は realpath ベース（シンボリックリンク・空白を含むパスでも動く）
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
	try {
		const here = dirname(fileURLToPath(import.meta.url))
		const dir = process.argv[2] ?? join(here, "..")
		const v = findViolations(dir)
		if (!loadPrivateTerms(resolve(dir))) console.log("INFO private terms check skipped（外部ファイルが無いためスキップ）")
		console.log(`${v.length === 0 ? "OK  " : "NG  "} ${resolve(dir) === process.cwd() ? "." : dir}`)
		for (const x of v) console.log(`     [${x.rule}] ${x.file}: ${x.detail}`)
		process.exit(v.length ? 1 : 0)
	} catch (e) {
		// 検査できなかった場合は成功扱いにしない（フェイルクローズ）
		console.error(`NG   検査に失敗しました: ${e instanceof Error ? e.message : e}`)
		process.exit(1)
	}
}
