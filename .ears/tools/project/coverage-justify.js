/* 커버리지 정당화 기록.
 *
 * 측정에서 미달인 줄(실행 안 된 줄 · 가지 않은 분기 · 확인 안 된 조건)에 사람이 근거를 남기면,
 * 그 줄은 '정당화된 것'으로 유효 커버리지에 더한다. 실측값은 그대로 남기고 따로 계산한다.
 *
 * 기록: 대상 프로젝트 test-spec/coverage-justifications.json (커밋해서 CI 게이트도 같은 기준을 쓴다)
 * 각 항목은 그 줄의 코드 내용을 함께 남긴다. 코드가 바뀌어 그 내용이 없어지면 정당화는 무효(stale)가 되어 반영하지 않는다.
 * 줄만 옮겨졌으면(같은 내용이 파일에 한 곳만 있으면) 옮겨진 줄에 반영한다.
 * 지우지 않는다: 취소하면 withdrawn 으로 남는다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const shared = require("../../webapp/coverage-justify.js");

const FILE = "test-spec/coverage-justifications.json";
const SCHEMA = "coverage-justifications/v1";
const PATH_RE = /^src\/[A-Za-z0-9_.-]+\.c$/;

class JustifyError extends Error { constructor(message, status, code) { super(message); this.status = status || 400; this.code = code || null; } }

const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const str = (v, n) => String(v == null ? "" : v).slice(0, n);

function load(root) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(root, ...FILE.split("/")), "utf8"));
    // 항목이 객체가 아니거나 파일·상태가 없는 것은 쓸 수 없는 기록이다(손으로 고치다 깨진 경우). 읽을 때 뺀다.
    if (o && o.schema === SCHEMA && Array.isArray(o.items)) return Object.assign({}, o, { items: o.items.filter((it) => it && typeof it === "object" && !Array.isArray(it) && typeof it.file === "string" && typeof it.status === "string") });
  } catch (_) { /* 없거나 깨짐 */ }
  return { schema: SCHEMA, note: "커버리지 정당화 — 사람이 남긴 근거. 측정값은 바꾸지 않고 유효 커버리지에만 더한다.", items: [] };
}
function save(root, data) {
  const f = path.join(root, ...FILE.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
}
const linesOf = (root, file) => { try { return fs.readFileSync(path.join(root, ...file.split("/")), "utf8").replace(/\r\n?/g, "\n").split("\n"); } catch (_) { return null; } };

// 지금 코드에 맞춰 각 정당화의 상태를 정한다: valid(그 줄 그대로) · moved(같은 내용이 다른 한 줄로 옮겨짐) · stale(내용이 없어짐·여러 곳)
function resolve(root) {
  const data = load(root);
  const cache = new Map();
  return data.items.map((it) => {
    if (it.status !== "active") return Object.assign({}, it, { state: "withdrawn" });
    if (!cache.has(it.file)) cache.set(it.file, linesOf(root, it.file));
    const lines = cache.get(it.file);
    if (!lines) return Object.assign({}, it, { state: "stale", note: "파일이 없습니다" });
    const want = shared.normLine(it.text);
    if (want && shared.normLine(lines[it.line - 1]) === want) return Object.assign({}, it, { state: "valid", current_line: it.line });
    const hits = lines.map((l, i) => (shared.normLine(l) === want ? i + 1 : 0)).filter(Boolean);
    if (want && hits.length === 1) return Object.assign({}, it, { state: "moved", current_line: hits[0] });
    return Object.assign({}, it, { state: "stale", note: hits.length > 1 ? "같은 내용의 줄이 여러 곳이라 어느 줄인지 알 수 없습니다" : "그 줄의 코드가 바뀌어 정당화가 무효가 되었습니다 — 다시 확인해 남기세요" });
  });
}
// 반영할 것(지금 줄 번호 기준)
const activeEntries = (resolved) => resolved.filter((x) => x.state === "valid" || x.state === "moved").map((x) => ({ id: x.id, file: x.file, line: x.current_line, kind: x.kind, reason: x.reason, by: x.by, at: x.at }));

// 측정 결과에 정당화를 더한다(게이트·기록용). 반영한 정당화와 무효가 된 정당화를 함께 남긴다.
function applyTo(root, cov) {
  if (!cov || cov.measured === false || !cov.statement) return cov;
  const resolved = resolve(root);
  const use = activeEntries(resolved);
  const out = shared.apply(cov, use);
  // 실제로 미달 줄에 반영된 것만 근거로 남긴다
  const usedKey = new Set();
  for (const f of out.files || []) for (const k of ["statement", "branch", "mcdc"]) for (const l of (f.justified_lines && f.justified_lines[k]) || []) usedKey.add(`${f.file}:${l}:${k}`);
  out.justifications = use.filter((e) => usedKey.has(`${e.file}:${e.line}:${e.kind}`));
  out.stale_justifications = resolved.filter((x) => x.state === "stale").map((x) => ({ id: x.id, file: x.file, line: x.line, kind: x.kind, note: x.note }));
  return out;
}

// 지금 코드 그대로 잰 이 PC 의 가장 최근 측정(검증 기록). 소스·시험·빌드 설정이 그 뒤에 바뀌었으면 줄 번호를 견줄 수 없으므로 쓰지 않는다.
function latestMeasured(root) {
  try {
    const verlog = require("../ci/verlog.js");
    const runs = verlog.list(root);
    if (!runs.length) return null;
    const current = verlog.sourceHashes(root);
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i].record;
      if (!r.coverage || !Array.isArray(r.coverage.files) || !r.coverage.files.length) continue;
      if (verlog.changedSince(r, current) === false) return { file: runs[i].file, coverage: r.coverage };
    }
  } catch (_) { /* 기록을 읽지 못하면 견주지 않는다 */ }
  return null;
}
// 그 측정에서 이 줄이 미달인지: true(미달) · false(미달 아님) · null(그 측정으로는 알 수 없음 — 파일이 없거나 그 종류를 재지 않았거나 목록이 잘림)
function shortfallIn(cov, file, line, kind) {
  const f = cov && Array.isArray(cov.files) ? cov.files.find((x) => x.file === file) : null;
  if (!f) return null;
  const pick = { statement: [f.statement, f.uncovered_lines, (x) => x === line], branch: [f.branch, f.uncovered_branches, (x) => x && x.line === line], mcdc: [f.mcdc, f.uncovered_conditions, (x) => x && x.line === line] }[kind];
  if (!pick || !pick[0] || !pick[0].total || !Array.isArray(pick[1]) || pick[1].length >= 1000) return null;
  return pick[1].some(pick[2]);
}

