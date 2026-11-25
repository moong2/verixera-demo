#!/usr/bin/env node
/* 요구사항–설계–코드–시험–결과 추적 점검기.
 *
 * 승인 Baseline과 산출물 안의 추적 태그를 읽어 추적표를 만들고, 링크 누락·끊어진 링크·
 * 낡은 버전·형상 불일치를 찾는다. 파일을 수정하지 않는다(--out 으로 지정한 추적표만 쓴다).
 * 태그 규칙은 같은 폴더의 TAG_RULES.md 를 본다. 외부 의존성 없음(Node 18 이상).
 *
 * 사용법:
 *   node tools/trace/trace-check.js --root <대상 프로젝트> [옵션]
 * 종료 코드: 0 오류 없음, 1 추적성 오류, 2 실행 조건 오류.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const baselineApi = require("../../webapp/baseline.js");
const notVerified = require("./not-verified.js");

const TAGS = ["design", "satisfies", "implements", "testcase", "verifies", "trace-exempt", "oracle-unresolved", "signal"];
// 뒤에 오는 글 전체를 사유 하나로 읽는 태그.
const REASON_TAGS = new Set(["trace-exempt", "oracle-unresolved"]);
// 태그 뒤에는 빈칸·콜론·줄 끝만 온다. "신호 선언(@signal)은" · "`@signal`" 처럼 문장 속에서 태그 이름을 말한 것은 태그가 아니다.
const TAG_RE = new RegExp("@(" + TAGS.join("|") + ")(?=[ \\t:]|$)[ \\t]*:?[ \\t]*([^\\r\\n]*)", "g");
const C_EXT = new Set([".c", ".h"]);
const C_TYPE_WORDS = new Set([
  "void", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "bool", "_Bool",
  "const", "volatile", "static", "extern", "inline", "register", "restrict", "struct", "union", "enum",
  "sizeof", "typeof", "_Alignas", "_Noreturn", "_Static_assert",
]);
const TEXT_EXT = new Set([
  ".c", ".h", ".cpp", ".hpp", ".cc", ".py", ".js", ".ts", ".java", ".go", ".rs", ".sh", ".st",
  ".md", ".txt", ".adoc", ".rst", ".yml", ".yaml", ".cmake",
]);
const SKIP_DIRS = new Set([".git", "node_modules", "build", "dist", "out", "__pycache__"]);
const RESULTS_SCHEMA = "trace-results/v1";

class UsageError extends Error {}

// ───────────────────────── 파일과 태그 ─────────────────────────

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stat = fs.statSync(dir);
  if (stat.isFile()) return [dir];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const s = fs.statSync(full);
    if (s.isDirectory()) { if (!SKIP_DIRS.has(name)) out.push(...walk(full)); }
    else if (TEXT_EXT.has(path.extname(name).toLowerCase()) || name === "CMakeLists.txt") out.push(full);
  }
  return out;
}

function parseTags(text) {
  const tags = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(lines[i])) !== null) {
      const rest = m[2].replace(/\*\/.*$/, "").replace(/-->.*$/, "").trim();
      const args = REASON_TAGS.has(m[1]) ? [rest] : rest.split(/[\s,]+/).filter(Boolean);
      tags.push({ tag: m[1], args, line: i + 1 });
    }
  }
  return tags;
}

// "REQ-OTP-01-1@v2" → { id, version }. 버전이 없으면 version = null.
function parseRef(token) {
  const m = /^(.+?)@v(\d+)$/.exec(token);
  return m ? { id: m[1], version: parseInt(m[2], 10) } : { id: token, version: null };
}

// ───────────────────────── C 함수 정의 찾기 ─────────────────────────

// 주석·문자열·전처리 줄을 같은 길이의 공백으로 바꾼다(줄 번호 유지).
function blankNonCode(src) {
  const out = src.split("");
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === "/" && d === "/") { let e = src.indexOf("\n", i); if (e < 0) e = src.length; blank(i, e); i = e; continue; }
    if (c === '"' || c === "'") {
      let e = i + 1;
      while (e < src.length && src[e] !== c && src[e] !== "\n") e += src[e] === "\\" ? 2 : 1;
      blank(i, Math.min(e + 1, src.length)); i = e + 1; continue;
    }
    if (c === "#" && lineStart) {
      let e = i;
      for (;;) { let n = src.indexOf("\n", e); if (n < 0) { e = src.length; break; } if (src[n - 1] === "\\" || (src[n - 1] === "\r" && src[n - 2] === "\\")) { e = n + 1; continue; } e = n; break; }
      blank(i, e); i = e; continue;
    }
    if (c === "\n") lineStart = true;
    else if (c !== " " && c !== "\t" && c !== "\r") lineStart = false;
    i++;
  }
  return out.join("");
}

// 파일 최상위 수준의 함수 정의 목록: [{ name, startLine, endLine }]
function scanCFunctions(src) {
  const code = blankNonCode(src);
  const lineOf = (() => {
    const starts = [0];
    for (let k = 0; k < code.length; k++) if (code[k] === "\n") starts.push(k + 1);
    return (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
  })();
  const funcs = [];
  const stack = []; // 열린 중괄호마다: "transparent"(extern "C" 등) | "func" | "other"
  let depth = 0; // transparent 를 뺀 깊이
  let segStart = 0;
  let current = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === ";" && depth === 0) segStart = i + 1;
    else if (c === "{") {
      let kind = "other";
      if (depth === 0) {
        const header = code.slice(segStart, i);
        const trimmed = header.trim();
        if (/^extern\s*$/.test(trimmed)) { kind = "transparent"; segStart = i + 1; }
        else if (trimmed.endsWith(")") && !trimmed.includes("=")) {
          // 이름은 "식별자(" 꼴 가운데 자료형 낱말이 아닌 첫 번째 것.
          // 함수 포인터를 돌려주는 정의 `void (*name(int))(int)` 도 이 방식으로 잡힌다.
          let name = null;
          const idCall = /([A-Za-z_]\w*)\s*\(/g;
          let m;
          while ((m = idCall.exec(trimmed)) !== null) {
            if (!C_TYPE_WORDS.has(m[1]) && !m[1].startsWith("__")) { name = m[1]; break; }
          }
          if (name) {
            kind = "func";
            const lead = header.length - header.trimStart().length;
            current = { name, startLine: lineOf(segStart + lead), endLine: 0 };
          }
        }
      }
      stack.push(kind);
      if (kind !== "transparent") depth++;
    } else if (c === "}") {
      const kind = stack.pop();
      if (kind !== "transparent" && depth > 0) depth--;
      if (depth === 0) {
        if (kind === "func" && current) { current.endLine = lineOf(i); funcs.push(current); current = null; }
        segStart = i + 1;
      }
    }
  }
  return funcs;
}

// C 소스 한 파일의 함수와 거기 붙은 추적 태그.
// @implements·@trace-exempt 는 그 태그를 감싸거나 바로 뒤에 오는 함수에 붙는다.
// 반환: { units: [{ name, startLine, endLine, implements, exempt }], orphans: [태그] }
function cUnits(text) {
  const funcs = scanCFunctions(text);
  const units = funcs.map((f) => ({ name: f.name, startLine: f.startLine, endLine: f.endLine, implements: [], exempt: null }));
  const orphans = [];
  for (const t of parseTags(text)) {
    if (t.tag !== "implements" && t.tag !== "trace-exempt") continue;
    const u = units.find((x) => t.line <= x.endLine);
    if (!u) { orphans.push(t); continue; }
    if (t.tag === "implements") u.implements.push(...t.args);
    else u.exempt = t.args[0] || "";
  }
  return { units, orphans };
}

// ───────────────────────── 산출물 수집 ─────────────────────────

function collect(root, opts) {
  const rel = (f) => path.relative(root, f).split(path.sep).join("/");
  const model = { designs: new Map(), tests: new Map(), units: [], untraced: [], exempt: [], problems: [], signalRefs: [] };
  const problem = (rule, message, where) => model.problems.push({ rule, message, where });

  const declare = (map, kind, prefix, id, file, line) => {
    if (!id) { problem("T8", `@${kind} 뒤에 ID가 없음`, `${file}:${line}`); return null; }
    if (!id.startsWith(prefix)) problem("T8", `${id}: ${kind === "design" ? "설계 항목" : "시험"} ID는 ${prefix} 로 시작해야 함`, `${file}:${line}`);
    if (map.has(id)) { problem("T8", `${id}: ID가 중복 선언됨 (처음: ${map.get(id).file}:${map.get(id).line})`, `${file}:${line}`); return null; }
    const item = { id, file, line, links: [] };
    map.set(id, item);
    return item;
  };

  // 설계 문서: @design 다음의 @satisfies 가 그 설계 항목에 속한다.
  for (const dir of opts.design) for (const full of walk(path.join(root, dir))) {
    const file = rel(full);
    let cur = null;
    for (const t of parseTags(fs.readFileSync(full, "utf8"))) {
      if (t.tag === "design") cur = declare(model.designs, "design", "SWD-", t.args[0], file, t.line);
      else if (t.tag === "satisfies") {
        if (!cur) problem("T5", "@satisfies 앞에 @design 이 없음", `${file}:${t.line}`);
        else for (const a of t.args) cur.links.push(Object.assign(parseRef(a), { line: t.line }));
      } else if (t.tag === "signal") {
        // 설계가 쓰는 신호 선언: `@signal 이름@vN → 코드의 식별자`. 첫 낱말만 신호이고 뒤는 설명이다.
        if (!t.args[0]) problem("T12", "@signal 뒤에 신호 이름이 없음", `${file}:${t.line}`);
        else model.signalRefs.push(Object.assign(parseRef(t.args[0]), { file, line: t.line }));
      }
    }
  }

  // 코드: @implements 는 바로 다음(또는 그 태그를 감싼) 함수에 붙는다. C 가 아니면 파일 단위.
  for (const dir of opts.code) for (const full of walk(path.join(root, dir))) {
    const file = rel(full);
    const text = fs.readFileSync(full, "utf8");
    const tags = parseTags(text).filter((t) => t.tag === "implements" || t.tag === "trace-exempt");
    if (!C_EXT.has(path.extname(full).toLowerCase())) {
      const ids = tags.filter((t) => t.tag === "implements").flatMap((t) => t.args);
      if (ids.length) model.units.push({ file, func: null, line: tags[0].line, implements: ids });
      continue;
    }
    const { units, orphans } = cUnits(text);
    for (const t of orphans) problem("T5", `@${t.tag} 뒤에 함수 정의가 없음`, `${file}:${t.line}`);
    for (const f of units) {
      if (f.implements.length) model.units.push({ file, func: f.name, line: f.startLine, implements: f.implements });
      else if (f.exempt !== null) {
        if (!f.exempt) problem("T6", `${f.name}(): @trace-exempt 에 사유가 없음`, `${file}:${f.startLine}`);
        model.exempt.push({ file, func: f.name, line: f.startLine, reason: f.exempt });
      } else model.untraced.push({ file, func: f.name, line: f.startLine });
    }
  }

  // 시험: @testcase 다음의 @verifies 가 그 시험에 속한다.
  for (const dir of opts.tests) for (const full of walk(path.join(root, dir))) {
    const file = rel(full);
    let cur = null;
    for (const t of parseTags(fs.readFileSync(full, "utf8"))) {
      if (t.tag === "testcase") cur = declare(model.tests, "testcase", "TC-", t.args[0], file, t.line);
      else if (t.tag === "verifies") {
        if (!cur) problem("T5", "@verifies 앞에 @testcase 가 없음", `${file}:${t.line}`);
        else for (const a of t.args) cur.links.push(Object.assign(parseRef(a), { line: t.line }));
      } else if (t.tag === "oracle-unresolved") {
        // 기대값 미확정: 요구사항(수용 기준)만으로 기대 결과를 정할 수 없는 시험. 사유를 적어야 하고, 사람이 확정할 때까지 검증으로 치지 않는다.
        if (!cur) problem("T5", "@oracle-unresolved 앞에 @testcase 가 없음", `${file}:${t.line}`);
        else {
          cur.oracle = t.args[0] || "";
          if (!cur.oracle) problem("T6", `${cur.id}: @oracle-unresolved 에 사유가 없음 (무엇이 정해지지 않았는지 적는다)`, `${file}:${t.line}`);
        }
      }
    }
  }
  return model;
}

// ───────────────────────── 점검 ─────────────────────────

function check(baseline, model, results, env) {
  const errors = [];
  const warnings = [];
  const notRun = [];
  const err = (rule, message, where) => errors.push({ rule, message, where: where || "" });
  const warn = (rule, message, where) => warnings.push({ rule, message, where: where || "" });
  for (const p of model.problems) err(p.rule, p.message, p.where);

  const reqs = new Map(baseline.requirements.map((r) => [r.requirement_id, r]));
  const children = new Map();
  for (const r of baseline.requirements) {
    if (r.parent && reqs.has(r.parent)) { if (!children.has(r.parent)) children.set(r.parent, []); children.get(r.parent).push(r.requirement_id); }
  }

  // 요구사항을 가리키는 링크 하나를 판정한다. 유효하면 요구사항 ID, 아니면 null.
  const resolveReqLink = (link, kind, owner) => {
    const where = `${owner.file}:${link.line}`;
    const req = reqs.get(link.id);
    if (!req) { err("T5", `${owner.id}: ${kind} 대상 ${link.id} 가 고정본 ${baseline.baseline_id} 에 없음`, where); return null; }
    if (link.version === null) { err("T7", `${owner.id}: ${link.id} 에 버전이 없음 (${link.id}@v${req.version} 형식으로 적는다)`, where); return null; }
    if (link.version !== req.version) {
      err("T7", link.version < req.version
        ? `${owner.id}: ${link.id}@v${link.version} 는 낡은 버전 — 고정본은 v${req.version}. 바뀐 요구사항에 맞는지 다시 확인한 뒤 태그를 갱신한다`
        : `${owner.id}: ${link.id}@v${link.version} 는 고정본(${baseline.baseline_id})에 없는 버전 — 고정본은 v${req.version}`, where);
      return null;
    }
    return link.id;
  };

  // 설계 → 요구사항
  const designsByReq = new Map();
  for (const d of model.designs.values()) {
    if (d.links.length === 0) err("T6", `${d.id}: @satisfies 가 없음 (요구사항에 연결되지 않은 설계 항목)`, `${d.file}:${d.line}`);
    for (const link of d.links) {
      const id = resolveReqLink(link, "@satisfies", d);
      if (id) { if (!designsByReq.has(id)) designsByReq.set(id, []); designsByReq.get(id).push(d.id); }
    }
  }

  // 신호 표(T12): 설계가 선언한 신호가 승인된 표에 있고 버전이 같은지, 표의 신호가 설계에 선언됐는지.
  const signalTable = new Map((Array.isArray(baseline.signals) ? baseline.signals : []).map((s) => [s.name, s]));
  const signalSeen = new Set();
  for (const ref of model.signalRefs || []) {
    const where = `${ref.file}:${ref.line}`;
    const s = signalTable.get(ref.id);
    if (!s) {
      // 이름으로 볼 수 없는 글자(예: 설명 글 속의 "@signal 은 …")면 신호 표를 탓하지 않고 태그를 고치라고 알린다
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(ref.id))) err("T12", `@signal 뒤의 '${ref.id}' 는 신호 이름이 아님 — 선언은 '@signal 이름@v버전' 형식으로 적는다(설명 글에서는 @ 없이 'signal 태그'처럼 적는다)`, where);
      else err("T12", `@signal 대상 ${ref.id} 가 고정본 ${baseline.baseline_id} 의 신호 표에 없음 — 설계 문서가 선언한 신호 '${ref.id}' 를 승인된 신호 표에서 찾지 못했다. 이름이 틀렸으면 설계 문서를 고치고, 새 신호면 요구사항 화면의 신호 표에 더해 다시 고정한다`, where);
      continue;
    }
    signalSeen.add(ref.id);
    if (ref.version === null) err("T12", `신호 ${ref.id} 에 버전이 없음 (${ref.id}@v${s.version} 형식으로 적는다)`, where);
    else if (ref.version !== s.version) {
      err("T12", ref.version < s.version
        ? `신호 ${ref.id}@v${ref.version} 는 낡은 버전 — 표는 v${s.version}. 바뀐 자료형·단위·범위에 맞는지 다시 확인한 뒤 태그를 갱신한다`
        : `신호 ${ref.id}@v${ref.version} 는 신호 표에 없는 버전 — 표는 v${s.version}`, where);
    }
  }
  for (const s of signalTable.values()) {
    if (signalSeen.has(s.name)) continue;
    const designed = (s.requirements || []).filter((id) => designsByReq.has(id));
    if (designed.length) err("T12", `신호 ${s.name}@v${s.version}: 이 신호를 쓰는 요구사항(${designed.join(", ")})의 설계가 있는데 설계 문서에 @signal ${s.name}@v${s.version} 선언이 없음 — 신호 표를 고정하기 전에 만든 설계라면, 'AI 생성'에서 ${designed.join(", ")} 의 코드를 다시 생성하면 설계 문서에 선언이 더해진다(직접 고치려면 설계 문서에 이 선언을 적는다)`);
    else if (!(s.requirements || []).length) warn("T12", `신호 ${s.name}@v${s.version}: 어느 요구사항에도 연결되지 않은 신호`);
  }

  // 코드 → 설계
  const unitsByDesign = new Map();
  for (const u of model.units) {
    const label = u.func ? `${u.func}()` : u.file;
    for (const id of u.implements) {
      if (!model.designs.has(id)) { err("T5", `${label}: @implements 대상 ${id} 가 설계 문서에 없음`, `${u.file}:${u.line}`); continue; }
      if (!unitsByDesign.has(id)) unitsByDesign.set(id, []);
      unitsByDesign.get(id).push(u.func ? `${u.file}:${u.func}` : u.file);
    }
  }
  for (const f of model.untraced) {
    err("T6", `${f.func}(): 추적 태그가 없는 함수 (@implements 또는 사유를 적은 @trace-exempt 필요)`, `${f.file}:${f.line}`);
  }

  // 시험 → 요구사항(또는 설계 항목)
  const testsByReq = new Map();
  for (const t of model.tests.values()) {
    if (t.links.length === 0) err("T6", `${t.id}: @verifies 가 없음 (무엇을 검증하는지 알 수 없는 시험)`, `${t.file}:${t.line}`);
    for (const link of t.links) {
      if (link.id.startsWith("SWD-")) {
        if (!model.designs.has(link.id)) err("T5", `${t.id}: @verifies 대상 ${link.id} 가 설계 문서에 없음`, `${t.file}:${link.line}`);
        continue;
      }
      const id = resolveReqLink(link, "@verifies", t);
      if (id) { if (!testsByReq.has(id)) testsByReq.set(id, []); testsByReq.get(id).push(t.id); }
    }
  }

  // 미검증 선언(requirements/not-verified.json): 사람이 '이 환경의 시험으로는 확인할 수 없다'고 사유와 함께 밝힌 요구사항.
  const nvByReq = new Map();
  if (env.notVerifiedProblem) err("T11", env.notVerifiedProblem, notVerified.REL);
  for (const d of env.notVerified || []) {
    const id = String(d.requirement_id || "");
    const req = reqs.get(id);
    if (!req) { err("T11", `미검증 선언의 대상 ${id || "(ID 없음)"} 가 고정본 ${baseline.baseline_id} 에 없음`, notVerified.REL); continue; }
    if (d.version !== req.version) { err("T11", `${id}@v${d.version} 에 대한 미검증 선언은 낡음 — 고정본은 v${req.version}. 바뀐 요구사항에 대해 사람이 다시 결정한다`, notVerified.REL); continue; }
    if (!String(d.reason || "").trim() || !String(d.decided_by || "").trim()) { err("T11", `${id}: 미검증 선언에 사유나 결정한 사람이 없음`, notVerified.REL); continue; }
    if (children.has(id)) { err("T11", `${id}: 하위 요구사항으로 나뉜 요구사항에는 미검증 선언을 둘 수 없음 (하위 요구사항에 둔다)`, notVerified.REL); continue; }
    nvByReq.set(id, { reason: String(d.reason).trim(), decided_by: String(d.decided_by).trim(), decided_at: d.decided_at || null });
  }

  // 시험 결과와 형상
  let resultOf = null;
  if (!results) {
    notRun.push("시험 결과 파일이 주어지지 않아 TC→결과(T4)와 형상 일치(T9)를 확인하지 않음");
    if (env.requireResults) err("T4", "시험 결과 파일이 필요함 (--results)");
  } else {
    resultOf = new Map();
    if (results.schema !== RESULTS_SCHEMA) err("T9", `시험 결과 형식이 ${RESULTS_SCHEMA} 가 아님: ${results.schema}`);
    for (const r of Array.isArray(results.results) ? results.results : []) {
      if (resultOf.has(r.tc_id)) err("T4", `${r.tc_id}: 시험 결과가 중복됨`);
      resultOf.set(r.tc_id, String(r.result || "").toLowerCase());
      if (!model.tests.has(r.tc_id)) warn("T4", `${r.tc_id}: 결과는 있지만 @testcase 로 선언된 시험이 없음`);
    }
    if (results.baseline_hash !== baseline.baseline_hash) {
      err("T9", `시험이 다른 고정본으로 실행됨 — 결과: ${results.baseline_id || "?"} ${String(results.baseline_hash).slice(0, 19)}…, 현재: ${baseline.baseline_id} ${baseline.baseline_hash.slice(0, 19)}…`);
    }
    if (!env.commit) notRun.push("현재 커밋을 알 수 없어 시험한 커밋과의 일치(T9)를 확인하지 않음 (--commit 으로 지정 가능)");
    else if (!results.commit || !(env.commit.startsWith(results.commit) || results.commit.startsWith(env.commit))) {
      err("T9", `시험한 커밋(${results.commit || "없음"})이 현재 커밋(${env.commit.slice(0, 12)})과 다름`);
    }
    if (env.dirty) warn("T9", "커밋되지 않은 변경이 있어 시험 결과가 현재 파일과 다를 수 있음");
  }

  // 요구사항별 추적표
  const rows = new Map();
  const directRow = (r) => {
    const id = r.requirement_id;
    const designs = designsByReq.get(id) || [];
    const code = [...new Set(designs.flatMap((d) => unitsByDesign.get(d) || []))];
    const tests = testsByReq.get(id) || [];
    const outcome = tests.map((t) => ({ tc_id: t, result: resultOf ? (resultOf.get(t) || "none") : "unknown" }));
    return { requirement_id: id, version: r.version, summary: r.summary || "", designs, code, tests, results: outcome, via_children: false };
  };
  const leafOrLinked = (r) => !children.has(r.requirement_id) || designsByReq.has(r.requirement_id) || testsByReq.has(r.requirement_id);

  for (const r of baseline.requirements) {
    if (!leafOrLinked(r)) continue;
    const row = directRow(r);
    const id = r.requirement_id;
    const missing = [];
    if (row.designs.length === 0) { missing.push("설계"); err("T1", `${id}@v${r.version}: 이 요구사항을 만족하는 설계 항목이 없음`); }
    for (const d of row.designs) {
      if (!(unitsByDesign.get(d) || []).length) { missing.push("코드"); err("T2", `${d}: 이 설계 항목을 구현한 코드가 없음 (${id} 의 구현 누락)`, `${model.designs.get(d).file}:${model.designs.get(d).line}`); }
    }
    const nv = nvByReq.get(id) || null;
    // 미검증으로 선언된 요구사항은 시험이 없어도 '링크 누락'으로 보지 않는다. 대신 상태가 '미검증'이 된다(통과가 아니다).
    if (row.tests.length === 0 && !nv) { missing.push("시험"); err("T3", `${id}@v${r.version}: 이 요구사항을 검증하는 시험이 없음`); }
    // 기대값 미확정 시험: 통과로 나와도 검증으로 치지 않고, 게이트를 막는다.
    const unresolved = row.tests.filter((t) => model.tests.get(t).oracle !== undefined);
    for (const tc of unresolved) {
      const t = model.tests.get(tc);
      err("T10", `${tc}: 기대값이 확정되지 않음 — ${t.oracle || "사유 없음"} (${id} 검증). 해결: ① 요구사항 화면에서 이 경우의 기대 결과를 ${id} 의 문장이나 수용 기준에 더하고(또는 이 경우를 다루는 요구사항을 고치고) ② 확정한 뒤 새 고정본을 저장하고 ③ 생성 → 시험 에이전트에서 ${id} 를 다시 생성한다. 이 환경의 시험으로 확인할 수 없는 요구사항이면 요구사항 보기에서 '미검증으로 표시'한다`, `${t.file}:${t.line}`);
    }
    if (unresolved.length) {
      row.oracle_unresolved = unresolved;
      // 시험마다 무엇이 정해지지 않았는지(화면의 해결 안내에 쓴다)
      row.oracle_reasons = Object.fromEntries(unresolved.map((tc) => [tc, model.tests.get(tc).oracle || ""]));
    }
    if (nv) { row.not_verified = nv; warn("T11", `${id}@v${r.version}: 미검증 — ${nv.reason} (결정: ${nv.decided_by})`, notVerified.REL); }
    let status = missing.length ? "불완전" : "링크 완전";
    let failed = false;
    if (resultOf && !missing.length) {
      const bad = row.results.filter((x) => x.result !== "pass" && !unresolved.includes(x.tc_id));
      failed = bad.some((x) => x.result === "fail");
      for (const x of bad) {
        const t = model.tests.get(x.tc_id);
        err("T4", x.result === "none" ? `${x.tc_id}: 실행 결과가 없음 (${id} 검증)` : `${x.tc_id}: 결과가 ${x.result} (${id} 검증)`, `${t.file}:${t.line}`);
      }
      status = bad.length ? (failed ? "시험 실패" : "결과 없음") : "완전";
    }
    // 실패가 가장 무겁고, 그다음이 기대값 미확정. 미검증은 다른 문제가 없을 때의 상태다.
    if (!missing.length && !failed) {
      if (unresolved.length) status = "기대값 미확정";
      else if (nv && status !== "결과 없음") status = "미검증";
    }
    row.status = status;
    rows.set(id, row);
  }
  // 하위 요구사항으로 구체화된 상위 요구사항: 직접 링크가 없으면 하위의 상태를 따른다.
  const visiting = new Set();
  const derive = (id) => {
    if (rows.has(id)) return rows.get(id).status;
    if (visiting.has(id)) return "불완전"; // 상위 관계가 순환하면 충족으로 보지 않는다
    visiting.add(id);
    const r = reqs.get(id);
    const kids = (children.get(id) || []).map(derive);
    const rank = ["불완전", "시험 실패", "기대값 미확정", "결과 없음", "미검증", "링크 완전", "완전"];
    const status = kids.reduce((a, b) => (rank.indexOf(b) < rank.indexOf(a) ? b : a), "완전");
    rows.set(id, { requirement_id: id, version: r.version, summary: r.summary || "", designs: [], code: [], tests: [], results: [], via_children: true, children: [...(children.get(id) || [])], status });
    return status;
  };
  for (const r of baseline.requirements) derive(r.requirement_id);

  // Baseline 자체의 미결 항목
  const open = baseline.open_items || {};
  for (const id of open.unresolved_placeholder || []) err("T0", `${id}: 값이 정해지지 않은 자리표시자가 남은 요구사항 — 구현·시험의 근거로 쓸 수 없음`);
  for (const id of open.missing_acceptance_criteria || []) {
    if (!children.has(id)) warn("T0", `${id}: 수용 기준이 없음 — 시험의 기대 결과를 요구사항에서 직접 확인할 수 없음`);
  }

  const matrix = baseline.requirements.map((r) => rows.get(r.requirement_id));
  return { errors, warnings, notRun, matrix };
}

// ───────────────────────── 출력 ─────────────────────────

function renderText(report) {
  const { baseline, result, counts } = report;
  const lines = [];
  lines.push(`# 추적성 점검: ${baseline.baseline_id} (${baseline.baseline_hash.slice(0, 19)}…)`);
  lines.push(`요구사항 ${baseline.requirements.length}개 · 설계 항목 ${counts.designs}개 · 코드 단위 ${counts.units}개 · 시험 ${counts.tests}개 · 추적 제외 함수 ${counts.exempt}개`);
  lines.push("");
  for (const row of result.matrix) {
    const detail = row.via_children ? "하위 요구사항으로 충족"
      : `설계 ${row.designs.join(", ") || "-"} | 코드 ${row.code.join(", ") || "-"} | 시험 ${row.results.map((x) => x.result === "unknown" ? x.tc_id : `${x.tc_id}=${x.result}`).join(", ") || "-"}`;
    lines.push(`- [${row.status}] ${row.requirement_id}@v${row.version} — ${detail}`);
  }
  lines.push("");
  for (const e of result.errors) lines.push(`[오류 ${e.rule}] ${e.message}${e.where ? ` (${e.where})` : ""}`);
  for (const w of result.warnings) lines.push(`[주의 ${w.rule}] ${w.message}${w.where ? ` (${w.where})` : ""}`);
  for (const n of result.notRun) lines.push(`[미실행] ${n}`);
  lines.push("");
  const nvCount = result.matrix.filter((r) => r.not_verified).length;
  const orCount = result.matrix.reduce((n, r) => n + (r.oracle_unresolved ? r.oracle_unresolved.length : 0), 0);
  const extra = `${nvCount ? `, 미검증 요구사항 ${nvCount}개(통과 아님)` : ""}${orCount ? `, 기대값 미확정 시험 ${orCount}개` : ""}`;
  lines.push(`판정: ${result.errors.length ? "실패" : "통과"} — 오류 ${result.errors.length}개, 주의 ${result.warnings.length}개, 미실행 ${result.notRun.length}개${extra}`);
  return lines.join("\n");
}

function renderMarkdown(report) {
  const { baseline, result } = report;
  const cell = (s) => String(s).replace(/\|/g, "\\|") || "-";
  const lines = [
    `# 추적표 — ${baseline.baseline_id}`,
    "",
    `- 고정본 해시: \`${baseline.baseline_hash}\``,
    `- 시험한 커밋: ${report.results_commit ? "`" + report.results_commit + "`" : "미확인(시험 결과 없음)"}`,
    `- 판정: ${result.errors.length ? "실패" : "통과"} (오류 ${result.errors.length}, 주의 ${result.warnings.length}, 미실행 ${result.notRun.length})`,
    "",
    "| 요구사항 | 버전 | 설계 | 코드 | 시험과 결과 | 상태 |",
    "|---|---|---|---|---|---|",
  ];
  for (const row of result.matrix) {
    const tests = row.results.map((x) => (x.result === "unknown" ? x.tc_id : `${x.tc_id} (${x.result})`)).join("<br>");
    lines.push(`| ${cell(row.requirement_id)} | v${row.version} | ${cell(row.via_children ? "(하위 요구사항)" : row.designs.join("<br>"))} | ${cell(row.code.join("<br>"))} | ${cell(tests)} | ${row.status} |`);
  }
  if (result.errors.length || result.warnings.length || result.notRun.length) {
    lines.push("", "## 발견 사항", "");
    for (const e of result.errors) lines.push(`- 오류 ${e.rule}: ${e.message}${e.where ? ` (\`${e.where}\`)` : ""}`);
    for (const w of result.warnings) lines.push(`- 주의 ${w.rule}: ${w.message}${w.where ? ` (\`${w.where}\`)` : ""}`);
    for (const n of result.notRun) lines.push(`- 미실행: ${n}`);
  }
  return lines.join("\n") + "\n";
}

// ───────────────────────── 실행 ─────────────────────────

// 고정본의 요구사항 목록이 깨졌는지(목록이 아님 · 항목이 객체가 아님 · ID 없음). 깨졌으면 무엇이 문제인지 글로, 아니면 null.
function baselineShapeProblem(b) {
  const reqs = b && b.requirements;
  if (!Array.isArray(reqs)) return "requirements 가 목록이 아닙니다";
  if (reqs.some((q) => !q || typeof q !== "object" || Array.isArray(q))) return "requirements 안에 요구사항이 아닌 값이 있습니다";
  if (reqs.some((q) => typeof q.requirement_id !== "string" || !q.requirement_id)) return "requirement_id 가 없는 요구사항이 있습니다";
  return null;
}
// 사람에게 그대로 보여도 되는 오류(어느 파일이 왜 틀렸는지). 서버가 422 로 그 글을 내보낸다.
const brokenBaseline = (rel, why) => Object.assign(new UsageError(`고정본 파일의 내용이 올바르지 않습니다: ${rel} — ${why}. 이 파일을 되돌리거나(Git) 고친 뒤 다시 하세요.`), { status: 422, expose: true });

function findBaseline(root, explicit) {
  if (explicit) {
    const file = path.resolve(root, explicit);
    if (!fs.existsSync(file)) throw new UsageError(`고정본 파일을 찾을 수 없음: ${file}`);
    return file;
  }
  const dir = path.join(root, "requirements", "baseline");
  let best = null;
  for (const full of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".baseline.json")).map((n) => path.join(dir, n)) : []) {
    let n = -1;
    try { n = parseInt((/^BL-(\d+)$/.exec(JSON.parse(fs.readFileSync(full, "utf8")).baseline_id) || [])[1], 10); } catch (_) { /* 아래에서 무시 */ }
    if (Number.isFinite(n) && (!best || n > best.n)) best = { n, full };
  }
  if (!best) throw new UsageError(`고정본 파일이 없음: ${dir}/*.baseline.json (또는 --baseline 으로 지정)`);
  return best.full;
}

