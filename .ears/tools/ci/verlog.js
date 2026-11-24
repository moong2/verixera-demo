/* 검증 기록: 검증을 실행할 때마다 요구사항별 시험 결과를 파일 하나로 남기고, 실패한 시험은 원인을 분석해 함께 적는다.
 *
 * 기록 위치: targets/<이름>/verification-log/RUN-<시작 시각>-<실행 ID>.json  (verification-run/v1)
 *  - 대상 폴더 안의 추적되는 파일이다. 다음 커밋에 함께 올라가 요구사항 → 커밋 → 시험 → 결과의 이력이 된다.
 *  - 같은 실행(run_id)은 한 번만 기록한다.
 *
 * 실패 원인 분석은 두 단계다.
 *  1. 사실 수집(항상): 실패한 시험이 검증하는 요구사항, 시험 코드 위치, 그 시험의 출력,
 *     마지막으로 통과한 실행과 그 뒤에 바뀐 것(구현·시험·설계·요구사항·환경)에서 원인 후보를 좁힌다.
 *  2. AI 분석(요청 시): 요구사항·시험·구현·출력·위 사실을 주고 원인 분류와 설명, 고칠 방향을 받는다.
 *     AI 의 판단은 후보이며 사람이 확인해야 한다(기록에 모델과 함께 남는다).
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const view = require("../trace/view.js");

const SCHEMA = "verification-run/v1";
const DIR = "verification-log";
const FILE_RE = /^RUN-[A-Za-z0-9T_.-]{1,150}\.json$/;
const sha256 = (text) => "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");

const logDir = (root) => path.join(root, DIR);
// 커버리지의 파일·함수별 결과와 미달 위치(실행 안 된 줄, 가지 않은 분기, 확인 안 된 조건). 화면의 커버리지 표와 편집기 표시에 쓴다.
function coverageFiles(files) {
  if (!Array.isArray(files) || !files.length) return {};
  const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
  return {
    files: files.map((f) => Object.assign({ file: f.file, statement: f.statement, branch: f.branch }, f.has_conditions && f.mcdc ? { mcdc: f.mcdc } : {}, {
      functions: cap(f.functions, 200),
      uncovered_lines: cap(f.uncovered_lines, 1000),
      uncovered_branches: cap(f.uncovered_branches, 1000),
      uncovered_conditions: cap(f.uncovered_conditions, 1000),
    }, f.justified_lines ? { justified_lines: f.justified_lines, effective: f.effective } : {})),
  };
}
// 사람이 정당화한 미달을 더한 유효 커버리지와 그 근거(정당화 기록). 실측값과 따로 남긴다.
function justifiedOf(c) {
  if (!c || !c.effective) return {};
  return { effective: c.effective, justified: c.justified, justifications: (c.justifications || []).slice(0, 500), stale_justifications: (c.stale_justifications || []).slice(0, 200) };
}
const safe = (s) => String(s || "").replace(/[^A-Za-z0-9T_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

// 기록의 칸을 이 도구가 기대하는 모양으로 맞춘다(다른 판의 도구가 남겼거나 손으로 고쳐 칸이 빠지거나 종류가 달라도 화면 전체가 실패하지 않게).
// 내용을 지어내지는 않는다: 목록이어야 하는 칸이 목록이 아니면 빈 목록, 객체여야 하는 칸이 객체가 아니면 없는 것으로 본다. 파일은 고치지 않는다.
const plainObj = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);
function normalizeRecord(r) {
  if (!plainObj(r) || r.schema !== SCHEMA) return null;
  const out = Object.assign({}, r);
  out.started_at = typeof r.started_at === "string" ? r.started_at : "";
  out.failures = Array.isArray(r.failures) ? r.failures.filter(plainObj) : [];
  out.requirements = Array.isArray(r.requirements) ? r.requirements.filter(plainObj).map((q) => Object.assign({}, q, { tests: Array.isArray(q.tests) ? q.tests.filter(plainObj) : [] })) : [];
  for (const k of ["summary", "config", "coverage", "environment", "static_analysis", "ci", "sources"]) if (r[k] !== undefined && r[k] !== null && !plainObj(r[k])) out[k] = null;
  for (const k of ["problems", "build_errors"]) if (r[k] !== undefined && !Array.isArray(r[k])) out[k] = [];
  if (out.coverage && out.coverage.files !== undefined) out.coverage = Object.assign({}, out.coverage, { files: Array.isArray(out.coverage.files) ? out.coverage.files.filter((f) => plainObj(f) && typeof f.file === "string") : [] });
  return out;
}

function list(root) {
  const dir = logDir(root);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort()) {
    try {
      const r = normalizeRecord(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
      if (r) out.push({ file: name, record: r });
    } catch (_) { /* 읽을 수 없는 기록은 건너뛴다 */ }
  }
  return out.sort((a, b) => (a.record.started_at < b.record.started_at ? -1 : a.record.started_at > b.record.started_at ? 1 : a.file < b.file ? -1 : 1));
}

