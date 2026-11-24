/* 프로젝트 설정(project.json)에 따른 점검: 코딩 규칙과 시험 도출 방법 표기.
 *
 * 컴파일러 없이 소스만 읽어서 판단하는 것만 맡는다. 형 변환·초기화·이름 겹침은 컴파일 경고로(config.cflags),
 * 포인터 제한·숨은 흐름·MISRA 전반은 자동 확인 수단이 없어 AI 지시와 사람 검토에 맡긴다(not_checked 로 알린다).
 *
 * 결과: { findings: [{ rule, level: "error"|"warning", message, where }], checked: [...], not_checked: [...], exemptions: [...] }
 *  - 등급이 required 인 규칙을 어기면 error(게이트 실패), recommended 면 warning.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const trace = require("../trace/trace-check.js");
const view = require("../trace/view.js");
const project = require("./config.js");

const RULE_CODE = { single_exit: "C-EXIT", no_dynamic_memory: "C-DYN", limit_globals: "C-GLOB", no_goto: "C-GOTO", no_recursion: "C-REC" };
const listFiles = (root, dir, re) => {
  const full = path.join(root, dir);
  return fs.existsSync(full) ? fs.readdirSync(full).filter((n) => re.test(n)).sort().map((n) => `${dir}/${n}`) : [];
};
const readText = (root, rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8").replace(/\r\n?/g, "\n");

function checkSource(root, config, findings) {
  const level = (id) => (config.coding_rules[id] === "required" ? "error" : config.coding_rules[id] === "recommended" ? "warning" : null);
  const add = (id, message, where) => { const lv = level(id); if (lv) findings.push({ rule: RULE_CODE[id], level: lv, message, where }); };
  for (const rel of listFiles(root, "src", /\.(c|h)$/)) {
    const src = readText(root, rel);
    const code = trace.blankNonCode(src); // 주석과 문자열을 지운 사본(줄 수는 같다)
    const lines = code.split("\n");
    const units = trace.cUnits(src).units;
    const inFunction = new Array(lines.length + 2).fill(false);
    for (const u of units) {
      for (let n = u.startLine; n <= u.endLine; n++) inFunction[n] = true;
      const body = lines.slice(u.startLine - 1, u.endLine).join("\n");
      const open = body.indexOf("{");
      const inner = open >= 0 ? body.slice(open) : body;
      const returns = (inner.match(/\breturn\b/g) || []).length;
      if (returns > 1) add("single_exit", `${u.name}(): return 문이 ${returns}개 — 함수의 출구는 하나여야 함`, `${rel}:${u.startLine}`);
      if (new RegExp(`\\b${u.name}\\s*\\(`).test(inner)) add("no_recursion", `${u.name}(): 자기 자신을 호출함(재귀)`, `${rel}:${u.startLine}`);
    }
    let depth = 0;
    lines.forEach((line, i) => {
      const n = i + 1;
      let m = /\b(malloc|calloc|realloc|free|alloca|aligned_alloc)\s*\(/.exec(line);
      if (m) add("no_dynamic_memory", `${m[1]}() 호출 — 동적 메모리를 쓰지 않아야 함`, `${rel}:${n}`);
      m = /\b(goto)\b|\b(setjmp|longjmp)\s*\(/.exec(line);
      if (m) add("no_goto", `${m[1] || m[2]} 사용 — 무조건 분기를 쓰지 않아야 함`, `${rel}:${n}`);
      // 파일 범위(중괄호 밖)의 한 줄 변수 정의. 상수(const)·형 정의·함수 선언·extern 선언·전처리 줄은 제외한다.
      if (depth === 0 && !inFunction[n] && rel.endsWith(".c")) {
        const t = line.trim();
        if (/^[A-Za-z_][\w\s*]*\b[A-Za-z_]\w*\s*(\[[^\]]*\])*\s*(=[^;]*)?;$/.test(t) && !/\(/.test(t) && !/^(typedef|extern|struct|union|enum|return)\b/.test(t) && !/\bconst\b/.test(t)) {
          add("limit_globals", `전역 변수 정의: ${t.replace(/\s+/g, " ").slice(0, 60)}`, `${rel}:${n}`);
        }
      }
      for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth = Math.max(0, depth - 1); }
    });
  }
}

// 시험 주석의 @method(도출 방법) 표기를 읽고, 요구사항별로 필수 방법이 빠졌는지 본다.
function checkTests(root, config, findings, exemptions) {
  const methods = project.TEST_METHODS.filter((m) => project.on(config.test_design[m.id]));
  if (!methods.length) return;
  const tags = new Map(project.TEST_METHODS.map((m) => [m.tag, m]));
  const anyRequired = methods.some((m) => config.test_design[m.id] === "required");
  const used = new Map(); // 요구사항 → 그 요구사항의 시험에 쓰인 방법 태그
  const reqOfTests = new Set();
  const skip = new Map(); // "요구사항|태그" → 사유
  const tagged = new Set(); // 도출 방법이 표기된 시험이 하나라도 있는 요구사항
  for (const rel of listFiles(root, "tests", /\.(c|h)$/)) {
    const lines = readText(root, rel).split("\n");
    lines.forEach((line, i) => {
      const m = /@no-method\s+([a-z-]+)\s+(REQ-[A-Za-z0-9-]+)\s*:\s*(.*\S)?/.exec(line);
      if (!m) return;
      const reason = (m[3] || "").replace(/\*\/\s*$/, "").trim();
      if (!tags.has(m[1])) findings.push({ rule: "M2", level: "error", message: `알 수 없는 시험 도출 방법: ${m[1]}`, where: `${rel}:${i + 1}` });
      else if (!reason) findings.push({ rule: "M3", level: "error", message: `${m[2]}: ${tags.get(m[1]).label} 을 적용하지 않는 사유가 비어 있음`, where: `${rel}:${i + 1}` });
      else { skip.set(`${m[2]}|${m[1]}`, reason); exemptions.push({ requirement: m[2], method: m[1], reason, where: `${rel}:${i + 1}` }); }
    });
    for (const b of view.testBlocks(lines)) {
      const text = lines.slice(b.startLine - 1, b.endLine).join("\n");
      const reqs = [...text.matchAll(/@verifies\s+([^\n*]+)/g)].flatMap((m) => m[1].split(/[\s,]+/)).map((x) => x.replace(/@v\d+$/, "")).filter((x) => /^REQ-/.test(x));
      for (const q of reqs) { reqOfTests.add(q); if (!used.has(q)) used.set(q, new Set()); }
      const m = /@method\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)/.exec(text);
      if (!m) {
        findings.push({ rule: "M1", level: anyRequired ? "error" : "warning", message: `${b.id}: 시험 도출 방법 표기(@method)가 없음`, where: `${rel}:${b.startLine}` });
        continue;
      }
      for (const tag of m[1].split(/\s*,\s*/)) {
        if (!tags.has(tag)) { findings.push({ rule: "M2", level: "error", message: `${b.id}: 알 수 없는 시험 도출 방법 "${tag}" (쓸 수 있는 값: ${[...tags.keys()].join(", ")})`, where: `${rel}:${b.startLine}` }); continue; }
        for (const q of reqs) { used.get(q).add(tag); tagged.add(q); }
      }
    }
  }
  for (const q of [...reqOfTests].sort()) {
    for (const m of methods) {
      if (!tagged.has(q) || config.test_design[m.id] !== "required" || used.get(q).has(m.tag) || skip.has(`${q}|${m.tag}`)) continue;
      findings.push({ rule: "M3", level: "warning", message: `${q}: 필수 도출 방법 '${m.label}'(@method ${m.tag})으로 만든 시험이 없음 — 시험을 추가하거나 @no-method ${m.tag} ${q}: <사유> 를 남길 것`, where: "tests/" });
    }
  }
}

function check(root, config) {
  const findings = [];
  const exemptions = [];
  checkSource(root, config, findings);
  checkTests(root, config, findings, exemptions);
  const active = project.CODING_RULES.filter((r) => project.on(config.coding_rules[r.id]));
  const order = (f) => `${f.where} ${f.rule}`;
  findings.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return {
    findings, exemptions,
    checked: active.filter((r) => r.check === "source").map((r) => r.label),
    by_compiler: active.filter((r) => r.check === "compiler").map((r) => r.label),
    not_checked: active.filter((r) => r.check === "review").map((r) => r.label),
  };
}

module.exports = { check, RULE_CODE };