// measured: latestMeasured() 의 결과(없으면 견주지 않는다). otherEnv: 이 PC 의 측정에서는 미달이 아니지만 다른 환경(GitHub 검사 등)의 결과를 보고 남긴다.
function add(root, { file, line, kind, reason, by, now, measured, otherEnv, category, advice }) {
  // 추천(이전 사례 또는 AI)을 받아 채운 경우: 출처만 남긴다. 근거 글과 확정은 사람의 것이다.
  const adv = advice && typeof advice === "object" && ["ai", "history"].includes(advice.source)
    ? Object.assign({ source: advice.source, verdict: str(advice.verdict, 20) }, advice.model ? { model: str(advice.model, 80) } : {}, advice.precedent ? { precedent: str(advice.precedent, 200) } : {}) : null;
  const cat = category === undefined || category === null || category === "" ? null : String(category);
  if (cat && !Object.prototype.hasOwnProperty.call(shared.CATEGORIES, cat)) throw new JustifyError(`분류는 ${Object.keys(shared.CATEGORIES).join(" · ")} 중 하나여야 합니다.`);
  if (!PATH_RE.test(String(file || ""))) throw new JustifyError("정당화할 수 있는 곳은 src/ 의 C 파일입니다.");
  if (!Object.prototype.hasOwnProperty.call(shared.KINDS, kind)) throw new JustifyError("종류는 statement · branch · mcdc 중 하나여야 합니다.");
  const n = Number(line);
  const lines = linesOf(root, file);
  if (!lines) throw new JustifyError(`${file} 이 없습니다.`, 404);
  if (!Number.isInteger(n) || n < 1 || n > lines.length) throw new JustifyError("줄 번호가 올바르지 않습니다.");
  const text = lines[n - 1];
  if (!shared.normLine(text)) throw new JustifyError("빈 줄·주석 줄은 정당화할 수 없습니다.");
  if (!/[A-Za-z0-9_]/.test(shared.normLine(text))) throw new JustifyError("중괄호·기호만 있는 줄에는 실행할 코드가 없어 정당화할 수 없습니다. 실행되지 않은 문장이 있는 줄을 고르세요.");
  // 지금 코드로 잰 최근 측정에서 미달이 아닌 줄(이미 실행된 줄 등)은 정당화할 것이 없다.
  const notShort = measured ? shortfallIn(measured.coverage, file, n, kind) === false : false;
  if (notShort && !otherEnv) throw new JustifyError(`이 PC 의 가장 최근 측정(${measured.file})에서 ${file}:${n} 은(는) 미달(${shared.KINDS[kind]})이 아닙니다. 정당화는 미달인 곳에만 남깁니다.`, 409, "not_shortfall");
  const why = str(reason, 1000).trim();
  if (why.length < 5) throw new JustifyError("정당화 근거를 적어 주세요(5자 이상). 예: 방어 코드 — 하드웨어 고장 때만 도달");
  const who = str(by, 80).trim();
  if (!who) throw new JustifyError("정당화한 사람의 이름이 필요합니다.");
  const at = (now || new Date()).toISOString();
  const data = load(root);
  // 같은 줄·같은 종류의 이전 정당화는 새것으로 바꾼다(지우지 않고 withdrawn 으로)
  for (const it of data.items) if (it.status === "active" && it.file === file && it.line === n && it.kind === kind) Object.assign(it, { status: "withdrawn", withdrawn_by: who, withdrawn_at: at, withdrawn_note: "새 정당화로 바꿈" });
  const item = Object.assign({ id: `CJ-${stamp(new Date(at))}-${randomBytes(2).toString("hex")}`, file, line: n, kind, text: text.trim(), reason: why, by: who, at, status: "active" }, cat ? { category: cat } : {}, adv ? { advice: adv } : {},
    notShort ? { basis: "other-environment", basis_note: `이 PC 의 측정(${measured.file})에서는 미달이 아님 — 다른 환경의 결과를 보고 남김` } : {});
  data.items.push(item);
  save(root, data);
  return item;
}

