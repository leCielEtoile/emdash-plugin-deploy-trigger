import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { findViolations, loadPrivateTerms } from "../check-package.mjs"

// 非公開語はテスト内でダミー語を一時ファイルに書いて検証する（実在の固有名は書かない）
const TERM = "acme-secret-term"
const termsFile = (content) => {
	const d = mkdtempSync(join(tmpdir(), "terms-"))
	const p = join(d, "terms.txt")
	writeFileSync(p, content)
	return p
}
const withTerms = (content) => ({ env: { CHECK_PACKAGE_PRIVATE_TERMS_FILE: termsFile(content) } })
const NO_TERMS = { env: {} }

const GOOD_PKG = {
	name: "emdash-x", version: "0.1.0", type: "module", exports: { ".": "./index.js" },
	peerDependencies: { emdash: ">=1.1.0" }, license: "MIT", repository: { type: "git", url: "git+https://example.test/x.git" },
	scripts: { test: "vitest run" },
}
// files を渡さなければ、渡したファイルすべてを tarball に同梱する設定にする
function pkg(files, manifest = { ...GOOD_PKG, files: ["index.js", ...Object.keys(files)] }) {
	const dir = mkdtempSync(join(tmpdir(), "chk-"))
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
	writeFileSync(join(dir, "README.md"), "# x\n")
	if (!files["index.js"]) writeFileSync(join(dir, "index.js"), "export {}\n")
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true })
		writeFileSync(join(dir, name), body)
	}
	return dir
}
const clean = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
const check = (files, manifest) => {
	const dir = pkg(files, manifest)
	try { return findViolations(dir) } finally { clean(dir) }
}
const rules = (v, rule) => v.filter((m) => m.rule === rule)
const privateTerms = (dir, opts) => rules(findViolations(dir, opts), "no-private-terms").map((m) => m.file)

describe("findViolations", () => {
	it("条件を満たすパッケージは違反なし", () => {
		expect(check({ "index.js": 'import { a } from "./lib.js"\nexport const b = a\n', "lib.js": "export const a = 1\n" })).toEqual([])
	})

	it("パッケージ内に収まる相対参照（../ を使っても）は違反にしない", () => {
		expect(check({ "routes/a.js": 'import { x } from "../lib.js"\nexport const y = x\n', "lib.js": "export const x = 1\n" })).toEqual([])
		expect(check({ "index.js": 'export const b = new URL("./ok.json", import.meta.url)\n', "ok.json": "{}" })).toEqual([])
	})
})

describe("パッケージ外の参照（回避の手口）", () => {
	const escaping = {
		"静的 import": 'import x from "../../outside.js"\n',
		"空白なしの import": 'import{a}from"../../outside-nospace.js"\n',
		"export from": 'export { y } from "../other.js"\n',
		"動的 import": 'const z = await import("../../dyn.js")\n',
		"テンプレートリテラルの動的 import": "const z = await import(`../../outside-template.js`)\n",
		"createRequire + require": 'import { createRequire } from "node:module"\ncreateRequire(import.meta.url)("../../outside-require.cjs")\n',
		"ヘルパー経由の new URL": 'import { fileURLToPath } from "node:url"\nconst p = (rel) => fileURLToPath(new URL(rel, import.meta.url))\np("../../outside-helper.js")\n',
		"new URL（直接）": 'export const a = new URL("../x", import.meta.url)\n',
		"絶対パスの import": 'import("/Users/someone/private/app/lib.js")\n',
		"絶対パス（Linux ホーム）": 'export const p = "/home/someone/app/lib.js"\n',
		"絶対パス（Windows）": 'export const p = "C:\\\\work\\\\app\\\\lib.js"\n',
		"file: URL": 'import x from "file:///etc/passwd"\n',
		"スラッシュ始まりの import 指定子": 'import x from "/opt-lib/x.js"\n',
	}
	for (const [name, body] of Object.entries(escaping)) {
		it(`検出する: ${name}`, () => {
			expect(rules(check({ "index.js": body }), "no-escaping-import").length).toBeGreaterThan(0)
		})
	}

	it.each([".cjs", ".mjs", ".mts", ".cts", ".ts", ".tsx", ".jsx", ".html"])("拡張子 %s も検査する", (ext) => {
		const body = ext === ".html" ? '<script type="module">import "../../outside.js"</script>\n' : 'import "../../outside.js"\n'
		const v = check({ [`lib${ext}`]: body })
		expect(rules(v, "no-escaping-import").map((m) => m.file)).toEqual([`lib${ext}`])
	})

	it("test/ 配下でも同梱されるなら検査する", () => {
		expect(rules(check({ "test/helper.mjs": 'import "../../outside.js"\n' }), "no-escaping-import").map((m) => m.file)).toEqual(["test/helper.mjs"])
	})

	it("同梱されないファイル（files に無い）は検査対象外", () => {
		const v = check({ "index.js": "export {}\n", "scripts/dev.mjs": 'import "../../outside.js"\n' }, { ...GOOD_PKG, files: ["index.js"] })
		expect(v).toEqual([])
	})
})

