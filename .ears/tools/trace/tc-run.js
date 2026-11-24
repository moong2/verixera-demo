/* TC 를 하나씩 골라 이 PC 에서 실행하고, 그 TC 하나가 코드의 어디를 탔는지(실행한 줄, 분기 갈래별 횟수)를 잰다.
 *
 * 약속: 시험 프로그램은 tests/ears_tc.h 의 ears_tc_selected("TC-…") 로 각 TC 를 감싼다.
 *   환경 변수 EARS_TC 에 TC ID 가 있으면 그 TC 만 실행하고, 비어 있으면 모두 실행한다(예전처럼).
 *   이 약속을 따르지 않는 시험 프로그램은 TC 하나만 실행할 수 없다 — 그때는 '하나만 실행하지 못함'으로 알리고 커버리지를 보이지 않는다
 *   (다른 TC 의 실행이 섞여, 그 TC 가 어디를 탔는지 알 수 없으므로).
 *
 * TC 마다: 계측 자료를 지우고 → EARS_TC=그 TC 로 시험 명령을 실행 → gcov 로 줄·분기 단위 결과를 읽는다.
 * 기록으로 남기지 않는다(확인용). 정식 검증은 '검증'의 이 PC 검증·CI 로 한다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const project = require("../project/config.js");
const coverage = require("../project/coverage.js");
const compilers = require("../project/compilers.js");
const toolchain = require("../project/toolchain.js");
const gate = require("./run-gate.js");
const decisions = require("./decisions.js");

const TC_RE = /^TC-[A-Za-z0-9_.-]{1,80}$/;
const MAX_IDS = 20; // 요청 하나에 실행하는 TC 수(요청이 너무 오래 걸리지 않게). 더 많으면 화면이 20개씩 나눠 보낸다.
const MAX_TOTAL = 1000; // 나눠 실행한 뒤 한 번에 합산할 수 있는 TC 수
const HEADER = "tests/ears_tc.h";
const HEADER_TEXT = `/* EARS Requirements Writer 가 넣는 도우미 — TC 하나씩 실행하기.
 * 환경 변수 EARS_TC 에 TC ID 를 쉼표로 적으면 그 TC 만 실행하고, 비어 있으면 모두 실행한다.
 * 시험 코드에서: if (ears_tc_selected("TC-OTP-01-1-001")) { ... 이 TC ... }
 * 단계마다 실제 출력: ears_actual_i(tc, 단계, "신호", 값) / ears_actual_f(...) — 앱이 읽어 절차표의 '실제 출력' 칸에 보인다(판정에는 쓰지 않음).
 * (도우미 v2)
 */
#ifndef EARS_TC_H
#define EARS_TC_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static inline int ears_tc_selected(const char *id)
{
    const char *want = getenv("EARS_TC");
    const char *p;
    size_t n;
    if ((want == NULL) || (want[0] == '\\0')) {
        return 1;
    }
    n = strlen(id);
    p = want;
    while ((p = strstr(p, id)) != NULL) {
        const int start_ok = (p == want) || (p[-1] == ',');
        const int end_ok = (p[n] == '\\0') || (p[n] == ',');
        if (start_ok && end_ok) {
            return 1;
        }
        p += n;
    }
    return 0;
}

/* 단계(1부터, 절차표 steps 의 순서)마다 시험 대상의 실제 출력값을 한 줄씩 찍는다. */
static inline void ears_actual_i(const char *tc, int step, const char *name, long long value)
{
    (void)printf("EARS_ACTUAL %s %d %s=%lld\\n", tc, step, name, value);
}

static inline void ears_actual_f(const char *tc, int step, const char *name, double value)
{
    (void)printf("EARS_ACTUAL %s %d %s=%.6g\\n", tc, step, name, value);
}

