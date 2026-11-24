#!/usr/bin/env node
/* 추적성 게이트: 시험 실행 → 시험 결과 파일 작성 → 추적 점검을 한 번에 수행한다.
 *
 * 대상 프로젝트의 시험 명령을 실행하고, 출력에서 "TC-ID pass|fail|skip" 줄을 읽어
 * 시험한 커밋·Baseline 해시와 함께 결과 파일(trace-results/v1)로 남긴 뒤 trace-check 를
 * --require-results 로 돌린다. 시험 명령이 어떤 언어·도구든 그 줄만 출력하면 된다.
 *
 * 사용법:
 *   node tools/trace/run-gate.js --root <대상 프로젝트> [옵션]
 * 종료 코드: 0 게이트 통과, 1 시험 실패 또는 추적성 오류, 2 실행 조건 오류.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execFile, spawn } = require("node:child_process");
const trace = require("./trace-check.js");
const project = require("../project/config.js");
const rulesCheck = require("../project/rules-check.js");
const coverage = require("../project/coverage.js");
const justify = require("../project/coverage-justify.js");
const staticAnalysis = require("../project/static-analysis.js");
const compilers = require("../project/compilers.js");
const toolchain = require("../project/toolchain.js");

const RESULT_LINE = /^\s*(TC-[A-Za-z0-9_.\-]+)[ \t]+(pass|fail|skip)\b/i;

function parseTestOutput(text) {
  const results = [];
  const seen = new Map();
  const conflicts = [];
  for (const line of text.split(/\r?\n/)) {
    const m = RESULT_LINE.exec(line);
    if (!m) continue;
    const item = { tc_id: m[1], result: m[2].toLowerCase() };
    if (seen.has(item.tc_id)) { if (seen.get(item.tc_id) !== item.result) conflicts.push(item.tc_id); continue; }
    seen.set(item.tc_id, item.result);
    results.push(item);
  }
  return { results, conflicts };
}

function git(cwd, ...args) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch (_) { return null; }
}

// 키 순서를 고정한 JSON. 같은 내용이면 어디서 만들어도 같은 문자열이 된다.
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value === undefined ? null : value);
}
const sha256 = (text) => "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");

function toolVersion(cwd, cmd, args, env) {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, env: env || process.env });
    return out.split(/\r?\n/)[0].trim() || null;
  } catch (_) { return null; }
}

// 시험을 실행한 환경. 결과가 달라졌을 때 환경 차이인지 가려내기 위한 기록이다.
// image 는 CI 가 TRACE_ENV_IMAGE 로 알려 주는 컨테이너 이미지(해시 포함)이며, 없으면 고정되지 않은 환경이다.
function describeEnvironment(cwd, env, tools) {
  const e = env || process.env;
  const t = tools || { cc: "cc", make: "make" };
  const info = {
    image: e.TRACE_ENV_IMAGE || null,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    cc: t.cc ? toolVersion(cwd, t.cc, ["--version"], e) : null,
    make: t.make ? toolVersion(cwd, t.make, ["--version"], e) : null,
  };
  return { ...info, pinned: Boolean(info.image && /@sha256:[0-9a-f]{64}$/.test(info.image)), fingerprint: sha256(canonical(info)) };
}

// 검증에 쓴 도구 목록: 무엇을(역할) 어떤 실행 파일(경로)·판(버전)·설정으로 썼는지. 검증 이력에 그대로 남는다.
function whichCmd(cmd, env) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const e = env || process.env;
  const dirs = String(e.PATH || e.Path || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ...String(e.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((x) => x.toLowerCase())] : [""];
  for (const d of dirs) for (const x of exts) { const f = path.join(d, cmd + x); try { if (fs.statSync(f).isFile()) return f; } catch (_) { /* 없음 */ } }
  return null;
}
function toolsFingerprint() {
  // 이 검증을 한 도구(tools/ 의 스크립트) 자체의 지문. 도구가 바뀌면 달라진다.
  const base = path.resolve(__dirname, "..");
  const files = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const x of es) { const f = path.join(d, x.name); if (x.isDirectory()) { if (x.name !== "node_modules") walk(f); } else if (/\.(js|json)$/.test(x.name)) files.push(f); } };
  walk(base);
  const h = crypto.createHash("sha256");
  for (const f of files.sort()) { h.update(path.relative(base, f).split(path.sep).join("/")); h.update("\0"); try { h.update(fs.readFileSync(f)); } catch (_) { /* 읽지 못함 */ } }
  return { files: files.length, sha256: "sha256:" + h.digest("hex") };
}
function toolInventory(cwd, env, t) {
  const e = env || process.env;
  const one = (role, cmd, versionArgs, extra) => (cmd ? Object.assign({ role, command: cmd, path: whichCmd(cmd, e), version: toolVersion(cwd, cmd, versionArgs, e) }, extra || {}) : null);
  let target = null;
  if (t.cc) { try { target = execFileSync(t.cc, ["-dumpmachine"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, env: e }).trim() || null; } catch (_) { target = null; } }
  const sa = t.static;
  const list = [
    one("컴파일러", t.cc, ["--version"], { target, chosen: t.compiler || null, used: t.compilerUsed || null, flags: e.CFLAGS || null }),
    one("빌드 도구", t.make, ["--version"], { test_command: t.testCmd || null }),
    t.coverage ? one("커버리지 도구", t.gcov, ["--version"], { mcdc: Boolean(t.mcdc) }) : null,
    sa ? (sa.ran ? { role: "정적 분석기", command: "cppcheck", path: sa.path || null, version: sa.version || null, options: sa.command || null, fail_on: sa.fail_on || null } : { role: "정적 분석기", command: "cppcheck", path: null, version: sa.version || null, note: sa.reason || "실행하지 못함" }) : null,
    { role: "실행 환경", command: null, path: null, version: `${os.platform()} ${os.release()} ${os.arch()} · Node ${process.version}`, image: e.TRACE_ENV_IMAGE || null },
    Object.assign({ role: "검증 도구(tools/)", command: "node tools/trace/run-gate.js", path: null, version: null }, (() => { const f = toolsFingerprint(); return { sha256: f.sha256, files: f.files }; })()),
  ];
  return list.filter(Boolean);
}

