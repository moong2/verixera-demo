/* 요구사항–코드 정합성 검사(규칙으로 정하는 부분).
 *
 * 사람이 코드를 고친 뒤, 기준 커밋 이후 바뀐 줄에서 요구사항 의미를 바꿀 수 있는 변화를 규칙으로 뽑는다.
 *  - 비교 연산자(>= → >), 논리 연산자(&& ↔ ||), 부정(!) 추가·삭제, 대입·비교 혼동(= ↔ ==)
 *  - 상수·임계값(#define 포함), 형 변환·자료형(부호·폭), 조건·분기·반환의 추가·삭제, 초기화 삭제
 *  - 함수 머리(인자·반환형) 변화
 * 그리고 바뀐 함수 → 설계 → 요구사항으로 이어 관련 요구사항과 그 요구사항을 검증하는 TC, 최근 TC 실행 결과를 모은다.
 *
 * 파일을 고치지 않는다. AI 판정은 tools/agent/consistency-review.js 가 이 결과를 근거로 받는다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const trace = require("./trace-check.js");
const impact = require("./impact.js");
const snapshots = require("./snapshots.js");

const SCHEMA = "consistency-check/v1";
const DIRS = { design: ["docs/design"], code: ["src"], tests: ["tests"] };

const KIND = {
  comparison: ["비교 연산자", "high"],
  logic: ["논리 연산자", "high"],
  negation: ["부정(!)", "high"],
  assign_compare: ["대입·비교 혼동", "high"],
  constant: ["상수·임계값", "high"],
  type: ["자료형(부호·폭)", "high"],
  cast: ["형 변환", "high"],
  condition: ["조건 추가·삭제", "high"],
  branch_added: ["분기 추가", "high"],
  branch_removed: ["분기 삭제", "high"],
  return_changed: ["반환 추가·삭제", "high"],
  init_removed: ["초기화 삭제", "high"],
  interface: ["함수 머리(인자·반환형)", "high"],
  arithmetic: ["산술 연산자", "medium"],
  identifier: ["다른 변수·신호 사용", "medium"],
  assignment: ["대입 추가·삭제", "medium"],
  uninitialized: ["초기값 없는 선언", "medium"],
  expression: ["식 변경", "medium"],
  new_file: ["새 파일", "medium"],
  removed_file: ["파일 삭제", "high"],
};

const CMP = new Set(["<", ">", "<=", ">=", "==", "!="]);
const LOGIC = new Set(["&&", "||"]);
const ARITH = new Set(["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^"]);
const TYPES = new Set(["char", "short", "int", "long", "float", "double", "signed", "unsigned", "bool", "_Bool", "size_t", "ssize_t", "ptrdiff_t",
  "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "float32_t", "float64_t", "intptr_t", "uintptr_t"]);
const isType = (t) => TYPES.has(t) || /^u?int(8|16|32|64)_t$/.test(t) || /^(?:float|f)(32|64)(_t)?$/.test(t);
const isNum = (t) => /^(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uUlLfF]*$/.test(t);
const BOOL = new Set(["true", "false", "TRUE", "FALSE"]);
const isIdent = (t) => /^[A-Za-z_]\w*$/.test(t) && !BOOL.has(t);
const KEYWORDS = new Set(["if", "else", "while", "for", "do", "switch", "case", "default", "return", "break", "continue", "goto", "sizeof", "static", "const", "volatile", "extern", "struct", "union", "enum", "typedef", "void"]);

const TOKEN_RE = /0[xX][0-9a-fA-F]+[uUlL]*|\d+\.\d*(?:[eE][+-]?\d+)?[fFlL]?|\.\d+(?:[eE][+-]?\d+)?[fFlL]?|\d+(?:[eE][+-]?\d+)?[uUlLfF]*|[A-Za-z_]\w*|<<=|>>=|->|\+\+|--|<=|>=|==|!=|&&|\|\||<<|>>|[-+*/%&|^!~<>=?:;,.(){}[\]#]/g;
const tokens = (line) => String(line || "").match(TOKEN_RE) || [];
const numVal = (t) => { const s = String(t).replace(/[uUlLfF]+$/, ""); const v = /^0[xX]/.test(s) ? parseInt(s, 16) : Number(s); return Number.isFinite(v) ? v : null; };

function git(root, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

// `git diff -U0` 의 hunk 머리만 읽는다(줄 내용은 양쪽 파일에서 줄 번호로 가져온다).
const hunksOf = (text) => {
  const files = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) { cur = { oldPath: null, newPath: null, hunks: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith("--- ")) cur.oldPath = line === "--- /dev/null" ? null : line.slice(4).replace(/^a\//, "");
    else if (line.startsWith("+++ ")) cur.newPath = line === "+++ /dev/null" ? null : line.slice(4).replace(/^b\//, "");
    else {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) cur.hunks.push({ oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4] });
    }
  }
  return files.filter((f) => f.oldPath || f.newPath);
};