#endif
`;

class TcRunError extends Error { constructor(message, status) { super(message); this.status = status || 400; } }

// 도우미 머리 파일이 없으면 넣는다. 넣었으면 true.
function ensureHeader(root) {
  const f = path.join(root, ...HEADER.split("/"));
  if (fs.existsSync(f)) {
    // 앱이 넣은 예전 도우미면 새 판으로 바꾼다(사람이 만든 같은 이름 파일은 건드리지 않는다).
    const cur = fs.readFileSync(f, "utf8");
    if (cur === HEADER_TEXT || !cur.startsWith("/* EARS Requirements Writer 가 넣는 도우미")) return false;
    fs.writeFileSync(f, HEADER_TEXT);
    return true;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, HEADER_TEXT);
  return true;
}
// 시험 코드가 약속(ears_tc_selected)을 쓰는지
function supportsSelection(root) {
  const dir = path.join(root, "tests");
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).filter((x) => /\.c$/.test(x)).some((x) => /ears_tc_selected\s*\(/.test(fs.readFileSync(path.join(dir, x), "utf8")));
}

// 시험이 찍은 실제 출력값: "EARS_ACTUAL <TC> <단계> <신호>=<값>"
function actualOf(output, id) {
  const out = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const m = /^EARS_ACTUAL\s+(\S+)\s+(\d+)\s+([A-Za-z_][\w.]*)=(\S+)\s*$/.exec(line.trim());
    if (m && m[1] === id && out.length < 500) out.push({ step: Number(m[2]), name: m[3], value: m[4] });
  }
  return out;
}
const tail = (s, n) => (s.length > n ? "…" + s.slice(-n) : s);

// ── 약속을 따르지 않는 시험 코드: 실행할 때만 임시 복사본에서 TC 마다 감싼다(원본은 그대로) ──
// TC 범위(@testcase 주석부터 그 TC 의 끝 줄까지)를 보고 두 가지 모양을 처리한다.
//  - TC 가 함수 하나(static void tc_x(void) { ... }): 함수 첫머리에 '이 TC 가 아니면 바로 돌아감'을 넣는다.
//  - TC 가 main 안의 문장들: 그 문장들을 if (ears_tc_selected("TC-…")) { ... } 로 감싼다.
// 감싼 뒤 빌드가 안 되면 원본으로 실행한다(그때는 하나만 실행하지 못함).
const FUNC_RE = /^\s*(?:static\s+|inline\s+)*([A-Za-z_][\w\s\*]*?)\s*\b([A-Za-z_]\w*)\s*\(([^;]*)\)\s*(\{)?\s*$/;
function wrapFile(text, tcs) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const edits = []; // { at: 줄 번호(0부터), insert: [줄…], after: true|false }
  let wrapped = 0;
  for (const t of tcs) {
    let s = t.startLine - 1; const e = Math.min(t.endLine - 1, lines.length - 1);
    // 주석 블록을 건너뛴다
    let inBlock = false;
    while (s <= e) {
      const l = lines[s];
      if (inBlock) { if (/\*\//.test(l)) inBlock = false; s++; continue; }
      if (/^\s*$/.test(l) || /^\s*\/\//.test(l)) { s++; continue; }
      if (/^\s*\/\*/.test(l)) { if (!/\*\//.test(l.replace(/^\s*\/\*/, ""))) inBlock = true; s++; continue; }
      // 범위가 주석 가운데(* @testcase …)에서 시작하는 경우
      if (/^\s*\*/.test(l)) { if (!/\*\//.test(l)) inBlock = true; s++; continue; }
      break;
    }
    // 끝 줄: 범위 안의 마지막 '코드' 줄(주석·빈 줄 제외 — 범위가 다음 TC 의 주석 여는 줄까지 닿을 수 있음)
    let last = -1;
    let inC = false;
    for (let k = s; k <= e; k++) {
      let l = lines[k];
      let code = "";
      while (l.length) {
        if (inC) { const j = l.indexOf("*/"); if (j < 0) { l = ""; break; } inC = false; l = l.slice(j + 2); continue; }
        const j = l.indexOf("/*"); const d = l.indexOf("//");
        if (d >= 0 && (j < 0 || d < j)) { code += l.slice(0, d); l = ""; break; }
        if (j < 0) { code += l; l = ""; break; }
        code += l.slice(0, j); inC = true; l = l.slice(j + 2);
      }
      if (code.trim()) last = k;
    }
    if (last < s) continue;
    const id = JSON.stringify(t.id);
    const fm = FUNC_RE.exec(lines[s]);
    if (fm && !/^(if|for|while|switch|return|else)$/.test(fm[2]) && !/=/.test(lines[s])) {
      // 함수 정의: 여는 중괄호 줄 뒤에 넣는다.
      let brace = fm[4] ? s : s + 1;
      if (!fm[4] && !/^\s*\{\s*$/.test(lines[brace] || "")) continue;
      const type = fm[1].replace(/\b(static|inline|const)\b/g, "").trim();
      const indent = ((lines[brace + 1] || "").match(/^\s*/) || [""])[0] || "    ";
      const ret = type === "void" ? "return;" : "return 0;";
      edits.push({ at: brace, after: true, insert: [`${indent}if (!ears_tc_selected(${id})) { ${ret} }`] });
    } else {
      const indent = (lines[s].match(/^\s*/) || [""])[0];
      edits.push({ at: s, after: false, insert: [`${indent}if (ears_tc_selected(${id})) {`] });
      edits.push({ at: last, after: true, insert: [`${indent}}`] });
    }
    wrapped++;
  }
  if (!wrapped) return null;
  edits.sort((a, b) => b.at - a.at || (a.after === b.after ? 0 : a.after ? -1 : 1));
  for (const ed of edits) lines.splice(ed.after ? ed.at + 1 : ed.at, 0, ...ed.insert);
  // 머리 파일: 마지막 #include 뒤(없으면 맨 위)
  let inc = -1;
  lines.forEach((l, i) => { if (/^\s*#\s*include\b/.test(l)) inc = i; });
  lines.splice(inc + 1, 0, '#include "ears_tc.h"');
  return { text: lines.join(nl), wrapped };
}
// 임시 복사본을 만들고 시험 파일을 감싼다. 감싼 TC 가 없으면 null.
function wrappedCopy(root) {
  const os = require("node:os");
  const tcs = require("./testcases.js").table(root).testcases;
  const byFile = new Map();
  for (const t of tcs) if (t.file && t.startLine && t.endLine) { if (!byFile.has(t.file)) byFile.set(t.file, []); byFile.get(t.file).push(t); }
  if (!byFile.size) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ears-tcrun-"));
  const SKIP = new Set([".git", "node_modules", ".env"]);
  fs.cpSync(root, tmp, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) && !/\.(gcda|gcno|gcov)$/.test(src) });
  let total = 0;
  for (const [file, list] of byFile) {
    const f = path.join(tmp, ...file.split("/"));
    if (!fs.existsSync(f)) continue;
    const out = wrapFile(fs.readFileSync(f, "utf8"), list);
    if (!out) continue;
    fs.writeFileSync(f, out.text);
    const hdr = path.join(path.dirname(f), "ears_tc.h");
    if (!fs.existsSync(hdr)) fs.writeFileSync(hdr, HEADER_TEXT);
    total += out.wrapped;
  }
  if (!total) { fs.rmSync(tmp, { recursive: true, force: true }); return null; }
  return tmp;
}

// 파일마다 결정(참·거짓, 조건별 MC/DC)을 붙인다. 소스는 원본에서 읽는다(시험 파일만 감쌌으므로 src/ 는 같다).
function addDecisions(root, cov) {
  for (const f of (cov && cov.files) || []) {
    try { f.decisions = decisions.analyze(fs.readFileSync(path.join(root, ...f.file.split("/")), "utf8"), f); } catch (_) { f.decisions = []; }
  }
}
const pct = (covered, total) => (total ? Math.floor((covered / total) * 1000) / 10 : 100);
// 여러 TC 의 결과를 합친다: 줄·분기 갈래 횟수는 더하고, 조건 값은 어느 TC 에서든 결정을 좌우했으면 확인된 것으로 본다.
function combine(root, runs) {
  const files = new Map();
  for (const r of runs) {
    for (const f of r.coverage.files || []) {
      if (!files.has(f.file)) files.set(f.file, { lines: new Map(), br: new Map(), cond: new Map(), by: new Map() });
      const a = files.get(f.file);
      for (const x of f.lines || []) a.lines.set(x.line, (a.lines.get(x.line) || 0) + x.count);
      for (const b of f.branch_detail || []) {
        const cur = a.br.get(b.line) || b.outcomes.map((o) => ({ count: 0, fallthrough: o.fallthrough }));
        b.outcomes.forEach((o, i) => { if (cur[i]) cur[i].count += o.count; });
        a.br.set(b.line, cur);
      }
      for (const c of f.condition_detail || []) {
        const k = c.line + ":" + c.index;
        const prev = a.cond.get(k);
        a.cond.set(k, prev ? { line: c.line, index: c.index, conditions: c.conditions, missing: prev.missing.filter((m) => c.missing.includes(m)) } : Object.assign({}, c));
      }
      // 어느 TC 가 조건의 참·거짓을 결정을 좌우하는 값으로 냈는지(MC/DC 를 무엇으로 충족했는지)
      for (const d of f.decisions || []) for (const c of d.conditions || []) {
        const k = d.line + ":" + c.index;
        const cur = a.by.get(k) || { t: [], f: [] };
        if (c.t) cur.t.push(r.id);
        if (c.f) cur.f.push(r.id);
        a.by.set(k, cur);
      }
    }
  }
  const sum = { statement: [0, 0], branch: [0, 0], mcdc: [0, 0] };
  const out = [...files].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([file, a]) => {
    const lines = [...a.lines].sort((x, y) => x[0] - y[0]).map(([line, count]) => ({ line, count }));
    const branch_detail = [...a.br].sort((x, y) => x[0] - y[0]).map(([line, outcomes]) => ({ line, outcomes }));
    const condition_detail = [...a.cond.values()].sort((x, y) => x.line - y.line || x.index - y.index);
    const st = [lines.filter((x) => x.count > 0).length, lines.length];
    const outs = branch_detail.flatMap((b) => b.outcomes);
    const br = [outs.filter((o) => o.count > 0).length, outs.length];
    const ct = condition_detail.reduce((n, c) => n + c.conditions * 2, 0);
    const mc = [ct - condition_detail.reduce((n, c) => n + c.missing.length, 0), ct];
    sum.statement[0] += st[0]; sum.statement[1] += st[1]; sum.branch[0] += br[0]; sum.branch[1] += br[1]; sum.mcdc[0] += mc[0]; sum.mcdc[1] += mc[1];
    const one = { file, statement: { covered: st[0], total: st[1], percent: pct(st[0], st[1]) }, branch: { covered: br[0], total: br[1], percent: pct(br[0], br[1]) }, mcdc: { covered: mc[0], total: mc[1], percent: pct(mc[0], mc[1]) }, has_conditions: ct > 0, lines, branch_detail, condition_detail };
    addDecisions(root, { files: [one] });
    for (const d of one.decisions || []) for (const c of d.conditions || []) { const by = a.by.get(d.line + ":" + c.index); if (by) { c.t_by = by.t; c.f_by = by.f; } }
    return one;
  });
  const mk = ([c, t]) => ({ covered: c, total: t, percent: pct(c, t) });
  return Object.assign({ measured: true, ids: runs.map((r) => r.id), statement: mk(sum.statement), branch: mk(sum.branch), files: out }, sum.mcdc[1] ? { mcdc: mk(sum.mcdc) } : {});
}

// ── TC 실행 결과 보관(디버깅용, 공식 검증 기록 아님) ──
// 대상 프로젝트 trace-out/tc-runs.json (trace-out 은 Git 에 올리지 않는다)
//  - runs: TC 마다 마지막 결과(상세), combined: 마지막 합산
//  - history: TC 마다 지난 실행 기록(최근 HISTORY_MAX 번) — 결과·커버리지 %·탄 줄·결정의 T/F·그때 코드의 지문. 이전 실행과 비교용
//  - batches: 실행 묶음 기록(최근 BATCH_MAX 번) — 고른 TC·통과 수·합산 커버리지
// 저장할 때의 소스 해시를 함께 두어, 나중에 코드가 바뀌었으면 '코드가 바뀐 뒤의 결과 아님'으로 알린다.
const RUNS_FILE = "trace-out/tc-runs.json";
const RUNS_SCHEMA = "tc-runs/v1";
const HISTORY_MAX = 30;
const BATCH_MAX = 50;
const RELEVANT = (k) => /^(src|tests)\//.test(k) || k === "Makefile" || k === "project.json";
function sourcesNow(root) { try { return require("../ci/verlog.js").sourceHashes(root); } catch (_) { return null; } }
// 결과에 영향을 주는 파일들의 지문(짧은 해시). 같으면 같은 코드로 실행한 것이다.
function fingerprint(sources) {
  if (!sources) return null;
  const { createHash } = require("node:crypto");
  const keys = Object.keys(sources).filter(RELEVANT).sort();
  return createHash("sha256").update(keys.map((k) => `${k}=${sources[k]}`).join("\n")).digest("hex").slice(0, 12);
}
const pctOf = (x) => (x && x.total ? x.percent : null);
// 이력 한 줄: 비교에 필요한 것만(탄 줄 번호, 결정의 T/F 횟수)
function historyEntry(r, at, fp) {
  const c = r.coverage || {};
  return {
    ran_at: at, result: r.result, isolated: Boolean(r.isolated), fp, actual: (r.actual || []).slice(0, 200),
    statement: pctOf(c.statement), branch: pctOf(c.branch), mcdc: pctOf(c.mcdc),
    files: c.measured ? (c.files || []).map((f) => ({ file: f.file, ran: (f.lines || []).filter((x) => x.count > 0).map((x) => x.line), dec: (f.decisions || []).map((d) => [d.line, d.t, d.f]) })) : [],
  };
}
function loadRuns(root) {
  const f = path.join(root, ...RUNS_FILE.split("/"));
  let data = null;
  try { data = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { data = null; }
  if (!data || data.schema !== RUNS_SCHEMA) return { schema: RUNS_SCHEMA, runs: {}, combined: null, history: {}, batches: [], fp: null };
  // 보관 파일은 디버깅용 임시 자료다. 모양이 틀린 부분은 버리고 읽는다(깨졌다고 TC 화면 전체가 실패하지 않게).
  const isObj = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);
  data.runs = isObj(data.runs) ? Object.fromEntries(Object.entries(data.runs).filter(([, r]) => isObj(r))) : {};
  data.combined = isObj(data.combined) ? data.combined : null;
  data.history = isObj(data.history) ? Object.fromEntries(Object.entries(data.history).map(([k, v]) => [k, Array.isArray(v) ? v.filter(isObj) : []])) : {};
  data.batches = Array.isArray(data.batches) ? data.batches.filter(isObj) : [];
  const current = sourcesNow(root);
  const fpNow = fingerprint(current);
  const stale = (sources) => {
    if (!current || !sources) return null;
    const keys = new Set([...Object.keys(sources), ...Object.keys(current)].filter(RELEVANT));
    return [...keys].some((k) => sources[k] !== current[k]);
  };
  for (const r of Object.values(data.runs || {})) r.stale = stale(r.sources);
  if (data.combined) data.combined.stale = stale(data.combined.sources);
  // 소스 해시는 화면에 보낼 필요가 없다(지문만).
  for (const r of Object.values(data.runs || {})) delete r.sources;
  if (data.combined) delete data.combined.sources;
  data.history = data.history || {};
  data.batches = data.batches || [];
  data.fp = fpNow;
  return data;
}
// opts.batch === false: 나눠 실행하는 묶음의 한 조각 — 합산·묶음 기록은 남기지 않는다(끝난 뒤 combineSaved 가 한 번에 남김).
function saveRuns(root, out, opts) {
  const piece = Boolean(opts && opts.batch === false);
  const f = path.join(root, ...RUNS_FILE.split("/"));
  let data = null;
  try { data = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { data = null; }
  if (!data || data.schema !== RUNS_SCHEMA) data = { schema: RUNS_SCHEMA, note: "TC 하나씩 실행 결과 — 디버깅용이며 공식 검증 기록이 아니다", runs: {}, combined: null };
  data.history = data.history || {};
  data.batches = data.batches || [];
  const sources = sourcesNow(root);
  const fp = fingerprint(sources);
  const at = new Date().toISOString();
  for (const r of out.results || []) {
    data.runs[r.id] = Object.assign({}, r, { ran_at: at, sources, fp });
    data.history[r.id] = (data.history[r.id] || []).concat([historyEntry(r, at, fp)]).slice(-HISTORY_MAX);
  }
  if (piece) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data) + "\n"); return at; }
  if (out.combined) data.combined = Object.assign({}, out.combined, { ran_at: at, sources, fp });
  const res = out.results || [];
  const cb = out.combined;
  data.batches = data.batches.concat([{ ran_at: at, fp, ids: res.map((r) => r.id), pass: res.filter((r) => r.result === "pass").length, fail: res.filter((r) => r.result === "fail").length, none: res.filter((r) => r.result !== "pass" && r.result !== "fail").length,
    statement: cb ? pctOf(cb.statement) : null, branch: cb ? pctOf(cb.branch) : null, mcdc: cb ? pctOf(cb.mcdc) : null }]).slice(-BATCH_MAX);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data) + "\n");
  return at;
}

// 20개씩 나눠 실행한 TC 들의 합산: 보관된 마지막 결과 중 지금 코드(지문)로 실행한 것만 합치고, 묶음 기록을 하나 남긴다.
function combineSaved(root, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!list.length) throw new TcRunError("합산할 TC 가 없습니다.");
  if (list.length > MAX_TOTAL) throw new TcRunError(`한 번에 ${MAX_TOTAL}개까지 합산할 수 있습니다.`);
  for (const id of list) if (!TC_RE.test(id)) throw new TcRunError(`TC ID 가 올바르지 않습니다: ${id}`);
  const f = path.join(root, ...RUNS_FILE.split("/"));
  let data = null;
  try { data = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { data = null; }
  if (!data || data.schema !== RUNS_SCHEMA) throw new TcRunError("보관된 실행 결과가 없습니다. 먼저 실행하세요.", 409);
  data.history = data.history || {};
  data.batches = data.batches || [];
  const sources = sourcesNow(root);
  const fp = fingerprint(sources);
  const res = list.map((id) => data.runs[id]).filter((r) => r && r.fp === fp);
  const ok = res.filter((r) => r.isolated && r.coverage && r.coverage.measured);
  const combined = ok.length > 1 ? combine(root, ok) : null;
  const at = new Date().toISOString();
  if (combined) data.combined = Object.assign({}, combined, { ran_at: at, sources, fp });
  data.batches = data.batches.concat([{ ran_at: at, fp, ids: res.map((r) => r.id), pass: res.filter((r) => r.result === "pass").length, fail: res.filter((r) => r.result === "fail").length, none: res.filter((r) => r.result !== "pass" && r.result !== "fail").length,
    statement: combined ? pctOf(combined.statement) : null, branch: combined ? pctOf(combined.branch) : null, mcdc: combined ? pctOf(combined.mcdc) : null, split: true }]).slice(-BATCH_MAX);
  fs.writeFileSync(f, JSON.stringify(data) + "\n");
  return { ran_at: at, combined, counted: res.length, missing: list.filter((id) => !res.some((r) => r.id === id)) };
}

// 시험 코드(tests/ 의 .c·.h)에 없는 TC ID. 빌드해 봐야 결과 줄이 나오지 않으므로 빌드 전에 가려낸다.
// ID 가 글자 그대로 있거나, 번호를 찍어 만드는 시험(예: "TC-A-%03d")이면 있는 것으로 본다. 시험 폴더를 읽지 못하면 가리지 않는다(null).
function unknownTcs(root, ids) {
  let text = "";
  try {
    const dir = path.join(root, "tests");
    if (!fs.existsSync(dir)) return ids.slice();
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { if (depth < 3 && !/^(\.|build$)/.test(e.name)) walk(path.join(d, e.name), depth + 1); }
        else if (/\.(c|h)$/i.test(e.name)) text += fs.readFileSync(path.join(d, e.name), "utf8") + "\n";
      }
    };
    walk(dir, 0);
  } catch (_) { return null; }
  return ids.filter((id) => {
    if (text.includes(id)) return false;
    const stem = id.replace(/[0-9]+$/, "");
    return !(stem !== id && stem.length > 3 && text.includes(`${stem}%`));
  });
}

async function runTcs({ root, ids, timeoutSec, hooks }) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!list.length) throw new TcRunError("실행할 TC 를 고르세요.");
  if (list.length > MAX_IDS) throw new TcRunError(`한 번에 ${MAX_IDS}개까지 실행할 수 있습니다.`);
  for (const id of list) if (!TC_RE.test(id)) throw new TcRunError(`TC ID 가 올바르지 않습니다: ${id}`);
  const unknown = unknownTcs(root, list);
  if (unknown && unknown.length) throw new TcRunError(`시험 코드(tests/)에 없는 TC 입니다: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ` 외 ${unknown.length - 5}개` : ""}. 시험 에이전트로 시험을 만든 뒤 실행하거나, TC 표를 새로 고쳐 다시 고르세요.`, 404);
  const loaded = project.load(root);
  const config = loaded && !loaded.invalid ? loaded.config : null;
  const tools = (hooks && hooks.tools) || toolchain.detect();
  const env = tools.env ? tools.env(process.env) : Object.assign({}, process.env);
  const testCmd = (hooks && hooks.testCmd) || (tools.make && tools.make !== "make" ? `${tools.make} -s test` : "make -s test");
  const comp = config ? compilers.resolve(config, tools, env, { pinned: false, probe: hooks && hooks.compilerProbe }) : null;
  // 어디를 탔는지 보려면 계측 빌드가 필요하다: 최적화 없이(-O0, 소스 줄과 갈래가 그대로 남게) --coverage 로 빌드한다.
  const mcdc = Boolean(config && comp && comp.mcdc);
  if (config) { env.CFLAGS = [...project.cflags(config, { mcdc: false }), "-O0", "--coverage", ...(mcdc ? ["-fcondition-coverage"] : [])].join(" "); if (comp && comp.cc) env.CC = comp.cc; }
  const gcov = (comp && comp.used === "chosen" && comp.gcov) || tools.gcov || "gcov";
  const native = supportsSelection(root);
  // 약속을 따르지 않으면 임시 복사본에서 TC 마다 감싸 실행한다(원본 파일은 바꾸지 않는다).
  let copy = null;
  if (!native && !(hooks && hooks.noAutoWrap)) { try { copy = wrappedCopy(root); } catch (_) { copy = null; } }
  const run = (hooks && hooks.runShell) || gate.runShell;
  const once = async (dirRoot, id) => {
    try { coverage.clean(dirRoot); } catch (_) { /* 지울 것이 없음 */ }
    const runEnv = Object.assign({}, env, { EARS_TC: id });
    const dir = coverage.redirect(dirRoot, runEnv);
    const proc = await run(testCmd, { cwd: dirRoot, env: runEnv, timeoutMs: Math.round((timeoutSec || 120) * 1000) });
    if (dir) { try { coverage.collect(dirRoot, dir); } catch (_) { /* 아래에서 측정하지 못함으로 */ } }
    const output = (proc.stdout || "") + (proc.stderr || "");
    const parsed = gate.parseTestOutput(output).results;
    return { proc, runEnv, output, mine: parsed.find((x) => x.tc_id === id) || null, others: parsed.filter((x) => x.tc_id !== id) };
  };
  const results = [];
  let wrapFailed = false;
  try {
    for (const id of list) {
      let where = copy && !wrapFailed ? copy : root;
      let r = await once(where, id);
      // 감싼 복사본이 빌드되지 않으면(결과 줄이 하나도 없음) 원본으로 다시 실행한다.
      if (where === copy && !r.mine && !r.others.length && !r.proc.timedOut) { wrapFailed = true; where = root; r = await once(root, id); }
      const { proc, runEnv, output, mine, others } = r;
      const isolated = Boolean(mine) && !others.length;
      let cov;
      if (!mine) cov = { measured: false, reason: proc.timedOut ? "제한 시간을 넘겨 멈췄습니다" : "이 TC 의 결과 줄(TC-ID pass/fail)이 출력에 없습니다 — 빌드 실패이거나 시험 코드에 없는 TC 입니다" };
      else if (!isolated) cov = { measured: false, reason: `이 시험 프로그램은 TC 하나만 실행하지 못해 다른 TC ${others.length}개도 함께 실행됐습니다${wrapFailed ? "(실행할 때 TC 마다 자동으로 감싸 보았지만 빌드되지 않았습니다)" : ""}. 그 TC 만의 실행 경로를 알 수 없어 보이지 않습니다 — 시험 에이전트로 시험을 다시 만들면 TC 하나씩 실행할 수 있습니다(tests/ears_tc.h).` };
      else { try { cov = coverage.measure(where, { env: runEnv, gcov, mcdc, detail: true, spawn: hooks && hooks.spawn }); addDecisions(root, cov); } catch (e) { cov = { measured: false, reason: e.message }; } }
      results.push({ id, actual: actualOf(output, id), result: mine ? mine.result : "none", exit_code: proc.error ? null : proc.status, timed_out: Boolean(proc.timedOut), isolated, auto_wrapped: where === copy, other_tcs: others.map((x) => x.tc_id).slice(0, 50), output: tail(output, 6000), coverage: cov });
    }
  } finally {
    if (copy) { try { fs.rmSync(copy, { recursive: true, force: true }); } catch (_) { /* 임시 폴더 */ } }
    try { coverage.clean(root); } catch (_) { /* 그대로 */ }
  }
  // 여러 TC 를 골라 돌렸으면 그 TC 들을 합친 커버리지(줄·분기 횟수 합, 조건은 어느 TC 에서든 확인되면 확인)
  const ok = results.filter((r) => r.isolated && r.coverage && r.coverage.measured);
  const combined = ok.length > 1 ? combine(root, ok) : null;
  return { selectable: native || results.some((r) => r.auto_wrapped && r.isolated), auto_wrapped: Boolean(copy) && !wrapFailed, mcdc, test_command: testCmd, cflags: env.CFLAGS || null, results, combined };
}

module.exports = { TcRunError, MAX_IDS, combineSaved, runTcs, unknownTcs, actualOf, loadRuns, saveRuns, fingerprint, RUNS_FILE, HISTORY_MAX, ensureHeader, supportsSelection, wrapFile, combine, HEADER, HEADER_TEXT, TC_RE };
