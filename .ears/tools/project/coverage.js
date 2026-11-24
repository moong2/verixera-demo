/* 구조적 커버리지 측정(구문·분기). gcc 의 --coverage 로 빌드해 시험을 돌린 뒤 gcov 의 JSON 출력을 읽는다.
 *
 * 대상은 구현 코드(src/)뿐이다. 시험 코드 자체의 커버리지는 세지 않는다.
 * MC/DC 는 이 환경의 컴파일러(gcc 12)로는 잴 수 없어 측정하지 않는다(gcc 14 의 -fcondition-coverage 가 필요).
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SKIP = new Set(["trace-out", ".git", "node_modules"]);

function findFiles(root, ext, rel) {
  const out = [];
  const dir = path.join(root, rel || "");
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { if (!SKIP.has(d.name)) out.push(...findFiles(root, ext, r)); }
    else if (d.name.endsWith(ext)) out.push(r);
  }
  return out.sort();
}

// 이전 실행의 계측 자료가 섞이지 않게 지운다.
function clean(root) {
  for (const f of findFiles(root, ".gcda")) fs.rmSync(path.join(root, ...f.split("/")), { force: true });
}

// Windows 에서 폴더 경로에 영문이 아닌 글자(한글 등)가 있으면, 계측된 시험 프로그램이 계측 자료(.gcda)를 그 경로에 쓰지 못한다
// ("profiling: … Cannot create directory"). 그러면 같은 프로젝트가 이 PC 에서는 '측정하지 못함', 다른 환경에서는 '측정됨'으로 갈린다.
// 이를 피하려고 계측 자료를 영문 경로의 임시 폴더에 쓰게 한 뒤(GCOV_PREFIX), 시험이 끝나면 제자리(.gcno 옆)로 옮긴다.
const ASCII = /^[\x20-\x7e]*$/;
const needsRedirect = (root, platform) => (platform || process.platform) === "win32" && !ASCII.test(path.resolve(root));

// env 에 계측 자료를 쓸 임시 폴더를 지정한다. 돌려준 폴더를 시험이 끝난 뒤 collect 에 넘긴다. 임시 폴더도 영문 경로가 아니면 null.
function redirect(root, env, platform) {
  if (!needsRedirect(root, platform)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcov-"));
  if (!ASCII.test(dir)) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  env.GCOV_PREFIX = dir;
  env.GCOV_PREFIX_STRIP = "99"; // 원래 경로의 폴더를 모두 떼고 파일 이름만 남긴다
  return dir;
}

// 임시 폴더에 쓰인 계측 자료를 같은 이름의 .gcno 옆으로 옮기고 임시 폴더를 지운다. 옮긴 파일 수를 돌려준다.
function collect(root, dir) {
  if (!dir) return 0;
  let moved = 0;
  try {
    const notes = findFiles(root, ".gcno");
    for (const rel of findFiles(dir, ".gcda")) {
      const base = path.basename(rel, ".gcda");
      const same = notes.filter((n) => path.basename(n, ".gcno") === base);
      if (same.length !== 1) continue; // 이름이 겹치면 어느 것인지 알 수 없어 옮기지 않는다
      fs.copyFileSync(path.join(dir, ...rel.split("/")), path.join(root, ...same[0].replace(/\.gcno$/, ".gcda").split("/")));
      moved++;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return moved;
}

// gcov --json-format --stdout 의 출력: 자료 파일마다 JSON 문서 하나.
function parseGcov(text) {
  const docs = [];
  const t = String(text || "").trim();
  if (!t) return docs;
  try { const one = JSON.parse(t); return Array.isArray(one) ? one : [one]; } catch (_) { /* 여러 문서가 줄마다 있는 경우 */ }
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try { docs.push(JSON.parse(s)); } catch (_) { /* JSON 이 아닌 줄은 건너뛴다 */ }
  }
  return docs;
}