function withdraw(root, { id, by, now, note }) {
  const who = str(by, 80).trim();
  if (!who) throw new JustifyError("취소한 사람의 이름이 필요합니다.");
  const data = load(root);
  const it = data.items.find((x) => x.id === id && x.status === "active");
  if (!it) throw new JustifyError("취소할 정당화를 찾지 못했습니다.", 404);
  const why = str(note, 500).trim();
  Object.assign(it, { status: "withdrawn", withdrawn_by: who, withdrawn_at: (now || new Date()).toISOString() }, why ? { withdrawn_note: why } : {});
  save(root, data);
  return it;
}

// 지금 코드로 잰 가장 최근 측정의 미달 목록(코드 보기에 '미달'로 표시하는 데 쓴다). 견줄 측정이 없으면 null.
function shortfalls(root) {
  const m = latestMeasured(root);
  if (!m) return null;
  return { run: m.file, files: (m.coverage.files || []).map((f) => ({
    file: f.file,
    statement: (f.uncovered_lines || []).slice(0, 2000),
    branch: (f.uncovered_branches || []).slice(0, 2000).map((x) => ({ line: x.line, missed: x.missed })),
    mcdc: (f.uncovered_conditions || []).slice(0, 2000).map((x) => ({ line: x.line, missed: x.missed })),
  })) };
}

// 같은 코드(주석·공백 차이를 뺀 같은 줄)에 남긴 이전 정당화 — 취소·무효가 된 것도 참고로 보인다. 최근 것부터.
function similar(root, file, line) {
  const lines = linesOf(root, String(file || ""));
  const n = Number(line);
  if (!lines || !Number.isInteger(n) || n < 1 || n > lines.length) return [];
  const want = shared.normLine(lines[n - 1]);
  if (!want) return [];
  return load(root).items
    .filter((it) => shared.normLine(it.text) === want && !(it.status === "active" && it.file === file && it.line === n))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, 5)
    .map((it) => ({ id: it.id, file: it.file, line: it.line, kind: it.kind, category: it.category || null, reason: it.reason, by: it.by, at: it.at, status: it.status }));
}

// 이 줄에 남긴 기록 전체(지금 유효한 것과 바꾸거나 되돌린 것 모두). 오래된 것부터.
// 코드가 줄만 옮겨졌어도 같은 내용의 줄이면 같은 기록으로 본다. 기록은 지우지 않으므로 누가 언제 왜 바꿨는지가 그대로 남는다.
function historyOf(root, file, line) {
  const lines = linesOf(root, String(file || ""));
  const n = Number(line);
  const want = lines && Number.isInteger(n) && n >= 1 && n <= lines.length ? shared.normLine(lines[n - 1]) : "";
  return load(root).items
    .filter((it) => it.file === file && (it.line === n || (want && shared.normLine(it.text) === want)))
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
    .map((it) => ({ id: it.id, line: it.line, kind: it.kind, category: it.category || null, reason: it.reason, by: it.by, at: it.at, status: it.status,
      withdrawn_by: it.withdrawn_by || null, withdrawn_at: it.withdrawn_at || null, withdrawn_note: it.withdrawn_note || null }));
}

module.exports = { FILE, SCHEMA, JustifyError, load, resolve, activeEntries, applyTo, add, withdraw, latestMeasured, shortfallIn, shortfalls, similar, historyOf };