// 두 토큰 열의 최장 공통 부분열로 바뀐 구간(교체·삽입·삭제)을 낸다.
function tokenEdits(a, b) {
  const n = a.length; const m = b.length;
  if (n * m > 40000) return [{ a: a.slice(), b: b.slice() }];
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const edits = [];
  let i = 0; let j = 0; let cur = null;
  const flush = () => { if (cur && (cur.a.length || cur.b.length)) edits.push(cur); cur = null; };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { a: [], b: [], at: j };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) cur.b.push(b[j++]);
    else cur.a.push(a[i++]);
  }
  flush();
  return edits;
}

const similarity = (a, b) => {
  if (!a.length && !b.length) return 1;
  const sa = new Map(); for (const t of a) sa.set(t, (sa.get(t) || 0) + 1);
  let common = 0; for (const t of b) { const k = sa.get(t) || 0; if (k > 0) { common++; sa.set(t, k - 1); } }
  return (2 * common) / (a.length + b.length);
};

const isBranchLine = (tk) => ["if", "else", "switch", "case", "while", "for", "default"].includes(tk[0]) || tk.includes("?");
const isDeclLine = (tk) => tk.length > 2 && (isType(tk[0]) || ((tk[0] === "static" || tk[0] === "const" || tk[0] === "volatile") && tk.slice(1, 3).some(isType)));
const trivial = (tk) => !tk.length || tk.every((t) => t === "{" || t === "}" || t === ";");
const isCast = (seg) => seg.length >= 3 && seg[0] === "(" && seg[seg.length - 1] === ")" && seg.slice(1, -1).every((t) => isType(t) || t === "*" || t === "const");

const CMP_TEXT = (x, y) => {
  if ((x === ">=" && y === ">") || (x === "<=" && y === "<")) return "경계값이 조건에서 빠짐(포함 → 제외)";
  if ((x === ">" && y === ">=") || (x === "<" && y === "<=")) return "경계값이 조건에 들어감(제외 → 포함)";
  if ((x[0] === "<" && y[0] === ">") || (x[0] === ">" && y[0] === "<")) return "비교 방향이 반대로 바뀜";
  return "비교 의미가 바뀜";
};

// 짝지은 두 줄(바뀌기 전·후)에서 의미 변화를 뽑는다.
function classifyPair(oldTk, newTk, ctx) {
  const out = [];
  if (ctx.signature) {
    const what = tokenEdits(oldTk, newTk).map((e) => `${e.a.join(" ") || "(없음)"} → ${e.b.join(" ") || "(없음)"}`).join(", ");
    out.push({ kind: "interface", detail: `함수 이름 줄(인자·반환형)이 바뀜: ${what} — 부르는 쪽과 설계의 인터페이스 확인` });
    return out;
  }
  for (const e of tokenEdits(oldTk, newTk)) {
    const A = e.a; const B = e.b; const a0 = A[0]; const b0 = B[0];
    const said = (kind, detail) => out.push({ kind, detail, before: A.join(" "), after: B.join(" ") });
    if (A.length === 1 && B.length === 1) {
      if (CMP.has(a0) && CMP.has(b0)) { said("comparison", `${a0} → ${b0}: ${CMP_TEXT(a0, b0)}`); continue; }
      if (LOGIC.has(a0) && LOGIC.has(b0)) { said("logic", `${a0} → ${b0}: 조건을 묶는 방식이 바뀜(모두 ↔ 하나라도)`); continue; }
      if ((a0 === "=" && b0 === "==") || (a0 === "==" && b0 === "=")) { said("assign_compare", `${a0} → ${b0}: 대입과 비교가 바뀜`); continue; }
      if (isNum(a0) && isNum(b0)) { said("constant", `${a0} → ${b0}${ctx.macro ? ` (${ctx.macro})` : ""}: 값이 바뀜`); continue; }
      // 참·거짓 값(true/false, TRUE/FALSE)도 상수다: 출력·상태의 값이 뒤집힘
      if (BOOL.has(a0) && BOOL.has(b0)) { said("constant", `${a0} → ${b0}${ctx.macro ? ` (${ctx.macro})` : ""}: 참·거짓 값이 뒤집힘`); continue; }
      if (ARITH.has(a0) && ARITH.has(b0)) { said("arithmetic", `${a0} → ${b0}: 계산 방식이 바뀜`); continue; }
      if (isType(a0) && isType(b0)) { said("type", `${a0} → ${b0}: 부호·폭이 바뀜(넘침·부호 확장 확인)`); continue; }
      if (isIdent(a0) && isIdent(b0) && !KEYWORDS.has(a0) && !KEYWORDS.has(b0)) { said("identifier", `${a0} → ${b0}: 다른 변수·신호·함수를 씀`); continue; }
    }
    const all = [...A, ...B];
    if (isCast(A) || isCast(B) || (A.length && B.length && A.some(isType) && B.some(isType) && all.includes("("))) { said("cast", `형 변환이 바뀜: ${A.join(" ") || "(없음)"} → ${B.join(" ") || "(없음)"}`); continue; }
    if ((A.length === 0 && B.length === 1 && b0 === "!") || (B.length === 0 && A.length === 1 && a0 === "!")) { said("negation", A.length ? "부정(!)이 빠짐: 조건이 뒤집힘" : "부정(!)이 생김: 조건이 뒤집힘"); continue; }
    if (all.some((t) => LOGIC.has(t))) { said("condition", `조건이 ${!A.length ? "추가됨" : !B.length ? "빠짐" : "바뀜"}: ${A.join(" ") || "(없음)"} → ${B.join(" ") || "(없음)"}`); continue; }
    if (ctx.decl && A.includes("=") && !B.includes("=")) { said("init_removed", "선언의 초기값이 빠짐"); continue; }
    if (all.some((t) => CMP.has(t))) { said("comparison", `비교식이 바뀜: ${A.join(" ") || "(없음)"} → ${B.join(" ") || "(없음)"}`); continue; }
    if (all.some(isNum) && ctx.branch) { said("constant", `조건 안의 값이 바뀜: ${A.join(" ") || "(없음)"} → ${B.join(" ") || "(없음)"}`); continue; }
    said("expression", `${A.join(" ") || "(없음)"} → ${B.join(" ") || "(없음)"}`);
  }
  return out;
}