const summaryOf = (e) => ({
  file: e.file, run_id: e.record.run_id, source: e.record.source, started_at: e.record.started_at, commit: e.record.commit,
  baseline_id: e.record.baseline_id, uncommitted_changes: e.record.uncommitted_changes || 0, gate: e.record.gate, summary: e.record.summary, pinned: Boolean(e.record.environment && e.record.environment.pinned), environment: e.record.environment ? { cc: e.record.environment.cc || null, tools: e.record.environment.tools || null } : null,
  failures: e.record.failures.length, analyzed: e.record.failures.length > 0 && e.record.failures.every((f) => f.ai), ci: e.record.ci || null,
  // 목록에서 바로 보이게: 유효 커버리지(실측 + 정당화) 백분율, 정적 분석 지적 수, 게이트가 막힌 이유 수
  coverage: coverageBrief(e.record.coverage), static_findings: e.record.static_analysis && e.record.static_analysis.ran ? e.record.static_analysis.counted || 0 : null, problems: (e.record.problems || []).length, build_errors: (e.record.build_errors || []).length,
});
function coverageBrief(c) {
  if (!c) return null;
  const src = c.effective || c;
  const pct = (k) => (src[k] && typeof src[k].percent === "number" ? src[k].percent : c[k] && typeof c[k].percent === "number" ? c[k].percent : null);
  const out = { statement: pct("statement"), branch: pct("branch"), mcdc: pct("mcdc") };
  return out.statement === null && out.branch === null && out.mcdc === null ? null : out;
}

function read(root, file) {
  if (!FILE_RE.test(String(file || ""))) return null;
  const full = path.join(logDir(root), file);
  if (!fs.existsSync(full)) return null;
  try { return normalizeRecord(JSON.parse(fs.readFileSync(full, "utf8"))); } catch (_) { return null; }
}

function gitNames(root, from, to) {
  try {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "diff", "--name-only", "--relative", from, to, "--", "."], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (_) { return null; }
}

