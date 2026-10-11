// 5 フィールドの cron 式（UTC）の「連続する 2 回の実行の最短間隔（分）」を返す。
// 分・時フィールドだけを解釈する（日・月・曜日の制限は間隔を広げるだけなので、最短側＝制限なしとして扱う）。
// 解釈できない式（6 フィールド・ISO 日時・未知のマクロなど）は例外にする。

const MACROS = {
	"@hourly": 60,
	"@daily": 1440, "@midnight": 1440,
	"@weekly": 1440 * 7,
	"@monthly": 1440 * 28,
	"@yearly": 1440 * 365, "@annually": 1440 * 365,
}

function parseField(text, min, max, label) {
	const values = new Set()
	for (const part of text.split(",")) {
		const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
		if (!m) throw new Error(`unsupported ${label} field: ${text}`)
		const step = m[2] === undefined ? 1 : Number(m[2])
		if (step < 1) throw new Error(`invalid step in ${label} field: ${text}`)
		let lo, hi
		if (m[1] === "*") { lo = min; hi = max } else {
			const [a, b] = m[1].split("-")
			lo = Number(a)
			// "5/10" は 5 から最大値まで 10 刻み、"5" は 5 のみ
			hi = b === undefined ? (m[2] === undefined ? lo : max) : Number(b)
		}
		if (lo < min || hi > max || lo > hi) throw new Error(`${label} field out of range: ${text}`)
		for (let v = lo; v <= hi; v += step) values.add(v)
	}
	return [...values]
}

export function minIntervalMinutes(schedule) {
	if (typeof schedule !== "string" || schedule.trim() === "") throw new Error("schedule must be a non-empty cron expression")
	const expr = schedule.trim()
	if (expr.startsWith("@")) {
		if (!(expr.toLowerCase() in MACROS)) throw new Error(`unsupported schedule macro: ${expr}`)
		return MACROS[expr.toLowerCase()]
	}
	const fields = expr.split(/\s+/)
	if (fields.length !== 5) throw new Error("schedule must be a 5-field cron expression (minute hour day month weekday)")
	const minutes = parseField(fields[0], 0, 59, "minute")
	const hours = parseField(fields[1], 0, 23, "hour")
	const times = hours.flatMap((h) => minutes.map((m) => h * 60 + m)).sort((a, b) => a - b)
	// 同じ日の隣り合う実行の間隔と、翌日の最初の実行までの間隔（1 回/日なら 1440 分）
	let min = times[0] + 1440 - times[times.length - 1]
	for (let i = 1; i < times.length; i++) min = Math.min(min, times[i] - times[i - 1])
	return min
}