// 한쪽에만 있는 줄(추가·삭제)
function classifyLone(tk, side) {
  if (trivial(tk)) return null;
  const word = side === "old" ? "삭제" : "추가";
  if (["if", "else", "switch", "case", "default"].includes(tk[0])) return { kind: side === "old" ? "branch_removed" : "branch_added", detail: `분기가 ${word}됨` };
  if (tk[0] === "return") return { kind: "return_changed", detail: `반환문이 ${word}됨` };
  if (isDeclLine(tk)) {
    if (side === "old" && tk.includes("=")) return { kind: "init_removed", detail: "초기값을 주던 선언이 삭제됨" };
    if (side === "new" && !tk.includes("=") && !tk.includes("(") && !tk.includes("[") && tk[0] !== "static" && tk[0] !== "extern") return { kind: "uninitialized", detail: "초기값 없이 변수를 선언함" };
    return { kind: "assignment", detail: `선언이 ${word}됨` };
  }
  if (tk.includes("=") || tk.includes("++") || tk.includes("--") || tk.some((t) => /^[-+*/%&|^]=$|^<<=$|^>>=$/.test(t))) return { kind: "assignment", detail: `대입이 ${word}됨` };
  if (tk.some((t) => CMP.has(t) || LOGIC.has(t))) return { kind: "condition", detail: `조건식 줄이 ${word}됨` };
  return { kind: "expression", detail: `줄이 ${word}됨` };
}

// 바뀐 블록(삭제 줄 묶음과 추가 줄 묶음)에서 서로 닮은 줄끼리 짝짓는다.
function pairLines(olds, news) {
  const pairs = []; const usedNew = new Set();
  for (const o of olds) {
    let best = -1; let bestScore = 0.45;
    for (let k = 0; k < news.length; k++) {
      if (usedNew.has(k)) continue;
      const s = similarity(o.tk, news[k].tk) - Math.abs(k - olds.indexOf(o)) * 0.01;
      if (s > bestScore) { bestScore = s; best = k; }
    }
    if (best >= 0) { usedNew.add(best); pairs.push([o, news[best]]); } else pairs.push([o, null]);
  }
  news.forEach((n, k) => { if (!usedNew.has(k)) pairs.push([null, n]); });
  return pairs;
}

// 주석만 지운다(줄 수 유지). 전처리 줄(#define)과 문자열은 남긴다 — 임계값 매크로도 검사하려고.
function stripComments(src) {
  const out = src.split("");
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1];
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === "/" && d === "/") { let e = src.indexOf("\n", i); if (e < 0) e = src.length; blank(i, e); i = e; continue; }
    if (c === '"' || c === "'") { let e = i + 1; while (e < src.length && src[e] !== c && src[e] !== "\n") e += src[e] === "\\" ? 2 : 1; i = e + 1; continue; }
    i++;
  }
  return out.join("");
}

// 도구가 읽는 주석: 고치면 빌드·정적 분석의 결과가 달라질 수 있다(그래서 '주석만 바뀜'으로 보지 않는다).
//  - cppcheck-suppress …        Cppcheck 의 지적을 끈다(이 앱은 --inline-suppr 로 실행한다)
//  - fallthrough / fall through  GCC 가 switch 의 '이어서 실행' 경고를 내지 않는다(-Wextra -Werror 면 빌드 성패가 갈린다)
//  - NOLINT…                     clang-tidy 의 지적을 끈다
//  - LCOV_EXCL_… / GCOV_EXCL_…   커버리지 집계에서 뺀다
const TOOL_COMMENT_RE = /cppcheck-suppress|NOLINT|fall[\s_-]?thr(?:ough|u)|LCOV_EXCL|GCOV_EXCL/i;
// 두 코드가 '동작이 같은가'를 견줄 때 쓰는 모양: 주석을 빼고 줄 끝 공백과 빈 줄을 버린다.
// 도구가 읽는 주석이 있는 줄은 주석까지 그대로 둔다. 들여쓰기·줄 가운데 공백은 건드리지 않는다(문자열 안의 공백을 바꾸지 않기 위해).
function codeForCompare(src) {
  const text = String(src === null || src === undefined ? "" : src).replace(/\r\n?/g, "\n");
  const original = text.split("\n");
  return stripComments(text).split("\n").map((line, i) => {
    const o = original[i] || "";
    return (o !== line && TOOL_COMMENT_RE.test(o) ? o : line).replace(/\s+$/, "");
  }).filter(Boolean).join("\n");
}

