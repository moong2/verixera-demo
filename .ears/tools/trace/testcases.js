/* 테스트케이스 표: 대상 프로젝트의 시험 코드(tests/)에 있는 시험을 한 줄씩 모은다.
 *
 * 시험마다: ID, 위치, 검증하는 요구사항(@verifies), 도출 방법(@method), 주석에 적힌 시험 내용, 시험 문장,
 * 그리고 그 시험이 들어 있는 가장 최근 검증 기록(verification-log/)의 결과.
 *
 * 결과 뒤에 소스·시험·빌드 설정이 바뀌었으면 outdated 로 알린다(그 결과는 지금 코드의 결과가 아니다).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const view = require("./view.js");
const verlog = require("../ci/verlog.js");

const stripComment = (line) => line.replace(/^\s*(\/\*+|\*+\/?|\/\/+)\s?/, "").replace(/\s*\*+\/\s*$/, "").trim();
const isComment = (line) => /^\s*(\/\*|\*|\/\/)/.test(line) || /\*\/\s*$/.test(line);

// 시험 블록 하나(주석 + 시험 문장)를 읽는다.
function parseBlock(lines) {
  const text = lines.join("\n");
  const verifies = [];
  const designs = []; // 설계 항목(SWD-…)을 검증하는 시험: 요구사항이 아니라 설계·구조를 대상으로 한 시험
  for (const m of text.matchAll(/@verifies\s+([^\n*]+)/g)) {
    for (const ref of m[1].split(/[\s,]+/).filter(Boolean)) {
      const d = /^(SWD-[A-Za-z0-9_.-]+?)(?:@v\d+)?$/.exec(ref);
      if (d) { if (!designs.includes(d[1])) designs.push(d[1]); continue; }
      const r = /^(REQ-[A-Za-z0-9-]+?)(?:@v(\d+))?$/.exec(ref);
      if (r && !verifies.some((v) => v.id === r[1])) verifies.push({ id: r[1], version: r[2] ? Number(r[2]) : null });
    }
  }
  // 검증 수준(@level unit|integration|software)과 대상(@target U-… | INT-… | SW) — TC 표가 수준별로 나눠 보인다
  const lvm = /@level\s+(unit|integration|software)\b/.exec(text);
  const tgm = /@target\s+([A-Za-z0-9_-]+)/.exec(text);
  const mm = /@method\s+([a-z-]+(?:\s*,\s*[a-z-]+)*)/.exec(text);
  const methods = mm ? mm[1].split(/\s*,\s*/) : [];
  const description = [];
  const check = [];
  let inComment = false;
  for (const line of lines) {
    const opens = /\/\*/.test(line);
    const comment = inComment || isComment(line);
    if (opens && !/\*\//.test(line)) inComment = true;
    else if (/\*\//.test(line)) inComment = false;
    if (comment) {
      const t = stripComment(line);
      if (t && !t.startsWith("@")) description.push(t);
    } else if (line.trim()) check.push(line.trim());
  }
  return Object.assign(lvm ? { level: lvm[1] } : {}, tgm ? { target: tgm[1] } : {}, { verifies, designs, methods, description: description.join(" ").slice(0, 500), check: check.slice(0, 4).join("\n").slice(0, 400) });
}

const changedSince = verlog.changedSince;

function table(root) {
  const runs = verlog.list(root);
  const current = verlog.sourceHashes(root);
  const currentCode = verlog.codeHashes(root);
  const staleByRun = new Map();
  const lastResult = (tcId) => {
    for (let i = runs.length - 1; i >= 0; i--) {
      const e = runs[i];
      let found = null;
      let level = null;
      for (const q of e.record.requirements || []) for (const t of q.tests || []) if (t.tc_id === tcId) { found = t.result; level = t.level ? { level: t.level, target: t.target || null } : level; }
      if (!found) continue;
      if (!staleByRun.has(e.file)) staleByRun.set(e.file, verlog.staleness(e.record, current, currentCode));
      const f = (e.record.failures || []).find((x) => x.tc_id === tcId);
      return {
        // outdated: 그 결과 뒤에 코드·시험·빌드 설정이 바뀌었는가(주석만 바뀐 것은 아니다 — comments_changed 로 따로 알린다)
        result: found, outdated: staleByRun.get(e.file) === null ? null : staleByRun.get(e.file) === "changed", ...(staleByRun.get(e.file) === "comments" ? { comments_changed: true } : {}),
        run: { file: e.file, started_at: e.record.started_at, source: e.record.source, pinned: Boolean(e.record.environment && e.record.environment.pinned), commit: e.record.commit || null, baseline_id: e.record.baseline_id || null },
        failure: f ? { cause: f.ai ? f.ai.cause : null, explanation: f.ai ? f.ai.explanation : "", output: (f.output || []).slice(0, 4) } : null,
        // 그 실행의 단계별 실제 출력(시나리오 타임라인)과 검증 수준
        ...(e.record.actuals && Array.isArray(e.record.actuals[tcId]) ? { actual: e.record.actuals[tcId] } : {}),
        ...(level ? { level: level.level, target: level.target } : {}),
      };
    }
    return null;
  };

  const testcases = [];
  const seen = new Set();
  const dir = path.join(root, "tests");
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.(c|h)$/.test(n)).sort() : [];
  for (const name of names) {
    const lines = fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n?/g, "\n").split("\n");
    for (const b of view.testBlocks(lines)) {
      if (seen.has(b.id)) continue; // 중복 선언은 추적성 점검(T8)이 알린다
      seen.add(b.id);
      const last = lastResult(b.id);
      testcases.push(Object.assign({ id: b.id, file: `tests/${name}`, startLine: b.startLine, endLine: b.endLine },
        parseBlock(lines.slice(b.startLine - 1, b.endLine)),
        last || { result: null, outdated: null, run: null, failure: null }));
    }
  }
  return { testcases, runs: runs.length, designs: designItems(root) };
}

// 설계 문서의 설계 항목과 그것이 만족하는 요구사항(직접 입력에서 구조 기반 TC 의 대상으로 고른다)
function designItems(root) {
  try {
    const model = require("./trace-check.js").collect(root, { design: ["docs/design"], code: [], tests: [] });
    return [...model.designs.values()].map((d) => ({ id: d.id, file: d.file, line: d.line, requirements: [...new Set(d.links.map((l) => l.id))] }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch (_) { return []; }
}

module.exports = { table, parseBlock, designItems };