describe("非公開語（外部ファイル）", () => {
	it("同梱ファイルの本文・ファイル名・README・test/ を検査する（大文字小文字を区別しない）", () => {
		const dir = pkg({ "index.js": "export {}\n", "test/mock.mjs": `export const u = "${TERM.toUpperCase()}"\n`, [`${TERM}.txt`]: "ok" })
		writeFileSync(join(dir, "README.md"), `# ${TERM}\n`)
		try {
			const files = privateTerms(dir, withTerms(`${TERM}\n`))
			expect(files).toEqual(expect.arrayContaining(["test/mock.mjs", "README.md", `${TERM}.txt`]))
			expect(files).not.toContain("index.js")
		} finally { clean(dir) }
	})
	it("表記揺れ（全角・半角カナ）は NFKC 正規化で同一視し、空白・ハイフン違いは別行で指定する", () => {
		const dir = pkg({ "a.cjs": 'module.exports = "ＡＣＭＥ－ＳＥＣＲＥＴ－ＴＥＲＭ"\n', "b.js": 'export const t = "acme secret term"\n', "c.js": 'export const t = "ﾃｽﾄ語"\n' })
		try {
			expect(privateTerms(dir, withTerms(`${TERM}\nacme secret term\nテスト語\n`)).sort()).toEqual(["a.cjs", "b.js", "c.js"])
			expect(privateTerms(dir, withTerms("ﾃｽﾄ語\n"))).toEqual(["c.js"])
		} finally { clean(dir) }
	})
	it("複数語・コメント行・空行・CRLF を扱う", () => {
		const dir = pkg({ "a.js": 'export const t = "first-term"\n', "b.js": 'export const t = "second-term"\n', "c.js": 'export const t = "commented-term"\n', "d.js": "export const t = 1\n" })
		try {
			const f = withTerms("# コメント\r\nfirst-term\r\n\r\n  second-term  \r\n# commented-term\r\n")
			expect(privateTerms(dir, f).sort()).toEqual(["a.js", "b.js"])
		} finally { clean(dir) }
	})
	it("ファイルが無ければスキップして違反にしない（環境変数のパスが存在しない場合も）", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		try {
			expect(findViolations(dir, NO_TERMS)).toEqual([])
			expect(findViolations(dir, { env: { CHECK_PACKAGE_PRIVATE_TERMS_FILE: join(tmpdir(), "no-such-terms-" + Date.now()) } })).toEqual([])
			expect(loadPrivateTerms(dir, NO_TERMS)).toBeNull()
		} finally { clean(dir) }
	})
	it("既定ではパッケージ直下の .check-package.private-terms を読む", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		writeFileSync(join(dir, ".check-package.private-terms"), `${TERM}\n`)
		try { expect(privateTerms(dir, NO_TERMS)).toEqual(["index.js"]) } finally { clean(dir) }
	})
	it("環境変数 CHECK_PACKAGE_PRIVATE_TERMS_FILE が既定より優先される", () => {
		const dir = pkg({ "index.js": 'export const t = "env-term"\n' })
		writeFileSync(join(dir, ".check-package.private-terms"), `${TERM}\n`)
		try { expect(privateTerms(dir, withTerms("env-term\n"))).toEqual(["index.js"]) } finally { clean(dir) }
	})
	it("違反メッセージに語そのものを出さない", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		try { expect(JSON.stringify(findViolations(dir, withTerms(`${TERM}\n`)))).not.toContain(TERM) } finally { clean(dir) }
	})
	it("同梱されないファイルと node_modules は検査しない", () => {
		const dir = pkg({ "index.js": "export {}\n", "docs/memo.md": TERM, "node_modules/dep/i.js": `export const c = "${TERM}"\n` }, { ...GOOD_PKG, files: ["index.js"] })
		try { expect(findViolations(dir, withTerms(`${TERM}\n`))).toEqual([]) } finally { clean(dir) }
	})
	it("無関係な語は誤検出しない", () => {
		const dir = pkg({ "index.js": 'export const a = "acme"\nexport const b = "secret"\n' })
		try { expect(findViolations(dir, withTerms(`${TERM}\n`))).toEqual([]) } finally { clean(dir) }
	})
})

describe("汎用の機微情報検査", () => {
	it.each([
		["秘密鍵", "-----BEGIN " + "PRIVATE KEY-----"],
		["GitHub トークン", "ghp_" + "a".repeat(36)],
		["ホームパス（macOS）", "/Users/alice/work/app"],
		["ホームパス（Linux）", "/home/alice/app"],
		["ホームパス（Windows）", "C:\\Users\\alice\\app"],
		["内部ホスト名", "db.corp"],
		["私設 IP", "192.168.1.20"],
		["実在しそうなメール", "alice@mycompany.io"],
	])("検出する: %s", (_n, body) => {
		const dir = pkg({ "notes.txt": body + "\n" })
		try { expect(findViolations(dir, NO_TERMS).filter((m) => m.rule === "no-sensitive-info").map((m) => m.file)).toEqual(["notes.txt"]) } finally { clean(dir) }
	})
	it("プレースホルダ（example / someone / loopback）は許す", () => {
		const dir = pkg({ "notes.txt": "a@example.com b@x.test /Users/someone/app 127.0.0.1 https://example.com/ pkg@1.2.3\n" })
		try { expect(findViolations(dir, NO_TERMS)).toEqual([]) } finally { clean(dir) }
	})
})