const lineArr = (text) => (text === null ? [] : String(text).replace(/\r\n?/g, "\n").split("\n"));
const unitAt = (units, line) => units.find((u) => u.startLine <= line && u.endLine >= line) || null;

// 함수 머리 줄: 함수 시작 줄부터 첫 "{" 가 나오는 줄까지
function signatureLines(blankLines, units) {
  const set = new Set();
  for (const u of units) for (let l = u.startLine; l <= u.endLine && l <= blankLines.length; l++) { set.add(l); if (blankLines[l - 1].includes("{")) break; }
  return set;
}

// 한 파일의 규칙 검사
function fileFindings(p, oldText, newText, hunks) {
  const out = [];
  if (oldText === null && newText !== null) { out.push({ file: p, kind: "new_file", detail: "기준 커밋에 없던 새 파일 — 파일 전체를 검토", old_line: null, new_line: 1, before: "", after: "" }); return out; }
  if (newText === null) { out.push({ file: p, kind: "removed_file", detail: "파일이 삭제됨", old_line: 1, new_line: null, before: "", after: "" }); return out; }
  const oRaw = lineArr(oldText); const nRaw = lineArr(newText);
  const oBl = lineArr(stripComments(oRaw.join("\n"))); const nBl = lineArr(stripComments(nRaw.join("\n")));
  const ou = trace.cUnits(oRaw.join("\n")).units; const nu = trace.cUnits(nRaw.join("\n")).units;
  const oSig = signatureLines(oBl, ou); const nSig = signatureLines(nBl, nu);
  const funcOf = (o, n) => { const u = (n && unitAt(nu, n.line)) || (o && unitAt(ou, o.line)); return u ? u.name : null; };
  for (const h of hunks) {
    const olds = []; const news = [];
    for (let k = 0; k < h.oldLen; k++) { const line = h.oldStart + k; olds.push({ line, raw: oRaw[line - 1] || "", tk: tokens(oBl[line - 1]) }); }
    for (let k = 0; k < h.newLen; k++) { const line = h.newStart + k; news.push({ line, raw: nRaw[line - 1] || "", tk: tokens(nBl[line - 1]) }); }
    const o2 = olds.filter((x) => !trivial(x.tk)); const n2 = news.filter((x) => !trivial(x.tk));
    for (const [o, n] of pairLines(o2, n2)) {
      const base = { file: p, func: funcOf(o, n), old_line: o ? o.line : null, new_line: n ? n.line : null, before: o ? o.raw.trim() : "", after: n ? n.raw.trim() : "" };
      if (o && n) {
        if (o.tk.join(" ") === n.tk.join(" ")) continue; // 주석·공백만 바뀜
        const macro = n.tk[0] === "#" && n.tk[1] === "define" ? n.tk[2] : null;
        const ctx = { signature: nSig.has(n.line) && oSig.has(o.line) && n.tk.includes("("), macro, decl: isDeclLine(o.tk), branch: isBranchLine(n.tk) || isBranchLine(o.tk) };
        for (const f of classifyPair(o.tk, n.tk, ctx)) out.push(Object.assign({}, base, { kind: f.kind, detail: f.detail, macro: macro || undefined }));
      } else {
        const f = classifyLone((o || n).tk, o ? "old" : "new");
        if (f) out.push(Object.assign({}, base, f));
      }
    }
  }
  return out;
}