function gitInfo(root) {
  const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    // 대상 폴더가 저장소의 최상위일 때만 그 저장소의 커밋으로 본다(상위 저장소의 커밋과 섞이지 않게).
    if (path.resolve(run("rev-parse", "--show-toplevel")) !== path.resolve(root)) return { commit: null, dirty: false };
    return { commit: run("rev-parse", "HEAD"), dirty: run("status", "--porcelain").length > 0 };
  } catch (_) { return { commit: null, dirty: false }; }
}

function parseArgs(argv) {
  const opts = { root: ".", design: ["docs/design"], code: ["src"], tests: ["tests"], baseline: null, results: null, commit: null, out: null, json: false, requireResults: false, help: false };
  const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} 뒤에 값이 필요함`); return argv[++i]; };
    if (a === "--root") opts.root = value();
    else if (a === "--baseline") opts.baseline = value();
    else if (a === "--design") opts.design = list(value());
    else if (a === "--code") opts.code = list(value());
    else if (a === "--tests") opts.tests = list(value());
    else if (a === "--results") opts.results = value();
    else if (a === "--commit") opts.commit = value();
    else if (a === "--out") opts.out = value();
    else if (a === "--json") opts.json = true;
    else if (a === "--require-results") opts.requireResults = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new UsageError(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

const HELP = `요구사항–설계–코드–시험–결과 추적 점검기