describe("package.json / README", () => {
	it("必須項目（license / repository を含む）の欠落を検出する", () => {
		const dir = pkg({ "index.js": "export {}\n" }, { name: "x", version: "0.1.0", type: "module" })
		try {
			const details = rules(findViolations(dir), "manifest").map((m) => m.detail)
			expect(details).toEqual(expect.arrayContaining(["license がありません", "repository がありません", "exports がありません"]))
		} finally { clean(dir) }
	})

	it("type が module でなければ違反。壊れた package.json はクラッシュせず違反として報告する", () => {
		const dir = pkg({}, { ...GOOD_PKG, files: ["index.js"], type: "commonjs" })
		try { expect(findViolations(dir).some((m) => m.detail.includes("module"))).toBe(true) } finally { clean(dir) }
		const dir2 = pkg({})
		writeFileSync(join(dir2, "package.json"), "{ not json")
		try { expect(rules(findViolations(dir2), "manifest").length).toBeGreaterThan(0) } finally { clean(dir2) }
	})

	it("exports が指すファイルが同梱されなければ違反", () => {
		const v = check({ "index.js": "export {}\n" }, { ...GOOD_PKG, exports: { ".": "./index.js", "./x": "./missing.js" }, files: ["index.js"] })
		expect(rules(v, "manifest").map((m) => m.detail)).toEqual(["exports / main / bin が指す ./missing.js が同梱されません"])
	})

	it("README.md の欠落を検出する", () => {
		const dir = mkdtempSync(join(tmpdir(), "chk-"))
		writeFileSync(join(dir, "package.json"), JSON.stringify({ ...GOOD_PKG, files: ["index.js"] }))
		writeFileSync(join(dir, "index.js"), "export {}\n")
		try { expect(findViolations(dir).map((m) => m.rule)).toContain("readme") } finally { clean(dir) }
	})
})

describe("CLI 直接実行", () => {
	const script = join(dirname(fileURLToPath(import.meta.url)), "..", "check-package.mjs")
	it("空白を含むパスに置いたスクリプトでも走り、違反で終了コード 1", () => {
		const base = mkdtempSync(join(tmpdir(), "chk dir "))
		const dir = pkg({ "index.js": 'import x from "../../outside.js"\n' })
		try {
			const copy = join(base, "check.mjs")
			writeFileSync(copy, readFileSync(script, "utf8"))
			const r = spawnSync(process.execPath, [copy, dir], { encoding: "utf8" })
			expect(r.status).toBe(1)
			expect(r.stdout).toContain("NG")
		} finally { clean(base, dir) }
	})
	it("シンボリックリンク経由でも走る", () => {
		const base = mkdtempSync(join(tmpdir(), "chk-link-"))
		const dir = pkg({ "index.js": 'import x from "../../outside.js"\n' })
		try {
			const link = join(base, "link.mjs")
			symlinkSync(script, link)
			const r = spawnSync(process.execPath, [link, dir], { encoding: "utf8" })
			expect(r.status).toBe(1)
			expect(r.stdout).toContain("NG")
		} finally { clean(base, dir) }
	})
	it("非公開語ファイルが無いときは skipped を表示して終了コード 0", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		try {
			const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8", env: { ...process.env, CHECK_PACKAGE_PRIVATE_TERMS_FILE: "" } })
			expect(r.status).toBe(0)
			expect(r.stdout).toContain("private terms check skipped")
		} finally { clean(dir) }
	})
	it("環境変数で指定した非公開語ファイルの語を検出して終了コード 1", () => {
		const dir = pkg({ "index.js": `export const t = "${TERM}"\n` })
		try {
			const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8", env: { ...process.env, ...withTerms(`${TERM}\n`).env } })
			expect(r.status).toBe(1)
			expect(r.stdout).toContain("no-private-terms")
			expect(r.stdout).not.toContain("skipped")
		} finally { clean(dir) }
	})
	it("違反のないパッケージは終了コード 0", () => {
		const dir = pkg({ "index.js": "export {}\n" })
		try { expect(spawnSync(process.execPath, [script, dir], { encoding: "utf8" }).status).toBe(0) } finally { clean(dir) }
	})
	it("存在しないディレクトリなど検査自体が失敗したら終了コード 1（フェイルクローズ）", () => {
		const r = spawnSync(process.execPath, [script, join(tmpdir(), "no-such-dir-" + Date.now())], { encoding: "utf8" })
		expect(r.status).toBe(1)
	})
})