// 여러 자료 파일의 결과를 소스 파일·줄 단위로 합친다(같은 줄은 실행 횟수를 더한다).
// detail: 줄마다 실행 횟수와 분기 갈래별 횟수(이어서 들어가는 갈래인지 fallthrough)를 함께 낸다(TC 하나씩 실행해 어디를 탔는지 볼 때)
function summarize(docs, root, only, opts) {
  const files = new Map(); // 경로 → { lines: Map(줄 → 횟수), branches: Map("줄:번호" → 횟수) }
  for (const doc of docs) {
    const cwd = doc.current_working_directory || root;
    for (const f of doc.files || []) {
      const abs = path.isAbsolute(f.file) ? f.file : path.resolve(cwd, f.file);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel.startsWith("..") || !only.test(rel)) continue;
      if (!files.has(rel)) files.set(rel, { lines: new Map(), branches: new Map(), conditions: new Map(), functions: new Map(), fall: new Map() });
      const acc = files.get(rel);
      // 함수 범위(시작·끝 줄). 함수별 커버리지를 이 범위 안의 줄·분기로 센다.
      for (const fn of f.functions || []) {
        const name = fn.demangled_name || fn.name;
        if (!name || acc.functions.has(name)) continue;
        acc.functions.set(name, { name, start: fn.start_line, end: fn.end_line });
      }
      for (const l of f.lines || []) {
        acc.lines.set(l.line_number, (acc.lines.get(l.line_number) || 0) + (l.count || 0));
        (l.branches || []).forEach((b, i) => { const k = `${l.line_number}:${i}`; acc.branches.set(k, (acc.branches.get(k) || 0) + (b.count || 0)); if (b.fallthrough !== undefined) acc.fall.set(k, Boolean(b.fallthrough)); });
        // 조건 커버리지(-fcondition-coverage): 결정마다 조건 결과 수(count)와 독립적으로 영향을 준 것으로 확인된 수(covered).
        // 여러 시험 프로그램의 결과는 '확인되지 않은 결과'의 교집합으로 합친다.
        (l.conditions || []).forEach((c, i) => {
          const k = `${l.line_number}:${i}`;
          const miss = new Set([...(c.not_covered_true || []).map((n) => `t${n}`), ...(c.not_covered_false || []).map((n) => `f${n}`)]);
          const prev = acc.conditions.get(k);
          acc.conditions.set(k, prev ? { total: Math.max(prev.total, c.count || 0), miss: new Set([...prev.miss].filter((x) => miss.has(x))) } : { total: c.count || 0, miss });
        });
      }
    }
  }
  const pct = (covered, total) => (total ? Math.floor((covered / total) * 1000) / 10 : 100);
  const perFile = [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([file, acc]) => {
    const lt = acc.lines.size; const lc = [...acc.lines.values()].filter((n) => n > 0).length;
    const bt = acc.branches.size; const bc = [...acc.branches.values()].filter((n) => n > 0).length;
    const ct = [...acc.conditions.values()].reduce((n, c) => n + c.total, 0); const cm = [...acc.conditions.values()].reduce((n, c) => n + Math.min(c.total, c.miss.size), 0);
    // 어디가 미달인지: 한 번도 실행되지 않은 줄, 가지 않은 분기가 있는 줄, 독립 영향이 확인되지 않은 조건이 있는 줄
    const byLine = (m, keyFn) => { const out = new Map(); for (const [k, v] of m) { const line = Number(String(k).split(":")[0]); const cur = out.get(line) || { line, missed: 0, total: 0 }; keyFn(cur, v); out.set(line, cur); } return [...out.values()].filter((x) => x.missed > 0).sort((a, b) => a.line - b.line); };
    const uncoveredBranches = byLine(acc.branches, (cur, n) => { cur.total++; if (n === 0) cur.missed++; });
    const uncoveredConditions = byLine(acc.conditions, (cur, c) => { cur.total += c.total; cur.missed += Math.min(c.total, c.miss.size); });
    const inRange = (fn, line) => line >= fn.start && line <= (fn.end || fn.start);
    const functions = [...acc.functions.values()].filter((fn) => fn.start).sort((a, b) => a.start - b.start).map((fn) => {
      const ls = [...acc.lines].filter(([n]) => inRange(fn, n));
      const bs = [...acc.branches].filter(([k]) => inRange(fn, Number(k.split(":")[0])));
      const cs = [...acc.conditions].filter(([k]) => inRange(fn, Number(k.split(":")[0])));
      const c1 = ls.filter(([, n]) => n > 0).length; const c2 = bs.filter(([, n]) => n > 0).length;
      const ctot = cs.reduce((n, [, c]) => n + c.total, 0); const cmiss = cs.reduce((n, [, c]) => n + Math.min(c.total, c.miss.size), 0);
      return Object.assign({ name: fn.name, start: fn.start, end: fn.end, statement: { covered: c1, total: ls.length, percent: pct(c1, ls.length) }, branch: { covered: c2, total: bs.length, percent: pct(c2, bs.length) } }, ctot ? { mcdc: { covered: ctot - cmiss, total: ctot, percent: pct(ctot - cmiss, ctot) } } : {});
    });
    return {
      file, statement: { covered: lc, total: lt, percent: pct(lc, lt) }, branch: { covered: bc, total: bt, percent: pct(bc, bt) }, mcdc: { covered: ct - cm, total: ct, percent: pct(ct - cm, ct) }, has_conditions: acc.conditions.size > 0,
      uncovered_lines: [...acc.lines].filter(([, n]) => n === 0).map(([n]) => n).sort((a, b) => a - b),
      uncovered_branches: uncoveredBranches,
      uncovered_conditions: uncoveredConditions,
      functions,
      ...(opts && opts.detail ? {
        lines: [...acc.lines].sort((a, b) => a[0] - b[0]).map(([line, count]) => ({ line, count })),
        branch_detail: (() => { const by = new Map(); for (const [k, count] of acc.branches) { const [line, i] = k.split(":").map(Number); if (!by.has(line)) by.set(line, []); by.get(line)[i] = { count, fallthrough: acc.fall.has(k) ? acc.fall.get(k) : null }; } return [...by].sort((a, b) => a[0] - b[0]).map(([line, outcomes]) => ({ line, outcomes: outcomes.filter(Boolean) })); })(),
        // 결정마다 조건 수와, 결정을 좌우한 것으로 확인되지 않은 조건 값(t0 = 0번 조건의 참, f1 = 1번 조건의 거짓 …)
        condition_detail: [...acc.conditions].map(([k, c]) => { const [line, i] = k.split(":").map(Number); return { line, index: i, conditions: Math.floor(c.total / 2), missing: [...c.miss].sort() }; }).sort((a, b) => a.line - b.line || a.index - b.index),
      } : {}),
    };
  });
  const sum = (k) => perFile.reduce((s, f) => ({ covered: s.covered + f[k].covered, total: s.total + f[k].total }), { covered: 0, total: 0 });
  const st = sum("statement"); const br = sum("branch"); const mc = sum("mcdc");
  const out = { statement: Object.assign(st, { percent: pct(st.covered, st.total) }), branch: Object.assign(br, { percent: pct(br.covered, br.total) }), files: perFile };
  // 조건 정보는 -fcondition-coverage 로 빌드했을 때만 있다.
  // 조건 정보가 실제로 있을 때만(조건 0개를 100% 로 보이지 않게).
  if (mc.total > 0) out.mcdc = Object.assign(mc, { percent: pct(mc.covered, mc.total) });
  return out;
}

