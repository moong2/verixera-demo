/* TC 하나를 실행한 커버리지(줄 횟수·분기 갈래·조건)와 소스를 보고, 결정(if·while·for·조건식)마다
 * 참(T)·거짓(F) 중 어느 쪽으로 갔는지와 조건별로 결정을 좌우한 값(MC/DC)을 정리한다.
 *
 * 참·거짓을 정하는 방법(how):
 *  - "block": if/while/for 의 조건 바로 아래 블록 첫 줄이 실행된 횟수로 센다. 참 = 블록 횟수, 거짓 = 결정 줄 횟수 − 블록 횟수. 정확하다.
 *  - "branch": 블록을 찾지 못하면(같은 줄에 몸통이 있는 등) gcov 의 두 갈래(이어서 들어감 = 참)로 추정한다.
 *  - null: 갈래가 셋 이상이고 블록도 찾지 못하면 정하지 않는다.
 * 조건(MC/DC, gcc -fcondition-coverage): 이 실행에서 조건 i 의 참/거짓 값이 결정을 좌우한 것으로 확인됐는지(가림 MC/DC).
 */
"use strict";

// 문자열·문자·주석을 같은 길이의 빈칸으로 바꾼다(괄호·연산자 위치를 그대로 두고 찾기 위해).
function blank(src) {
  let out = ""; let i = 0;
  while (i < src.length) {
    const c = src[i]; const d = src[i + 1];
    if (c === "/" && d === "*") { const j = src.indexOf("*/", i + 2); const end = j < 0 ? src.length : j + 2; out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === "/" && d === "/") { const j = src.indexOf("\n", i); const end = j < 0 ? src.length : j; out += " ".repeat(end - i); i = end; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") j++; j++; } const end = Math.min(src.length, j + 1); out += c + " ".repeat(Math.max(0, end - i - 2)) + (end - i >= 2 ? c : ""); i = end; continue; }
    out += c; i++;
  }
  return out;
}

// 조건식을 낱낱의 조건으로(최상위가 아니어도 && / || 로 나눈다 — gcc 가 조건 번호를 매기는 순서와 같다)
function atoms(expr) {
  const masked = blank(expr);
  const parts = []; let start = 0;
  for (let i = 0; i < masked.length - 1; i++) {
    const two = masked.slice(i, i + 2);
    if (two === "&&" || two === "||") { parts.push(expr.slice(start, i)); start = i + 2; i++; }
  }
  parts.push(expr.slice(start));
  const opens = (t) => (blank(t).match(/\(/g) || []).length;
  const closes = (t) => (blank(t).match(/\)/g) || []).length;
  const strip = (s) => {
    let t = s.trim();
    while (/^\(/.test(t) && opens(t) > closes(t)) t = t.slice(1).trim();
    while (/\)$/.test(t) && closes(t) > opens(t)) t = t.slice(0, -1).trim();
    while (/^\(.*\)$/.test(t) && balanced(blank(t.slice(1, -1)))) t = t.slice(1, -1).trim();
    return t;
  };
  return parts.map(strip).filter(Boolean);
}
function balanced(s) { let d = 0; for (const c of s) { if (c === "(") d++; else if (c === ")") { d--; if (d < 0) return false; } } return d === 0; }

// lines: 소스 줄 배열(0부터). L: 결정 줄(1부터). 조건식 글과 끝 위치, 몸통 시작 줄을 찾는다.
function decisionShape(lines, L) {
  const text = lines.slice(L - 1).join("\n");
  const masked = blank(text);
  const m = /\b(if|while|for|switch)\s*\(/.exec(masked.split("\n")[0]);
  if (!m) return { kind: "expr", expr: lines[L - 1].trim() };
  let i = m.index + m[0].length; let depth = 1;
  while (i < masked.length && depth) { if (masked[i] === "(") depth++; else if (masked[i] === ")") depth--; i++; }
  if (depth) return { kind: m[1], expr: lines[L - 1].trim() };
  let expr = text.slice(m.index + m[0].length, i - 1);
  if (m[1] === "for") { const ps = blank(expr).split(";"); expr = ps.length === 3 ? expr.slice(ps[0].length + 1, ps[0].length + 1 + ps[1].length) : expr; }
  const endLine = L + (masked.slice(0, i).match(/\n/g) || []).length; // 조건이 끝나는 줄(1부터)
  const rest = masked.slice(i).split("\n")[0].trim();
  return { kind: m[1], expr: expr.replace(/\s+/g, " ").trim(), endLine, sameLineBody: Boolean(rest) && rest !== "{" };
}

function analyze(source, file) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const count = new Map((file.lines || []).map((x) => [x.line, x.count]));
  const conds = new Map();
  for (const c of file.condition_detail || []) { if (!conds.has(c.line)) conds.set(c.line, []); conds.get(c.line).push(c); }
  const lineSet = new Set([...(file.branch_detail || []).map((b) => b.line), ...conds.keys()]);
  const out = [];
  for (const L of [...lineSet].sort((a, b) => a - b)) {
    const n = count.get(L) || 0;
    if (!n) continue; // 실행되지 않은 결정
    const shape = decisionShape(lines, L);
    if (shape.kind === "switch") continue;
    const br = (file.branch_detail || []).find((b) => b.line === L);
    let t = null; let f = null; let how = null;
    if ((shape.kind === "if" || shape.kind === "while" || shape.kind === "for") && !shape.sameLineBody && shape.endLine) {
      const next = [...count.keys()].filter((k) => k > shape.endLine).sort((a, b) => a - b)[0];
      if (next) { const body = count.get(next) || 0; t = body; f = Math.max(0, n - body); how = "block"; }
    }
    if (how === null && br && br.outcomes.length === 2) {
      const enter = br.outcomes.find((o) => o.fallthrough === true) || br.outcomes[0];
      const skip = br.outcomes.find((o) => o !== enter);
      t = enter.count; f = skip ? skip.count : 0; how = "branch";
    }
    const cd = (conds.get(L) || [])[0] || null; // 한 줄에 결정이 여럿이면 첫 결정만(드묾)
    let conditions = null;
    if (cd && cd.conditions > 0) {
      const names = atoms(shape.expr || "");
      const miss = new Set(cd.missing);
      conditions = Array.from({ length: cd.conditions }, (_, i) => ({ index: i, text: names.length === cd.conditions ? names[i] : `조건 ${i + 1}`, t: !miss.has(`t${i}`), f: !miss.has(`f${i}`) }));
    }
    out.push({ line: L, expr: shape.expr || "", kind: shape.kind, evaluated: n, t, f, how, conditions });
  }
  return out;
}

module.exports = { analyze, atoms, decisionShape, blank };