// 실행 당시의 설계·소스·시험·빌드 설정 파일 내용(해시). 다음 실행에서 무엇이 바뀌었는지 비교하는 기준이 된다.
function sourceHashes(root) {
  const out = {};
  for (const f of view.listViewable(root)) {
    if (!/^(src|tests|docs\/design)\//.test(f.path) && f.path !== "Makefile" && f.path !== "project.json") continue;
    // 파일 자리에 폴더가 있으면(예: Makefile 이 폴더) 그 항목은 건너뛴다
    try { out[f.path] = sha256(fs.readFileSync(path.join(root, ...f.path.split("/")), "utf8").replace(/\r\n?/g, "\n")); } catch (_) { /* 읽을 수 없는 것은 해시에 넣지 않는다 */ }
  }
  return out;
}

// 그 기록 뒤에 결과에 영향을 주는 파일(소스·시험·빌드 설정)이 바뀌었는지. 기록에 파일 해시가 없으면 알 수 없다(null).
function changedSince(record, current) {
  if (!record.sources) return null;
  const affects = (f) => /^(src|tests)\//.test(f) || f === "Makefile" || f === "project.json";
  const before = Object.keys(record.sources).filter(affects);
  const now = Object.keys(current).filter(affects);
  return before.length !== now.length || now.some((f) => record.sources[f] !== current[f]);
}

// 주석을 뺀 코드의 해시(C 파일만). 주석·빈 줄만 고친 것과, 동작이 바뀔 수 있는 수정을 구분하는 데 쓴다.
// 줄 끝 공백과 빈 줄은 무시한다. 들여쓰기·줄 가운데의 공백은 그대로 본다(문자열 안의 공백을 건드리지 않기 위해).
function codeHashes(root) {
  // 도구가 읽는 주석(cppcheck-suppress · fallthrough 등)은 빼지 않는다: 그런 주석을 고치면 정적 분석·빌드 결과가 달라진다.
  const forCompare = require("../trace/consistency.js").codeForCompare;
  const out = {};
  for (const f of view.listViewable(root)) {
    if (!/^(src|tests)\/.*\.(c|h)$/i.test(f.path)) continue;
    try { out[f.path] = sha256(forCompare(fs.readFileSync(path.join(root, ...f.path.split("/")), "utf8"))); } catch (_) { /* 읽을 수 없는 것은 넣지 않는다 */ }
  }
  return out;
}

// 그 기록이 지금 코드의 결과인가.
//   "same"     결과에 영향을 주는 파일이 그대로다
//   "comments" C 파일의 주석·빈 줄만 바뀌었다 — 시험 결과(통과·실패)는 지금 코드에도 유효하다. 줄 번호는 달라졌을 수 있다
//              (도구가 읽는 주석 — cppcheck-suppress · fallthrough 등 — 이 바뀐 것은 여기에 들지 않고 "changed" 다)
//   "changed"  코드·시험·빌드 설정이 바뀌었다 — 지금 코드의 증거가 아니다
//   null       기록에 파일 해시가 없어 알 수 없다
// 주석을 뺀 해시가 없는 예전 기록은 주석만 바뀌어도 "changed" 로 본다(구분할 근거가 없다).
function staleness(record, current, currentCode) {
  const changed = changedSince(record, current);
  if (changed !== true) return changed === false ? "same" : null;
  const before = record.code_sources;
  if (!before || typeof before !== "object" || !currentCode) return "changed";
  const affects = (f) => /^(src|tests)\//.test(f) || f === "Makefile" || f === "project.json";
  const then = Object.keys(record.sources).filter(affects);
  const now = Object.keys(current).filter(affects);
  if (then.length !== now.length || now.some((f) => !(f in record.sources))) return "changed";
  for (const f of now) {
    if (record.sources[f] === current[f]) continue;
    if (typeof before[f] !== "string" || before[f] !== currentCode[f]) return "changed";
  }
  return "comments";
}

// 시험 ID → 시험 코드 위치와 내용.
function testSources(root) {
  const map = new Map();
  const dir = path.join(root, "tests");
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir).filter((n) => /\.(c|h)$/.test(n)).sort()) {
    const lines = fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n?/g, "\n").split("\n");
    for (const b of view.testBlocks(lines)) if (!map.has(b.id)) map.set(b.id, { file: `tests/${name}`, startLine: b.startLine, endLine: b.endLine, code: lines.slice(b.startLine - 1, b.endLine).join("\n") });
  }
  return map;
}

// 시험 출력에서 그 시험에 관한 줄(과 바로 앞의 진단 줄)을 뽑는다.
function outputFor(testOutput, tcId) {
  const lines = String(testOutput || "").split(/\r?\n/);
  const out = [];
  const isResult = (l) => /^\s*TC-[A-Za-z0-9_.-]+[ \t]+(pass|fail|skip)\b/i.test(l);
  lines.forEach((l, i) => {
    if (!l.includes(tcId)) return;
    const before = [];
    for (let k = i - 1; k >= Math.max(0, i - 3) && !isResult(lines[k]); k--) if (lines[k].trim()) before.unshift(lines[k]);
    for (const x of [...before, l]) if (!out.includes(x)) out.push(x);
  });
  return out.slice(0, 12).map((l) => l.slice(0, 300));
}