// 결과 지문: 같은 커밋·같은 Baseline·같은 시험 명령이 같은 결과를 냈는지 한 줄로 비교하기 위한 값.
// 실행 시각·실행 번호·출력 순서·실행 환경은 넣지 않는다.
function resultFingerprint(run) {
  return sha256(canonical({
    commit: run.commit || null,
    baseline_hash: run.baseline_hash,
    test_command: run.test_command,
    test_exit_code: run.test_exit_code,
    results: [...run.results].sort((a, b) => (a.tc_id < b.tc_id ? -1 : a.tc_id > b.tc_id ? 1 : 0)),
  }));
}

function parseArgs(argv) {
  const opts = { root: ".", testCmd: "make -s test", timeout: 300, commit: null, out: "trace-out", baseline: null, design: null, code: null, tests: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new trace.UsageError(`${a} 뒤에 값이 필요함`); return argv[++i]; };
    if (a === "--root") opts.root = value();
    else if (a === "--test-cmd") { opts.testCmd = value(); opts.testCmdGiven = true; }
    else if (a === "--commit") opts.commit = value();
    else if (a === "--timeout") { opts.timeout = Number(value()); if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new trace.UsageError("--timeout 은 0 보다 큰 초 단위 숫자여야 함"); }
    else if (a === "--out") opts.out = value();
    else if (a === "--baseline") opts.baseline = value();
    else if (a === "--design") opts.design = value();
    else if (a === "--code") opts.code = value();
    else if (a === "--tests") opts.tests = value();
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new trace.UsageError(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

const HELP = `추적성 게이트: 시험 실행 → 결과 파일 → 추적 점검

사용법: node tools/trace/run-gate.js --root <대상 프로젝트> [옵션]

  --root DIR        대상 프로젝트 폴더 (기본: 현재 폴더)
  --test-cmd CMD    대상 폴더에서 실행할 시험 명령 (기본: "make -s test")
  --timeout SEC     시험 명령의 제한 시간(초, 기본 300). 넘으면 중단하고 게이트 실패로 처리
                    출력에 시험마다 "TC-ID pass|fail|skip" 한 줄이 있어야 한다
  --commit SHA      시험한 커밋 (기본: git rev-parse HEAD)
  --out DIR         결과 폴더, 대상 폴더 기준 (기본: trace-out)
  --baseline FILE, --design DIRS, --code DIRS, --tests DIRS   trace-check 와 같음

결과: <out>/results.json, <out>/test-output.log, <out>/trace-matrix.json, <out>/trace-matrix.md
종료 코드: 0 통과, 1 시험 실패 또는 추적성 오류, 2 실행 조건 오류`;

// 시험 명령을 셸로 실행하고 끝날 때까지 기다린다. 제한 시간을 넘기면 그 명령이 띄운 프로세스까지 모두 끝낸다.
// (셸만 끝내면 실제 시험 프로그램이 남아 계속 돌고, Windows 에서는 폴더를 잡고 있게 된다)
function runShell(cmd, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const LIMIT = 64 * 1024 * 1024;
    let child;
    try { child = spawn(cmd, { cwd, env, shell: true, detached: !win, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { resolve({ error: e, status: null, stdout: "", stderr: "", timedOut: false }); return; }
    let stdout = ""; let stderr = ""; let size = 0; let timedOut = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { size += c.length; if (size <= LIMIT) stdout += c; });
    child.stderr.on("data", (c) => { size += c.length; if (size <= LIMIT) stderr += c; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (win) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { try { child.kill(); } catch (_) { /* 이미 끝남 */ } });
      else { try { process.kill(-child.pid, "SIGKILL"); } catch (_) { try { child.kill("SIGKILL"); } catch (__) { /* 이미 끝남 */ } } }
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: e, status: null, stdout, stderr, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ error: timedOut ? Object.assign(new Error("시험 명령 제한 시간 초과"), { code: "ETIMEDOUT" }) : null, status: timedOut ? null : code, stdout, stderr, timedOut }); });
  });
}