// 생성 기록(적용한 것만)과 사람 수정 기록: 파일마다 [{ id, at, sha }] / [{ at, before, after }] (시각 순)
function editHistory(root) {
  const gens = new Map(); const edits = new Map();
  const logDir = path.join(root, "agent-log");
  let names = [];
  try { names = fs.readdirSync(logDir).filter((n) => /^GEN-.+\.json$/.test(n)); } catch (_) { names = []; }
  for (const n of names) {
    let g = null;
    try { g = JSON.parse(fs.readFileSync(path.join(logDir, n), "utf8")); } catch (_) { g = null; }
    if (!g || !g.applied_at || !Array.isArray(g.outputs)) continue;
    for (const o of g.outputs) {
      if (!o || !o.path || o.action === "deleted") continue;
      if (!gens.has(o.path)) gens.set(o.path, []);
      gens.get(o.path).push({ id: g.generation_id || n.replace(/\.json$/, ""), at: g.applied_at, sha: o.sha256 || null });
    }
  }
  for (const list of gens.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let lines = [];
  try { lines = fs.readFileSync(path.join(logDir, "manual-edits.jsonl"), "utf8").split(/\r?\n/).filter(Boolean); } catch (_) { lines = []; }
  for (const l of lines) {
    let e = null;
    try { e = JSON.parse(l); } catch (_) { e = null; }
    if (!e || !e.path) continue;
    if (!edits.has(e.path)) edits.set(e.path, []);
    edits.get(e.path).push({ at: e.at, before: e.before_sha256 || null, after: e.after_sha256 || null, deleted: Boolean(e.deleted) });
  }
  return { gens, edits };
}

// 두 내용의 줄 차이(hunk 머리). 임시 파일에 써서 git diff --no-index 로 구한다.
function diffTexts(a, b) {
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ears-cons-"));
  try {
    const fa = path.join(dir, "a"); const fb = path.join(dir, "b");
    fs.writeFileSync(fa, String(a).replace(/\r\n?/g, "\n")); fs.writeFileSync(fb, String(b).replace(/\r\n?/g, "\n"));
    let out = "";
    try { out = execFileSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "-U0", fa, fb], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }); }
    catch (e) { out = String(e.stdout || ""); }
    const f = hunksOf(out)[0];
    return f ? f.hunks : [];
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// 보관본과 비교한 파일은 코드 변경 영향(함수·호출하는 함수·요구사항 연결)을 그 차이로 다시 정한다.
function rebaseImpact(root, dirs, model, code, refs, readNew) {
  const files = new Set(refs.keys());
  const inRef = (via) => [...files].some((p) => via.startsWith(`${p}:`));
  const fresh = [];
  for (const [p, ref] of refs) {
    const cur = readNew(p);
    const nu = cur === null ? [] : trace.cUnits(cur).units;
    const ou = trace.cUnits(ref.text).units;
    const hunks = cur === null ? [] : diffTexts(ref.text, cur);
    const ranges = (side) => hunks.map((h) => (side === "old" ? [h.oldStart, h.oldLen] : [h.newStart, h.newLen])).filter(([, n]) => n > 0).map(([s, n]) => [s, s + n - 1]);
    const hit = (rs, u) => rs.some(([s, e]) => s <= u.endLine && e >= u.startLine);
    const nr = ranges("new"); const orr = ranges("old");
    const seen = new Set();
    const add = (u, status, prev) => { if (seen.has(u.name)) return; seen.add(u.name); fresh.push({ file: p, func: u.name, status, implements: [...new Set([...(u.implements || []), ...((prev && prev.implements) || [])])], exempt: u.exempt }); };
    for (const u of nu) { const prev = ou.find((x) => x.name === u.name); if (!prev) add(u, "added"); else if (hit(nr, u)) add(u, "modified", prev); }
    for (const u of ou) { if (!nu.some((x) => x.name === u.name)) add(u, "removed"); else if (hit(orr, u)) add(nu.find((x) => x.name === u.name), "modified", u); }
  }
  code.changes.functions = code.changes.functions.filter((f) => !files.has(f.file)).concat(fresh);
  const freshNames = new Set(fresh.map((f) => f.func));
  // 보관본과 비교하지 않는 파일의 바뀐 함수를 부르는 것만 남기고, 보관본 대비 바뀐 함수의 호출자는 아래에서 다시 찾는다
  code.changes.callers = (code.changes.callers || []).filter((c) => code.changes.functions.some((f) => f.func === c.calls && !files.has(f.file)));
  for (const q of code.requirements) q.via = q.via.filter((v) => !inRef(v));
  const touch = (rid, via) => { let q = code.requirements.find((x) => x.id === rid); if (!q) { q = { id: rid, via: [] }; code.requirements.push(q); } if (!q.via.includes(via)) q.via.push(via); };
  const satisfies = (d) => { const x = model.designs.get(d); return x ? x.links.map((l) => l.id) : []; };
  for (const fn of fresh) for (const d of fn.implements) for (const r of satisfies(d)) touch(r, `${fn.file}:${fn.func} → ${d}`);
  let graph = null;
  try { graph = impact.callGraph(root, dirs.code); } catch (_) { graph = null; }
  if (graph) for (const fn of fresh.filter((x) => x.status !== "removed")) for (const up of graph.upstream(fn.func, 3)) {
    if (freshNames.has(up.name) || code.changes.callers.some((c) => c.func === up.name)) continue;
    const unit = model.units.find((u) => u.func === up.name && u.file === up.file);
    code.changes.callers.push({ file: up.file, func: up.name, calls: fn.func, depth: up.depth, chain: up.chain, implements: unit ? unit.implements : [] });
    for (const d of unit ? unit.implements : []) for (const r of satisfies(d)) touch(r, `${up.file}:${up.name} (바뀐 ${fn.func}() 를 호출) → ${d}`);
  }
  code.requirements = code.requirements.filter((q) => q.via.length);
  code.untraced = code.untraced.filter((u) => !files.has(u.split(":")[0])).concat(fresh.filter((f) => f.status !== "removed" && !f.implements.length && f.exempt === null).map((f) => `${f.file}:${f.func}`));
}