// 마지막으로 통과한 실행 뒤에 무엇이 바뀌었는지로 원인 후보를 좁힌다.
function candidates(root, failure, results, previous, sources) {
  const facts = [];
  const lastPass = [...previous].reverse().find((e) => (e.record.requirements || []).some((q) => (q.tests || []).some((t) => t.tc_id === failure.tc_id && t.result === "pass")));
  if (!lastPass) {
    const seen = previous.some((e) => (e.record.requirements || []).some((q) => (q.tests || []).some((t) => t.tc_id === failure.tc_id)));
    facts.push({ kind: "never-passed", text: seen ? "이 시험은 기록된 실행에서 통과한 적이 없음 — 구현이 요구사항을 충족하지 못하거나 시험의 기대값이 틀렸을 수 있음" : "이 시험의 첫 실행 기록임 — 구현이 요구사항을 충족하지 못하거나 시험의 기대값이 틀렸을 수 있음" });
    return { last_pass: null, facts };
  }
  const prev = lastPass.record;
  const last = { file: lastPass.file, commit: prev.commit, started_at: prev.started_at };
  if (prev.baseline_hash !== results.baseline_hash) facts.push({ kind: "baseline", text: `요구사항 고정본이 바뀜 (${prev.baseline_id} → ${results.baseline_id}) — 요구사항 변경에 구현이나 시험이 맞춰지지 않았을 수 있음` });
  const isLog = (f) => f.startsWith(`${DIR}/`) || f.startsWith("agent-log/") || f.startsWith("impact-log/") || f.startsWith("review-log/");
  // 두 실행 모두 파일 내용을 기록했으면 내용으로 비교한다(커밋하지 않은 수정도 잡힌다). 아니면 두 커밋을 Git 으로 비교한다.
  const byContent = sources && prev.sources ? [...new Set([...Object.keys(sources), ...Object.keys(prev.sources)])].filter((f) => sources[f] !== prev.sources[f]).sort() : null;
  const names = byContent || (prev.commit && results.commit && prev.commit !== results.commit ? gitNames(root, prev.commit, results.commit) : prev.commit === results.commit ? [] : null);
  const changed = names ? names.filter((f) => !isLog(f)) : null; // 기록 파일 자체는 원인이 될 수 없다
  if (changed === null) facts.push({ kind: "unknown-diff", text: "마지막 통과 이후 바뀐 파일을 Git 으로 확인하지 못함" });
  else {
    const test = failure.location ? failure.location.file : null;
    const impl = (failure.implemented_in || []).map((f) => f.file);
    if (test && changed.includes(test)) facts.push({ kind: "test-changed", text: `시험 파일이 바뀜 (${test}) — 시험 변경이 원인일 수 있음` });
    const implChanged = [...new Set(impl.filter((f) => changed.includes(f)))];
    if (implChanged.length) facts.push({ kind: "implementation-changed", text: `구현 파일이 바뀜 (${implChanged.join(", ")}) — 구현 변경으로 인한 회귀일 수 있음` });
    const other = changed.filter((f) => f !== test && !impl.includes(f));
    const cfg = other.filter((f) => f === "project.json" || f === "Makefile");
    if (cfg.length) facts.push({ kind: "build-changed", text: `빌드 설정이 바뀜 (${cfg.join(", ")}) — 컴파일 옵션 변경의 영향일 수 있음` });
    const rest = other.filter((f) => !cfg.includes(f) && /^src\//.test(f));
    if (rest.length) facts.push({ kind: "other-source-changed", text: `연결되지 않은 다른 소스가 바뀜 (${rest.slice(0, 5).join(", ")}) — 공유 자료형·매크로 변경의 영향일 수 있음` });
    if (!changed.length) {
      const envSame = prev.environment && results.environment && prev.environment.fingerprint === results.environment.fingerprint;
      facts.push({ kind: envSame ? "nondeterministic" : "environment", text: envSame ? "같은 소스·같은 환경에서 결과가 달라짐 — 실행할 때마다 결과가 달라지는 시험일 수 있음" : "소스는 그대로인데 실행 환경이 다름 — 환경 차이가 원인일 수 있음" });
    }
  }
  return { last_pass: last, changed_files: changed, facts };
}

/* 검증 결과 한 번을 기록한다.
 *  input: { source: "ci"|"local", results: 결과 파일(trace-results/v1), matrix: 추적 점검 결과(result), testOutput, ci: { number, url } }
 *  돌려주는 값: { file, created, record }
 */
function record(root, input) {
  const results = input.results;
  const matrix = input.matrix || { matrix: [], errors: [], warnings: [] };
  const started = results.started_at || new Date().toISOString();
  const file = `RUN-${safe(started.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"))}-${safe(results.run_id || input.source)}.json`;
  const existing = read(root, file);
  if (existing) return { file, created: false, record: existing };

  const previous = list(root);
  const rows = matrix.matrix || [];
  // 지금 폴더의 내용이 시험한 내용과 같을 때만 파일 해시를 남긴다(CI 결과를 나중에 받아 왔는데 그 사이 파일이 바뀐 경우 제외).
  const sources = input.treeMatches ? sourceHashes(root) : null;
  const uncommitted = Array.isArray(input.dirty) ? input.dirty.length : 0;
  const count = (k) => (results.results || []).filter((x) => x.result === k).length;
  const tests = testSources(root);
  const reqsOf = (tc) => rows.filter((r) => (r.results || []).some((x) => x.tc_id === tc)).map((r) => r.requirement_id);
  const failures = (results.results || []).filter((x) => x.result === "fail").map((x) => {
    const reqs = reqsOf(x.tc_id);
    const loc = tests.get(x.tc_id) || null;
    const impl = [];
    for (const row of rows.filter((r) => reqs.includes(r.requirement_id))) for (const c of row.code || []) { const [f, fn] = String(c).split(":"); if (!impl.some((i) => i.file === f && i.func === fn)) impl.push({ file: f, func: fn || null }); }
    const failure = { tc_id: x.tc_id, requirements: reqs, location: loc ? { file: loc.file, startLine: loc.startLine, endLine: loc.endLine } : null, implemented_in: impl, output: outputFor(input.testOutput, x.tc_id) };
    return Object.assign(failure, candidates(root, failure, results, previous, sources), { ai: null });
  });
  const buildFailed = results.test_exit_code !== 0 && !(results.results || []).length;
  const problems = [
    ...(matrix.errors || []).map((e) => ({ rule: e.rule, message: e.message, where: e.where || "" })),
    ...((results.rules && results.rules.errors) || []).map((e) => ({ rule: e.rule, message: e.message, where: e.where || "" })),
  ];
  for (const p of (results.gate && results.gate.problems) || []) if (!problems.some((x) => p.includes(x.message))) problems.push({ rule: "게이트", message: p, where: "" });
  const gate = results.gate && results.gate.result ? results.gate.result : failures.length || buildFailed || problems.length ? "fail" : "pass";
  const rec = {
    schema: SCHEMA,
    run_id: results.run_id || null,
    source: input.source,
    started_at: started,
    commit: results.commit || null,
    // 커밋하지 않은 변경을 포함해 실행했으면 그 수. 0 이 아니면 이 결과는 위 커밋의 증거가 아니다.
    uncommitted_changes: uncommitted,
    baseline_id: results.baseline_id, baseline_hash: results.baseline_hash,
    config: results.config || null,
    environment: results.environment || null,
    result_fingerprint: results.result_fingerprint || null,
    gate,
    summary: { pass: count("pass"), fail: count("fail"), skip: count("skip"), total: (results.results || []).length },
    requirements: rows.map((r) => ({ requirement_id: r.requirement_id, version: r.version, status: r.status, tests: (r.results || []).map((x) => ({ tc_id: x.tc_id, result: x.result })) })),
    coverage: results.coverage && results.coverage.measured ? Object.assign({ statement: results.coverage.statement, branch: results.coverage.branch }, results.coverage.mcdc ? { mcdc: results.coverage.mcdc } : {}, results.coverage.tool ? { tool: results.coverage.tool } : {}, justifiedOf(results.coverage), coverageFiles(results.coverage.files)) : results.coverage ? { measured: false, reason: results.coverage.reason } : null,
    // 정적 분석(설정에서 켰을 때): 도구·버전·지적. 지적은 30건까지 남긴다.
    static_analysis: results.static_analysis ? Object.assign({ level: results.static_analysis.level, ran: results.static_analysis.ran, tool: results.static_analysis.tool, version: results.static_analysis.version || null },
      results.static_analysis.ran ? { fail_on: results.static_analysis.fail_on, counted: results.static_analysis.counted, total: results.static_analysis.findings.length, findings: results.static_analysis.findings.slice(0, 30) } : { reason: results.static_analysis.reason }) : null,
    problems,
    build_errors: buildFailed ? String(input.testOutput || "").split(/\r?\n/).filter((l) => /\berror\b/i.test(l)).slice(0, 20).map((l) => l.slice(0, 300)) : [],
    failures,
    ci: input.ci || null,
    sources,
    // 주석을 뺀 코드의 해시: 나중에 주석만 고친 것인지(결과는 그대로 유효) 구분하는 데 쓴다
    code_sources: sources ? codeHashes(root) : null,
  };
  fs.mkdirSync(logDir(root), { recursive: true });
  fs.writeFileSync(path.join(logDir(root), file), JSON.stringify(rec, null, 2) + "\n");
  return { file, created: true, record: rec };
}

// ── AI 실패 원인 분석 ──

const CAUSES = ["implementation", "test", "requirement", "build", "environment", "unknown"];
const SYSTEM = [
  "너는 임베디드 C 소프트웨어의 시험 실패 원인을 분석하는 검토자다.",
  "주어진 요구사항(문장과 수용 기준), 시험 코드, 구현 코드, 시험 출력, 변경 사실만 근거로 판단한다. 주어지지 않은 것은 추측하지 않는다.",
  "판단 기준: 요구사항이 기준이다. 구현이 요구사항과 다르면 implementation, 시험의 기대값이나 입력이 요구사항과 다르면 test,",
  "요구사항이 모호하거나 서로 모순되어 둘 다 그럴듯하면 requirement, 컴파일·링크 문제면 build, 코드와 무관한 실행 환경 문제면 environment, 근거가 부족하면 unknown.",
  "출력은 JSON 하나만 쓴다. 다른 글은 쓰지 않는다:",
  '{"failures":[{"tc_id":"TC-…","cause":"implementation|test|requirement|build|environment|unknown","confidence":"high|medium|low","explanation":"왜 실패했는지 한국어 2~4문장","evidence":"판단의 근거가 된 코드 줄이나 수용 기준","suggested_fix":"무엇을 어떻게 고칠지 한국어 1~2문장"}]}',
].join("\n");

async function buildAnalysisInput(root, rec) {
  const blocks = [];
  const tests = testSources(root);
  for (const f of rec.failures) {
    const lines = [`### ${f.tc_id}`];
    for (const id of f.requirements) {
      try {
        const v = await view.requirementView(root, id);
        lines.push(`[요구사항] ${JSON.stringify({ requirement: `${v.requirement.requirement_id}@v${v.requirement.version}`, text: v.requirement.text, acceptance_criteria: v.requirement.acceptance_criteria })}`);
        for (const fn of v.functions) lines.push(`[구현] ${fn.file}:${fn.startLine}-${fn.endLine}\n${fn.code}`);
      } catch (_) { lines.push(`[요구사항] ${id} (내용을 읽지 못함)`); }
    }
    const t = tests.get(f.tc_id);
    if (t) lines.push(`[시험] ${t.file}:${t.startLine}-${t.endLine}\n${t.code}`);
    lines.push(`[시험 출력]\n${f.output.join("\n") || "(이 시험에 관한 출력 줄 없음)"}`);
    lines.push(`[변경 사실]\n${(f.facts || []).map((x) => `- ${x.text}`).join("\n") || "- 없음"}`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

function parseAnalysis(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!j || !Array.isArray(j.failures)) return null;
    return j.failures.filter((x) => x && typeof x.tc_id === "string").map((x) => ({
      tc_id: x.tc_id, cause: CAUSES.includes(x.cause) ? x.cause : "unknown", confidence: ["high", "medium", "low"].includes(x.confidence) ? x.confidence : "low",
      explanation: String(x.explanation || "").slice(0, 1200), evidence: String(x.evidence || "").slice(0, 800), suggested_fix: String(x.suggested_fix || "").slice(0, 800),
    }));
  } catch (_) { return null; }
}

// 실패한 시험에 AI 분석을 붙여 기록을 고쳐 쓴다. 이미 분석한 기록은 다시 호출하지 않는다.
async function analyze(root, file, { complete, provider, model, now }) {
  const rec = read(root, file);
  if (!rec) return { error: "기록이 없습니다.", status: 404 };
  if (!rec.failures.length) return { file, record: rec, analyzed: 0 };
  if (rec.failures.every((f) => f.ai)) return { file, record: rec, analyzed: 0 };
  const user = await buildAnalysisInput(root, rec);
  const out = await complete({ provider, model, system: SYSTEM, messages: [{ role: "user", content: user }], maxTokens: 16000 });
  const parsed = parseAnalysis(out.text);
  if (!parsed) return { error: "AI 응답을 분석 결과로 읽을 수 없습니다.", status: 502 };
  let n = 0;
  for (const f of rec.failures) {
    const a = parsed.find((x) => x.tc_id === f.tc_id);
    if (a && !f.ai) { f.ai = { cause: a.cause, confidence: a.confidence, explanation: a.explanation, evidence: a.evidence, suggested_fix: a.suggested_fix }; n++; }
  }
  rec.ai_analysis = { provider, model, analyzed_at: (now || new Date()).toISOString(), prompt_sha256: sha256(SYSTEM + "\n\n" + user), response_sha256: sha256(out.text), note: "AI 의 판단은 원인 후보이며 사람이 확인해야 한다" };
  fs.writeFileSync(path.join(logDir(root), file), JSON.stringify(rec, null, 2) + "\n");
  return { file, record: rec, analyzed: n };
}

// ── 수정 제안(패치) ──

// 원인이 구현 쪽이 아니라고 분석된 실패는 코드 패치 대상에서 뺀다(시험이나 요구사항을 다시 봐야 한다).
const NOT_CODE = { test: "시험 결함으로 분석됨 — 시험과 기대 결과를 사람이 다시 확인해야 합니다", requirement: "요구사항 문제로 분석됨 — 요구사항을 보완해 새 고정본을 만들어야 합니다", environment: "실행 환경 문제로 분석됨 — 코드를 고칠 일이 아닙니다" };

// 검증 기록에서 코드 수정 제안을 요청할 내용을 뽑는다.
// 결과: { run, failures: [{ tc_id, requirements, output, ai }], skipped: [{ tc_id, reason }], build_errors, requirement_ids } 또는 { error, status }
function fixRequest(root, file) {
  const rec = read(root, file);
  if (!rec) return { error: "검증 기록이 없습니다.", status: 404 };
  const build = rec.build_errors || [];
  if (!rec.failures.length && !build.length) return { error: "이 기록에는 실패한 시험이나 빌드 오류가 없어 고칠 것이 없습니다.", status: 409 };
  // 기록 뒤에 코드가 바뀌었으면 그 실패는 지금 코드의 실패가 아닐 수 있다.
  if (changedSince(rec, sourceHashes(root))) return { error: "이 기록 뒤에 소스·시험·빌드 설정이 바뀌었습니다. 다시 검증한 뒤, 새 기록의 실패로 수정 제안을 받으세요.", status: 409 };
  const failures = [];
  const skipped = [];
  for (const f of rec.failures) {
    const cause = f.ai ? f.ai.cause : null;
    if (cause && NOT_CODE[cause]) { skipped.push({ tc_id: f.tc_id, reason: NOT_CODE[cause] }); continue; }
    failures.push({ tc_id: f.tc_id, requirements: f.requirements || [], output: (f.output || []).slice(0, 8), ai: f.ai ? { cause: f.ai.cause, explanation: f.ai.explanation, suggested_fix: f.ai.suggested_fix } : null });
  }
  if (!failures.length && !build.length) return { error: `코드로 고칠 실패가 없습니다 — ${skipped.map((s) => `${s.tc_id}: ${s.reason}`).join("; ")}`, status: 409 };
  const ids = [...new Set(failures.flatMap((f) => f.requirements))];
  return { run: file, failures, skipped, build_errors: build.slice(0, 20), requirement_ids: ids };
}

// 수정 제안을 적용했다는 사실을 그 실패 기록에 남긴다(실패 근거 → 패치 → 재시험의 연결).
function notePatch(root, file, patch) {
  const rec = read(root, file);
  if (!rec) return null;
  rec.patches = [...(rec.patches || []), patch];
  fs.writeFileSync(path.join(logDir(root), file), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

module.exports = { codeHashes, staleness, normalizeRecord, fixRequest, notePatch, changedSince, SCHEMA, DIR, FILE_RE, list, summaryOf, read, record, analyze, parseAnalysis, buildAnalysisInput, outputFor, sourceHashes, CAUSES };