// hooks.staticRun: 정적 분석 실행을 바꿔 끼운다(시험용). hooks.compilerProbe: 컴파일러 버전 확인을 바꿔 끼운다(시험용).
async function run(argv, hooks) {
  const opts = parseArgs(argv);
  if (opts.help) return { code: 0, text: HELP };
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new trace.UsageError(`대상 폴더를 찾을 수 없음: ${root}`);

  const baselineFile = trace.findBaseline(root, opts.baseline);
  let baseline;
  try { baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")); }
  catch (e) { throw new trace.UsageError(`고정본 파일을 읽을 수 없음: ${baselineFile} (${e.message})`); }

  const commit = opts.commit || git(root, "rev-parse", "HEAD");
  const dirty = opts.commit ? [] : (git(root, "status", "--porcelain", "--", ".") || "").split(/\r?\n/).filter(Boolean);

  // 프로젝트 설정(project.json)이 있으면 그 컴파일 옵션으로 빌드하고, 코딩 규칙·시험 도출 방법·커버리지 기준을 함께 판정한다.
  const loaded = project.load(root);
  const config = loaded && !loaded.invalid ? loaded.config : null;
  // 빌드 도구를 찾는다. 이 PC 처럼 make·cc 라는 이름이 없으면 찾은 이름(mingw32-make, gcc)과 위치를 쓴다.
  const tools = toolchain.detect();
  const env = tools.env(process.env);
  if (!opts.testCmdGiven && tools.make && tools.make !== "make") opts.testCmd = `${tools.make} -s test`;
  const cover = Boolean(config && project.measured(config));
  // 컴파일러: 설정(build.compiler)에서 고른 것. 고정 환경(CI)에서 없거나 버전이 다르면 게이트를 막고, 이 PC 에서는 있는 것으로 돌린다.
  const pinnedEnv = Boolean(process.env.TRACE_ENV_IMAGE && /@sha256:[0-9a-f]{64}$/.test(process.env.TRACE_ENV_IMAGE));
  const comp = config ? compilers.resolve(config, tools, env, { pinned: pinnedEnv, probe: hooks && hooks.compilerProbe }) : null;
  // 조건 커버리지(MC/DC)는 gcc 14 이상에서만 잴 수 있다.
  const mcdc = Boolean(cover && config && project.on(config.coverage.mcdc.level) && (comp ? comp.mcdc : tools.ccMajor() >= 14));
  if (config) { env.CFLAGS = project.cflags(config, { mcdc }).join(" "); env.CC = comp.cc; }
  if (cover) { try { coverage.clean(root); } catch (_) { /* 지울 것이 없으면 그대로 진행 */ } }
  // 폴더 경로에 한글 등이 있는 Windows 에서는 계측 자료를 임시 폴더에 쓰게 했다가 시험 뒤에 옮긴다(coverage.js 설명 참고).
  const gcovDir = cover ? coverage.redirect(root, env) : null;

  // 시험 실행. 대상 폴더에서 셸로 실행하고 표준 출력과 오류를 모두 기록한다.
  const started = new Date();
  const proc = await runShell(opts.testCmd, { cwd: root, env, timeoutMs: Math.round(opts.timeout * 1000) });
  const output = (proc.stdout || "") + (proc.stderr || "");
  if (gcovDir) { try { coverage.collect(root, gcovDir); } catch (_) { /* 옮기지 못하면 아래에서 '측정하지 못함'으로 보고된다 */ } }
  // 제한 시간을 넘겨 중단한 경우: 끝나지 않은 시험은 통과가 아니다.
  const timedOut = proc.timedOut === true;
  const exitCode = proc.error ? null : proc.status;
  const { results, conflicts } = parseTestOutput(output);

  const outDir = path.resolve(root, opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "test-output.log"), output);
  const resultsFile = path.join(outDir, "results.json");
  const record = {
    schema: trace.RESULTS_SCHEMA,
    run_id: process.env.GITHUB_RUN_ID ? `github-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || "1"}` : `local-${started.toISOString()}`,
    started_at: started.toISOString(),
    commit: commit || null,
    baseline_id: baseline.baseline_id,
    baseline_hash: baseline.baseline_hash,
    test_command: opts.testCmd,
    test_exit_code: exitCode,
    timed_out: timedOut,
    results,
  };
  record.result_fingerprint = resultFingerprint(record);
  // 설정에 따른 판정: 코딩 규칙, 시험 도출 방법 표기, 커버리지.
  const configProblems = [];
  const configNotes = [];
  if (loaded && loaded.invalid) configProblems.push(`project.json 이 올바르지 않음: ${loaded.errors.join("; ")}`);
  if (config) {
    record.config = Object.assign({ domain: config.domain, level: config.level }, config.asil !== undefined ? { asil: config.asil } : {}, { standard: config.standard, sha256: project.hash(config), compiler: comp.id, compiler_used: comp.used, cc: env.CC, cflags: env.CFLAGS });
    if (comp.problem) configProblems.push(`[ENV-CC] ${comp.problem}`);
    if (comp.note) configNotes.push(`[ENV-CC] ${comp.note}`);
    const rules = rulesCheck.check(root, config);
    record.rules = { errors: rules.findings.filter((f) => f.level === "error"), warnings: rules.findings.filter((f) => f.level === "warning"), checked: rules.checked, by_compiler: rules.by_compiler, not_checked: rules.not_checked, exemptions: rules.exemptions };
    for (const f of record.rules.errors) configProblems.push(`[${f.rule}] ${f.message} (${f.where})`);
    for (const f of record.rules.warnings) configNotes.push(`[${f.rule}] ${f.message} (${f.where})`);
    if (cover) {
      let m;
      try { m = proc.error ? { measured: false, reason: "시험 명령을 실행하지 못함" } : !comp.coverage ? { measured: false, reason: `${comp.chosen.label} 로 빌드한 계측 자료는 gcov 로 읽지 못함 — 커버리지는 gcc 계열 컴파일러를 골라야 잴 수 있음` } : coverage.measure(root, { env, gcov: (comp.used === "chosen" && comp.gcov) || tools.gcov || "gcov", mcdc }); } catch (e) { m = { measured: false, reason: e.message }; }
      // 사람이 정당화한 미달(test-spec/coverage-justifications.json)을 더한 유효 커버리지. 실측값은 그대로 둔다.
      if (m && m.measured) { try { m = justify.applyTo(root, m); } catch (_) { /* 정당화 기록을 읽지 못하면 실측만 쓴다 */ } }
      record.coverage = m;
      for (const id of ["statement", "branch"]) {
        const want = config.coverage[id];
        if (!project.on(want.level)) continue;
        const label = id === "statement" ? "구문 커버리지" : "분기 커버리지";
        const e = m.effective && m.effective[id] ? m.effective[id] : m[id];
        const add = m.justified ? m.justified[id] : 0;
        const how = add ? ` (실측 ${m[id].percent}% + 정당화 ${add}개)` : "";
        const msg = !m.measured ? `${label}를 측정하지 못함 — ${m.reason}` : e.percent < want.min ? `${label} ${e.percent}% (${e.covered}/${e.total})${how} — 기준 ${want.min}% 미달` : null;
        if (msg) (want.level === "required" ? configProblems : configNotes).push(`[V-${id === "statement" ? "STMT" : "BRANCH"}] ${msg}`);
      }
    }
    if (project.on(config.coverage.mcdc.level)) {
      const want = config.coverage.mcdc;
      const m = record.coverage;
      const msg = !mcdc ? `MC/DC 는 이 컴파일러(${comp ? `${comp.cc} ${comp.version || ""}`.trim() : "?"})로 측정할 수 없음(gcc 14 이상 필요) — 컴파일러를 바꾸거나 다른 수단의 증거가 필요`
        : !m || !m.measured || !m.mcdc ? `MC/DC 를 측정하지 못함 — ${m && m.reason ? m.reason : "gcov 결과에 조건 정보가 없음"}`
        : (() => { const e = m.effective && m.effective.mcdc ? m.effective.mcdc : m.mcdc; const add = m.justified ? m.justified.mcdc : 0; return e.percent < want.min ? `MC/DC ${e.percent}% (${e.covered}/${e.total})${add ? ` (실측 ${m.mcdc.percent}% + 정당화 ${add}개)` : ""} — 기준 ${want.min}% 미달` : null; })();
      if (msg) (want.level === "required" ? configProblems : configNotes).push(`[V-MCDC] ${msg}`);
    }
  }
  // 정적 분석(설정에서 켰을 때). 시험과 별개로 src/ 를 검사한다.
  if (config && project.on(config.static_analysis.level)) {
    let s;
    try { s = ((hooks && hooks.staticRun) || staticAnalysis.run)(root, config, { env }); } catch (e) { s = { ran: false, tool: "cppcheck", reason: e.message }; }
    record.static_analysis = Object.assign({ level: config.static_analysis.level }, s);
    const msg = staticAnalysis.verdict(s, config);
    if (msg) (config.static_analysis.level === "required" ? configProblems : configNotes).push(msg);
  }
  record.environment = describeEnvironment(root, env, Object.assign({}, tools, env.CC ? { cc: env.CC } : {}));
  // 검증에 쓴 도구 전부(컴파일러·빌드·커버리지·정적 분석·실행 환경·검증 도구)의 경로·버전·설정
  try {
    record.environment.tools = toolInventory(root, env, {
      cc: env.CC || tools.cc, make: tools.make, testCmd: opts.testCmd,
      compiler: config ? config.compiler : null, compilerUsed: comp ? comp.used : null,
      coverage: Boolean(record.coverage && record.coverage.measured), gcov: comp ? (comp.used === "chosen" && comp.gcov) || tools.gcov || "gcov" : tools.gcov || "gcov", mcdc,
      static: record.static_analysis || null,
    });
  } catch (_) { /* 목록을 만들지 못해도 검증 결과는 남긴다 */ }
  fs.writeFileSync(resultsFile, JSON.stringify(record, null, 2) + "\n");

  // 시험 명령 자체의 문제. 추적 점검과 별개로 게이트를 막는다.
  const problems = [];
  if (timedOut) problems.push(`시험 명령이 제한 시간 ${opts.timeout}초 안에 끝나지 않아 중단함 — 끝나지 않은 시험은 통과로 보지 않음`);
  else if (proc.error) problems.push(`시험 명령을 실행하지 못함: ${proc.error.message}`);
  else if (exitCode !== 0) {
    const failed = results.filter((r) => r.result === "fail").map((r) => r.tc_id);
    problems.push(failed.length
      ? `시험 명령이 실패로 끝남 (종료 코드 ${exitCode}) — 실패한 시험: ${failed.join(", ")}`
      : `시험 명령이 실패로 끝났지만 실패한 시험 줄이 없음 (종료 코드 ${exitCode}) — 빌드 오류나 비정상 종료일 수 있음. ${path.relative(root, path.join(outDir, "test-output.log"))} 확인`);
  } else if (results.some((r) => r.result === "fail")) problems.push("시험 명령은 성공으로 끝났지만 실패한 시험 줄이 있음 — 시험 실행기가 실패를 종료 코드로 알리지 않음");
  if (!proc.error && results.length === 0) problems.push('시험 출력에 "TC-ID pass|fail|skip" 형식의 줄이 하나도 없음');
  for (const id of conflicts) problems.push(`${id}: 같은 시험의 결과가 서로 다르게 두 번 출력됨`);
  const settingProblems = configProblems;

  const args = ["--root", root, "--results", resultsFile, "--require-results", "--out", opts.out];
  if (commit) args.push("--commit", commit);
  for (const key of ["baseline", "design", "code", "tests"]) if (opts[key]) args.push(`--${key}`, opts[key]);
  const checked = await trace.run(args);

  const lines = [`# 추적성 게이트: ${path.basename(root)}`, `시험 명령: ${opts.testCmd} (종료 코드 ${exitCode === null ? "없음" : exitCode}, 결과 줄 ${results.length}개)`, `시험한 커밋: ${commit || "알 수 없음"}`,
    `실행 환경: ${record.environment.pinned ? record.environment.image : "고정되지 않음"} (${record.environment.os}, node ${record.environment.node}, cc ${record.environment.cc || "없음"}, make ${record.environment.make || "없음"})`,
    `결과 지문: ${record.result_fingerprint}`];
  if (!record.environment.pinned) lines.push("[주의] 고정된 컨테이너 이미지에서 실행하지 않음 — 다른 환경에서도 같은 결과가 나온다는 근거로 쓸 수 없음");
  if (dirty.length) lines.push(`[주의] 대상 폴더에 커밋되지 않은 변경 ${dirty.length}개 — 이 결과는 커밋 ${commit ? commit.slice(0, 12) : "?"} 의 증거로 쓸 수 없음`);
  for (const p of problems) lines.push(`[오류 시험] ${p}`);
  if (config) {
    lines.push(`프로젝트 설정: ${project.levelText(config)} (${config.standard || project.DOMAINS[config.domain].label}) · 컴파일 옵션 ${env.CFLAGS}`);
    if (record.static_analysis && record.static_analysis.ran) lines.push(`정적 분석: ${record.static_analysis.tool} ${record.static_analysis.version || ""} · 지적 ${record.static_analysis.findings.length}건 (${record.static_analysis.fail_on} 이상 ${record.static_analysis.counted}건)`);
    if (record.coverage && record.coverage.measured) lines.push(`커버리지: 구문 ${record.coverage.statement.percent}% (${record.coverage.statement.covered}/${record.coverage.statement.total}) · 분기 ${record.coverage.branch.percent}% (${record.coverage.branch.covered}/${record.coverage.branch.total})${record.coverage.mcdc ? ` · MC/DC ${record.coverage.mcdc.percent}% (${record.coverage.mcdc.covered}/${record.coverage.mcdc.total})` : ""}`);
  }
  for (const p of settingProblems) lines.push(`[오류 설정] ${p}`);
  for (const n of configNotes) lines.push(`[경고 설정] ${n}`);
  lines.push("", checked.text, "");
  const code = problems.length || settingProblems.length || checked.code ? 1 : 0;
  lines.push(`게이트: ${code ? "실패" : "통과"} — 결과 폴더 ${path.relative(process.cwd(), outDir) || "."}`);
  // 판정과 막은 이유를 결과 파일에도 남긴다(검증 기록이 이 값을 쓴다). 추적 점검의 오류는 trace-matrix.json 에 있다.
  record.gate = { result: code ? "fail" : "pass", problems: [...problems, ...settingProblems], trace_errors: checked.report ? checked.report.result.errors.length : null };
  fs.writeFileSync(resultsFile, JSON.stringify(record, null, 2) + "\n");
  return { code, text: lines.join("\n"), problems: [...problems, ...settingProblems], dirty, resultsFile, report: checked.report, record };
}

module.exports = { run, parseTestOutput, runShell, describeEnvironment, resultFingerprint, canonical };

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (r) => { console.log(r.text); process.exitCode = r.code; },
    (e) => { console.error(e instanceof trace.UsageError ? e.message : e); process.exitCode = 2; }
  );
}
