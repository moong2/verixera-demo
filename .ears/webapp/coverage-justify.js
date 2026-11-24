/* 커버리지 정당화: 실행되지 않은 줄·가지 않은 분기·확인되지 않은 조건을 사람이 근거를 남겨 '유효'로 본 것을 반영한다.
 * 실측(측정값)은 바꾸지 않고, 정당화한 것을 더한 '유효 커버리지'를 따로 계산한다.
 * 브라우저(화면 미리 보기)와 Node(게이트)가 같은 계산을 쓴다.
 */
(() => {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;

  const KINDS = Object.freeze({ statement: "실행 안 된 줄", branch: "가지 않은 분기", mcdc: "확인 안 된 조건(MC/DC)" });
  const pct = (covered, total) => (total ? Math.floor((covered / total) * 1000) / 10 : 100);
  // 줄 비교용: 주석·공백 차이는 같은 줄로 본다
  const normLine = (t) => String(t || "").replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, " ").replace(/\s+/g, " ").trim();

  // 파일 한 개에서, 정당화한 것이 실제로 미달인 경우만 센다.
  // entries: [{ file, line, kind }] (지금 코드 기준 줄 번호)
  function countFile(f, entries) {
    const mine = entries.filter((e) => e.file === f.file);
    const got = { statement: [], branch: [], mcdc: [] };
    const n = { statement: 0, branch: 0, mcdc: 0 };
    for (const e of mine) {
      if (e.kind === "statement" && (f.uncovered_lines || []).includes(e.line) && !got.statement.includes(e.line)) { got.statement.push(e.line); n.statement += 1; }
      if (e.kind === "branch") { const b = (f.uncovered_branches || []).find((x) => x.line === e.line); if (b && !got.branch.includes(e.line)) { got.branch.push(e.line); n.branch += b.missed; } }
      if (e.kind === "mcdc") { const c = (f.uncovered_conditions || []).find((x) => x.line === e.line); if (c && !got.mcdc.includes(e.line)) { got.mcdc.push(e.line); n.mcdc += c.missed; } }
    }
    return { lines: got, count: n };
  }

  const eff = (m, add) => (m ? { covered: Math.min(m.total, m.covered + add), total: m.total, percent: pct(Math.min(m.total, m.covered + add), m.total) } : null);

  // 측정 결과(cov)에 정당화를 더한 결과. cov 는 바꾸지 않는다.
  // 반환: cov 의 복사본 + justified{statement,branch,mcdc}(정당화로 더한 수) + effective{…}(유효 커버리지) + 파일마다 같은 값
  function apply(cov, entries) {
    if (!cov || !cov.statement || !Array.isArray(cov.files)) return cov;
    const list = Array.isArray(entries) ? entries : [];
    const total = { statement: 0, branch: 0, mcdc: 0 };
    const files = cov.files.map((f) => {
      const c = countFile(f, list);
      for (const k of Object.keys(total)) total[k] += c.count[k];
      return Object.assign({}, f, {
        justified: c.count, justified_lines: c.lines,
        effective: { statement: eff(f.statement, c.count.statement), branch: eff(f.branch, c.count.branch), mcdc: f.mcdc && f.mcdc.total ? eff(f.mcdc, c.count.mcdc) : null },
      });
    });
    return Object.assign({}, cov, {
      files, justified: total,
      effective: Object.assign({ statement: eff(cov.statement, total.statement), branch: eff(cov.branch, total.branch) }, cov.mcdc ? { mcdc: eff(cov.mcdc, total.mcdc) } : {}),
    });
  }

  // 정당화 사유의 분류(근거 글과 함께 남긴다)
  const CATEGORIES = Object.freeze({
    defensive: "방어 코드 — 정상 동작에서는 도달하지 않음",
    unreachable: "도달 불가 — 설계나 앞선 검사로 막혀 있음",
    environment: "하드웨어·환경 의존 — 이 시험 환경에서 만들 수 없음",
    other_level: "다른 수준에서 검증 — 통합·시스템 시험, 검토",
    other: "기타",
  });
  const api = Object.freeze({ KINDS, CATEGORIES, apply, normLine, pct });
  root.EarsCoverageJustify = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