const reqIdsOfDesign = (model, designId) => { const d = model.designs.get(designId); return d ? d.links.map((l) => l.id).filter((id) => !id.startsWith("SWD-")) : []; };

// 기준 커밋 이후 바뀐 코드의 규칙 검사 + 관련 요구사항·TC·최근 실행 결과
async function check(root, opts) {
  opts = opts || {};
  const base = opts.base || "HEAD";
  const code = await impact.analyzeCodeImpact(root, { base });
  const baseCommit = code.base.commit;
  const dirs = DIRS;
  let files = hunksOf(git(root, ["diff", "--relative", "--no-color", "--no-ext-diff", "--find-renames", "-U0", baseCommit, "--", ...dirs.code]));
  for (const p of git(root, ["ls-files", "--others", "--exclude-standard", "--", ...dirs.code]).split(/\r?\n/).filter(Boolean)) files.push({ oldPath: null, newPath: p, hunks: [] });
  const readNew = (p) => { try { return fs.readFileSync(path.join(root, p), "utf8"); } catch (_) { return null; } };
  const readCommit = (p) => { try { return git(root, ["show", `${baseCommit}:./${p}`]); } catch (_) { return null; } };

  // 비교 기준(파일마다). auto: 사람이 고치기 전 내용(마지막 AI 생성본, 없으면 편집기에서 처음 고치기 전 내용)이 보관돼 있으면 그것과,
  // 없으면 기준 커밋과 비교한다 — 커밋하지 않은 코드에서도 사람이 바꾼 줄만 본다. commit: 언제나 기준 커밋과.
  const mode = opts.reference === "commit" ? "commit" : "auto";
  const refs = new Map();
  const fallback = [];
  if (mode === "auto") {
    const hist = editHistory(root);
    const isCode = (p) => trace.C_EXT.has(path.extname(p).toLowerCase()) && dirs.code.some((d) => p === d || p.startsWith(d.replace(/\/$/, "") + "/"));
    const candidates = [...new Set([...files.map((f) => f.newPath || f.oldPath), ...hist.gens.keys(), ...hist.edits.keys()])].filter(isCode);
    for (const p of candidates) {
      const gen = (hist.gens.get(p) || []).slice(-1)[0] || null;
      const edits = (hist.edits.get(p) || []).filter((e) => !gen || e.at > gen.at);
      let ref = null;
      if (gen && gen.sha) {
        let t = snapshots.get(root, gen.sha);
        // 보관본이 없어도 지금 내용의 해시가 생성본과 같으면 그대로다(지금 내용을 생성본으로 보관해 둔다)
        if (t === null) { const cur = readNew(p); if (cur !== null && snapshots.sha256(cur) === gen.sha) { t = cur; try { snapshots.put(root, cur); } catch (_) { /* 보관 실패는 비교에 영향 없음 */ } } }
        if (t !== null) ref = { kind: "ai", label: `AI 생성본 (${gen.id})`, sha: gen.sha, at: gen.at, text: t };
      }
      if (!ref) for (const [k, e] of edits.entries()) {
        const t = e.before ? snapshots.get(root, e.before) : null;
        if (t === null) continue;
        ref = { kind: "before_human", label: k === 0 ? "편집기에서 처음 고치기 전 내용" : `편집기에서 ${k + 1}번째로 고치기 전 내용`, sha: e.before, at: e.at, text: t };
        if (k > 0) fallback.push({ file: p, human_edits: k, note: `그보다 앞선 사람 수정 ${k}번은 고치기 전 내용이 보관되어 있지 않아 비교에서 빠졌습니다(내용 보관 기능 이전의 수정).` });
        break;
      }
      if (!ref) {
        if (gen || edits.length) fallback.push({ file: p, human_edits: edits.length, note: edits.length
          ? "사람이 고친 기록은 있지만 고치기 전 내용이 보관되어 있지 않아 기준 커밋과 비교했습니다(내용 보관 기능 이전의 수정). 다음 저장부터는 고치기 전 내용이 남습니다."
          : "AI 생성 뒤 내용이 바뀌었지만 생성본이 보관되어 있지 않아(내용 보관 기능 이전의 생성) 기준 커밋과 비교했습니다." });
        continue;
      }
      refs.set(p, Object.assign(ref, { human_edits: edits.length }));
    }
    if (refs.size) {
      // 보관본과 비교하는 파일은 커밋 대비 차이 대신 보관본 대비 차이를 쓴다
      files = files.filter((f) => !refs.has(f.newPath || f.oldPath));
      for (const [p, ref] of refs) {
        const cur = readNew(p);
        const hunks = diffTexts(ref.text, cur === null ? "" : cur);
        if (cur !== null && !hunks.length) continue; // 생성본(고치기 전)과 같음 — 사람이 바꾼 것 없음
        files.push({ oldPath: p, newPath: cur === null ? null : p, hunks, ref: true });
      }
    }
  }
  const readOld = (p) => (refs.has(p) ? refs.get(p).text : readCommit(p));
  // 사람이 고친 코드만 볼 때(auto)는 커밋 대비 설계 문서·시험 파일 변경(대개 AI 가 만든 것)으로 요구사항을 끌어오지 않는다.
  if (mode === "auto") { for (const q of code.requirements) q.via = q.via.filter((v) => !/^(설계|시험) /.test(v)); code.requirements = code.requirements.filter((q) => q.via.length); }

  const model = trace.collect(root, dirs);
  if (refs.size) rebaseImpact(root, dirs, model, code, refs, readNew);
  const reqsOfFunc = (file, func) => {
    const u = model.units.find((x) => x.file === file && x.func === func);
    const fromCode = code.changes.functions.find((x) => x.file === file && x.func === func);
    const designs = [...new Set([...(u ? u.implements : []), ...(fromCode ? fromCode.implements : [])])];
    return [...new Set(designs.flatMap((d) => (d.startsWith("SWD-") ? reqIdsOfDesign(model, d) : [d])))];
  };
  // 함수 밖 줄(매크로·전역 등): 그 이름을 본문에서 쓰는 함수의 요구사항
  const fileText = new Map();
  const usersOf = (name) => {
    if (!name) return [];
    const re = new RegExp(`\\b${name.replace(/[^\w]/g, "")}\\b`);
    const out = [];
    for (const u of model.units) {
      if (!u.func) continue;
      if (!fileText.has(u.file)) fileText.set(u.file, readNew(u.file) || "");
      const t = fileText.get(u.file);
      const unit = trace.cUnits(t).units.find((x) => x.name === u.func);
      if (unit && re.test(lineArr(trace.blankNonCode(t)).slice(unit.startLine - 1, unit.endLine).join("\n"))) out.push(u);
    }
    return out;
  };

  const findings = [];
  for (const f of files) {
    const p = f.newPath || f.oldPath;
    if (!trace.C_EXT.has(path.extname(p).toLowerCase())) continue;
    for (const x of fileFindings(p, f.oldPath ? readOld(f.oldPath) : null, f.newPath ? readNew(f.newPath) : null, f.hunks)) {
      let reqs = x.func ? reqsOfFunc(p, x.func) : [];
      let usedBy = [];
      if (x.kind === "new_file" || x.kind === "removed_file") {
        // 파일 전체가 새로 생기거나 없어짐: 그 파일의 함수들이 이어진 요구사항
        const fns = code.changes.functions.filter((fn) => fn.file === p);
        reqs = [...new Set(fns.flatMap((fn) => reqsOfFunc(p, fn.func)))];
        usedBy = fns.map((fn) => ({ file: p, func: fn.func }));
      } else if (!x.func) {
        const name = x.macro || (tokens(x.after || x.before).find((t) => isIdent(t) && !KEYWORDS.has(t) && !isType(t) && t !== "define" && t !== "include") || null);
        usedBy = usersOf(name);
        reqs = [...new Set(usedBy.flatMap((u) => reqsOfFunc(u.file, u.func)))];
      }
      findings.push(Object.assign(x, { label: KIND[x.kind][0], severity: KIND[x.kind][1], requirements: reqs, used_by: usedBy.map((u) => `${u.file}:${u.func}`) }));
    }
  }
  findings.forEach((f, i) => { f.id = `F${i + 1}`; });

  // 관련 요구사항: 코드 변경 영향이 찾은 것 + 규칙 검사가 이은 것
  const latest = impact.loadBaselines(root).pop();
  const bl = latest ? latest.baseline : null;
  const reqIds = [...new Set([...code.requirements.map((q) => q.id), ...findings.flatMap((f) => f.requirements)])].filter((id) => !id.startsWith("SWD-")).sort(impact.byId);

  // 그 요구사항을 검증하는 TC(직접 또는 그 요구사항을 만족하는 설계를 거쳐)
  const testsOf = (rid) => [...model.tests.values()].filter((t) => t.links.some((l) => l.id === rid || (l.id.startsWith("SWD-") && reqIdsOfDesign(model, l.id).includes(rid)))).map((t) => t.id).sort(impact.byId);
  let runs = { runs: {}, fp: null };
  const tcRun = require("./tc-run.js");
  try { runs = tcRun.loadRuns(root); } catch (_) { /* 실행 기록 없음 */ }
  // 지금 코드의 지문(소스·시험·Makefile·project.json). 같은 지문이면 같은 코드로 검토·실행한 것이다.
  let fpNow = null;
  try { fpNow = tcRun.fingerprint(require("../ci/verlog.js").sourceHashes(root)); } catch (_) { fpNow = runs.fp || null; }
  let procs = {};
  try { procs = require("../agent/tc-procedures.js").load(root).items || {}; } catch (_) { procs = {}; }
  const sameVal = (a, b) => { const x = Number(a); const y = Number(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)) : String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); };
  const normBool = (v) => (v === true || v === "true" ? "1" : v === false || v === "false" ? "0" : v);
  const evidenceOf = (id) => {
    const r = runs.runs && runs.runs[id];
    const proc = procs[id];
    const mism = [];
    if (r && proc && Array.isArray(r.actual)) for (const a of r.actual) {
      const step = (proc.steps || [])[a.step - 1];
      const exp = step && step.outputs && Object.prototype.hasOwnProperty.call(step.outputs, a.name) ? step.outputs[a.name] : undefined;
      if (exp !== undefined && !sameVal(normBool(a.value), normBool(exp))) mism.push({ step: a.step, name: a.name, expected: exp, actual: a.value });
    }
    return {
      id, result: r ? r.result : null, ran_at: r ? r.ran_at : null, fresh: Boolean(r && r.stale === false), stale: r ? r.stale : null,
      actual: r && Array.isArray(r.actual) ? r.actual.slice(0, 60) : [], mismatches: mism,
      expected: proc ? (proc.steps || []).slice(0, 40).map((s, k) => ({ step: k + 1, t: s.t, inputs: s.inputs || {}, outputs: s.outputs || {} })) : null,
    };
  };
  const requirements = reqIds.map((rid) => {
    const r = bl ? bl.requirements.find((x) => x.requirement_id === rid) : null;
    const tests = testsOf(rid).map(evidenceOf);
    const fails = tests.filter((t) => t.fresh && (t.result === "fail" || t.mismatches.length));
    const notFresh = tests.filter((t) => !t.fresh || (t.result !== "pass" && t.result !== "fail"));
    const prelim = fails.length ? "test_fail" : !tests.length ? "no_tests" : notFresh.length ? "needs_run" : "tests_pass";
    const via = (code.requirements.find((q) => q.id === rid) || { via: [] }).via;
    return {
      id: rid, version: r ? r.version : null, text: r ? r.text : null, acceptance_criteria: r ? r.acceptance_criteria || [] : [], ears_type: r ? r.ears_type || null : null,
      in_baseline: Boolean(r), via, findings: findings.filter((f) => f.requirements.includes(rid)).map((f) => f.id), tests, prelim,
      values: r ? numbersIn([r.text, ...(r.acceptance_criteria || [])].join(" ")) : [],
    };
  });
  // 요구사항 문장에 나오는 값과 바뀐 줄의 값을 맞대어 본다(경계값 관련 여부)
  for (const f of findings) {
    const nums = [...new Set([...tokens(f.before), ...tokens(f.after)].filter(isNum).map(numVal).filter((v) => v !== null))];
    const hits = [];
    for (const rid of f.requirements) {
      const q = requirements.find((x) => x.id === rid);
      if (!q) continue;
      for (const v of nums) for (const k of [1, 10, 100, 1000]) {
        const w = q.values.find((x) => x !== 0 && Math.abs(x * k - v) < 1e-9);
        if (w !== undefined) { hits.push(k === 1 ? `${rid} 의 값 ${w}` : `${rid} 의 값 ${w} (코드 ${v} = ${w}×${k} 배율로 보임)`); break; }
      }
    }
    if (hits.length) f.requirement_values = [...new Set(hits)];
  }

  let head = null; let dirty = null;
  try { head = git(root, ["rev-parse", "HEAD"]).trim(); } catch (_) { head = null; }
  try { dirty = Boolean(git(root, ["status", "--porcelain", "--", ...dirs.code]).trim()); } catch (_) { dirty = null; }
  const rerun = [...new Set(requirements.flatMap((q) => q.tests.map((t) => t.id)))].sort(impact.byId);
  return {
    schema: SCHEMA, checked_at: new Date().toISOString(),
    base: code.base, head: { commit: head, dirty }, fp: fpNow,
    reference: { mode, files: [...refs].map(([file, r]) => ({ file, kind: r.kind, label: r.label, at: r.at, sha: r.sha, human_edits: r.human_edits })), fallback },
    summary: {
      functions: code.changes.functions.length, findings: findings.length, high: findings.filter((f) => f.severity === "high").length,
      requirements: requirements.length, tests: rerun.length, needs_run: requirements.filter((q) => q.prelim === "needs_run").length,
      test_fail: requirements.filter((q) => q.prelim === "test_fail").length, untraced: code.untraced.length,
    },
    functions: code.changes.functions.map((f) => ({ file: f.file, func: f.func, status: f.status, implements: f.implements })),
    callers: (code.changes.callers || []).map((c) => ({ file: c.file, func: c.func, calls: c.calls, depth: c.depth })),
    other: code.changes.other,
    findings, requirements, rerun_tests: rerun, untraced: code.untraced,
  };
}

// 문장 속 숫자(단위 앞 숫자 포함). "75.0 °C" → 75, "100 ms" → 100
function numbersIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?<![\w.])-?\d+(?:\.\d+)?/g)) { const v = Number(m[0]); if (Number.isFinite(v)) out.push(v); }
  return [...new Set(out)];
}

module.exports = { SCHEMA, KIND, check, fileFindings, classifyPair, tokenEdits, tokens, numbersIn, hunksOf, stripComments, codeForCompare, TOOL_COMMENT_RE };