사용법: node tools/trace/trace-check.js --root <대상 프로젝트> [옵션]

  --root DIR          대상 프로젝트 폴더 (기본: 현재 폴더)
  --baseline FILE     고정본 파일 (기본: requirements/baseline/ 에서 번호가 가장 큰 것)
  --design DIRS       설계 문서 폴더, 쉼표로 여러 개 (기본: docs/design)
  --code DIRS         소스 폴더 (기본: src)
  --tests DIRS        시험 폴더 (기본: tests)
  --results FILE      시험 결과 파일 (${RESULTS_SCHEMA}). 없으면 결과·형상 점검은 미실행으로 보고
  --require-results   시험 결과가 없으면 실패로 판정 (릴리스 게이트용)
  --commit SHA        시험한 커밋과 대조할 현재 커밋 (기본: 대상 폴더가 Git 저장소 최상위이면 HEAD)
  --out DIR           추적표를 trace-matrix.json / trace-matrix.md 로 저장
  --json              결과를 JSON 으로 출력

종료 코드: 0 오류 없음, 1 추적성 오류, 2 실행 조건 오류. 태그 규칙: tools/trace/TAG_RULES.md`;

async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return { code: 0, text: HELP };
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`대상 폴더를 찾을 수 없음: ${root}`);

  const baselineFile = findBaseline(root, opts.baseline);
  let baseline;
  try { baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")); }
  catch (e) { throw new UsageError(`고정본 파일을 읽을 수 없음: ${baselineFile} (${e.message})`); }
  const shape = baselineShapeProblem(baseline);
  if (shape) throw brokenBaseline(path.relative(root, baselineFile).split(path.sep).join("/"), shape);
  const integrity = await baselineApi.verifyBaseline(baseline);
  if (!integrity.ok) {
    return { code: 1, text: `[오류 T0] 고정본 파일이 손상되었거나 수정됨: ${path.relative(root, baselineFile)}\n` + integrity.errors.map((e) => `  - ${e}`).join("\n") + "\n판정: 실패 — 승인된 고정본과 다른 내용으로는 추적성을 판정할 수 없음" };
  }

  let results = null;
  if (opts.results) {
    const file = path.resolve(root, opts.results);
    try { results = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { throw new UsageError(`시험 결과 파일을 읽을 수 없음: ${file} (${e.message})`); }
  }
  const git = opts.commit ? { commit: opts.commit, dirty: false } : gitInfo(root);
  const model = collect(root, opts);
  const nv = notVerified.load(root);
  const result = check(baseline, model, results, { commit: git.commit, dirty: git.dirty, requireResults: opts.requireResults, notVerified: nv.items, notVerifiedProblem: nv.problem });
  const report = {
    baseline: { baseline_id: baseline.baseline_id, baseline_hash: baseline.baseline_hash, requirements: baseline.requirements },
    baseline_file: path.relative(root, baselineFile).split(path.sep).join("/"),
    results_commit: results ? results.commit || null : null,
    counts: { designs: model.designs.size, units: model.units.length, tests: model.tests.size, exempt: model.exempt.length,
      not_verified: result.matrix.filter((r) => r.not_verified).length, oracle_unresolved: result.matrix.reduce((n, r) => n + (r.oracle_unresolved ? r.oracle_unresolved.length : 0), 0) },
    exempt: model.exempt,
    result,
  };
  if (opts.out) {
    const outDir = path.resolve(root, opts.out);
    fs.mkdirSync(outDir, { recursive: true });
    const slim = Object.assign({}, report, { baseline: { baseline_id: baseline.baseline_id, baseline_hash: baseline.baseline_hash } });
    fs.writeFileSync(path.join(outDir, "trace-matrix.json"), JSON.stringify(slim, null, 2) + "\n");
    fs.writeFileSync(path.join(outDir, "trace-matrix.md"), renderMarkdown(report));
  }
  const text = opts.json
    ? JSON.stringify(Object.assign({}, report, { baseline: { baseline_id: baseline.baseline_id, baseline_hash: baseline.baseline_hash } }), null, 2)
    : renderText(report);
  return { code: result.errors.length ? 1 : 0, text, report };
}

module.exports = { baselineShapeProblem, brokenBaseline, run, parseTags, parseRef, scanCFunctions, cUnits, collect, check, findBaseline, blankNonCode, C_EXT, RESULTS_SCHEMA, UsageError };

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (r) => { console.log(r.text); process.exitCode = r.code; },
    (e) => {
      if (e instanceof UsageError) { console.error(e.message); process.exitCode = 2; }
      else { console.error(e); process.exitCode = 2; }
    }
  );
}