// 시험을 실행한 뒤 부른다. 결과: { measured: true, statement, branch, files } 또는 { measured: false, reason }.
function measure(root, options) {
  const gcov = (options && options.gcov) || "gcov";
  const env = (options && options.env) || process.env;
  const data = findFiles(root, ".gcda");
  if (!data.length) return { measured: false, reason: "계측 자료(.gcda)가 없음 — Makefile 이 CFLAGS 를 컴파일·링크에 쓰지 않거나 시험이 실행되지 않음" };
  // --conditions(MC/DC)는 gcc 14 이상의 gcov 에만 있다. 옛 gcov 에 주면 옵션 오류로 구문·분기 측정까지 실패하므로,
  // MC/DC 를 재는 빌드일 때만 주고(options.mcdc), 그래도 gcov 가 모르는 옵션이라고 하면 빼고 다시 실행한다.
  const run = (options && options.spawn) || spawnSync;
  const exec = (withConditions) => run(gcov, ["--json-format", "--stdout", "--branch-probabilities", ...(withConditions ? ["--conditions"] : []), ...data], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
  const wantConditions = !options || options.mcdc !== false;
  let proc = exec(wantConditions);
  if (wantConditions && !proc.error && proc.status !== 0 && /unrecognized option|unknown option|invalid option/i.test(String(proc.stderr || ""))) proc = exec(false);
  if (proc.error || proc.status !== 0) return { measured: false, reason: `gcov 실행 실패: ${proc.error ? proc.error.message : String(proc.stderr || "").split(/\r?\n/)[0]}` };
  const docs = parseGcov(proc.stdout);
  if (!docs.length) return { measured: false, reason: "gcov 출력을 읽을 수 없음" };
  const s = summarize(docs, root, /^src\/.+\.c$/, { detail: Boolean(options && options.detail) });
  if (!s.files.length) return { measured: false, reason: "gcov 결과에 src/ 의 소스가 없음" };
  return Object.assign({ measured: true, tool: (docs[0].gcc_version && `gcov (gcc ${docs[0].gcc_version})`) || "gcov" }, s);
}

module.exports = { measure, clean, parseGcov, summarize, needsRedirect, redirect, collect };
