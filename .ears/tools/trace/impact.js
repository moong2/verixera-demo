#!/usr/bin/env node
/* 변경 영향도 분석.
 *
 * 1) 요구사항 변경 영향: 두 Baseline 을 비교해 바뀐 요구사항과 바뀐 항목을 찾고,
 *    추적 태그로 그 요구사항에 연결된 설계 항목·함수·시험과 각각의 조치를 알려 준다.
 * 2) 코드 변경 영향: 기준 커밋 이후 바뀐 함수·설계 항목·시험이 어느 요구사항에 닿는지,
 *    다시 실행해야 할 시험이 무엇인지 알려 준다.
 *
 * 파일을 수정하지 않는다. 태그 규칙은 TAG_RULES.md, 추적 점검은 trace-check.js 를 본다.
 *
 * 사용법:
 *   node tools/trace/impact.js --root <대상> [--from BL-001] [--to BL-002]
 *   node tools/trace/impact.js --root <대상> --code [--base HEAD]
 * 종료 코드: 0 분석 완료, 2 실행 조건 오류.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const trace = require("./trace-check.js");
const baselineApi = require("../../webapp/baseline.js");

const { UsageError } = trace;
const DEFAULT_DIRS = { design: ["docs/design"], code: ["src"], tests: ["tests"] };
const CONTENT_FIELDS = [
  ["text", "요구사항 문장"],
  ["ears_type", "EARS 유형"],
  ["parent", "상위 요구사항"],
  ["acceptance_criteria", "수용 기준"],
];

// ID 정렬. 실행 환경의 로캘에 따라 결과가 달라지지 않도록 localeCompare 를 쓰지 않는다.
// 숫자 구간은 수치로, 나머지는 UTF-16 코드 단위로 비교한다 (REQ-2 < REQ-10).
// 값이 같고 앞자리 0만 다른 경우(1 과 01)는 나머지를 모두 비교한 뒤 짧은 쪽을 앞에 둔다.
function byId(a, b) {
  const pa = String(a).split(/(\d+)/);
  const pb = String(b).split(/(\d+)/);
  let tie = 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] === undefined ? "" : pa[i];
    const y = pb[i] === undefined ? "" : pb[i];
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const nx = x.replace(/^0+(?=\d)/, "");
      const ny = y.replace(/^0+(?=\d)/, "");
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
      if (!tie) tie = x.length - y.length;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return tie;
}
const uniq = (arr) => [...new Set(arr)];
const dirsOf = (opts) => ({
  design: (opts && opts.design) || DEFAULT_DIRS.design,
  code: (opts && opts.code) || DEFAULT_DIRS.code,
  tests: (opts && opts.tests) || DEFAULT_DIRS.tests,
});

// ───────────────────────── Baseline 불러오기 ─────────────────────────

function loadBaselines(root) {
  const dir = path.join(root, "requirements", "baseline");
  const list = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith(".baseline.json")) continue;
    let b;
    try { b = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch (_) { continue; }
    const m = /^BL-(\d+)$/.exec((b && b.baseline_id) || "");
    if (!m) continue;
    // 고정본의 요구사항 목록이 깨져 있으면(목록이 아님 · 항목이 객체가 아님 · ID 없음) 어느 파일인지 알리고 멈춘다.
    // 건너뛰지 않는다: 고정본이 조용히 빠지면 추적·영향 결과가 달라진다.
    const bad = trace.baselineShapeProblem(b);
    if (bad) throw trace.brokenBaseline(`requirements/baseline/${name}`, bad);
    list.push({ n: parseInt(m[1], 10), file: `requirements/baseline/${name}`, baseline: b });
  }
  return list.sort((a, b) => a.n - b.n);
}

async function verified(entry) {
  const v = await baselineApi.verifyBaseline(entry.baseline);
  if (!v.ok) throw new UsageError(`고정본 파일이 손상되었거나 수정됨: ${entry.file} — ${v.errors.join("; ")}`);
  return entry.baseline;
}

// ───────────────────────── 요구사항 변경 영향 ─────────────────────────

// 두 Baseline 의 요구사항을 비교한다. fromB 가 없으면 모든 요구사항이 신규다.
function diffRequirements(fromB, toB) {
  const before = new Map((fromB ? fromB.requirements : []).map((r) => [r.requirement_id, r]));
  const after = new Map(toB.requirements.map((r) => [r.requirement_id, r]));
  const items = [];
  for (const id of uniq([...before.keys(), ...after.keys()]).sort(byId)) {
    const a = before.get(id);
    const b = after.get(id);
    const base = { id, summary: (b || a).summary || "", from_version: a ? a.version : null, to_version: b ? b.version : null, fields: [] };
    if (!a) items.push(Object.assign(base, { change: "added" }));
    else if (!b) items.push(Object.assign(base, { change: "removed" }));
    else if (a.content_hash === b.content_hash) items.push(Object.assign(base, { change: "unchanged" }));
    else {
      base.fields = CONTENT_FIELDS
        .filter(([k]) => baselineApi.canonicalize(a[k]) !== baselineApi.canonicalize(b[k]))
        .map(([field, label]) => ({ field, label, before: a[field], after: b[field] }));
      items.push(Object.assign(base, { change: "modified" }));
    }
  }
  return items;
}

const SIGNAL_FIELDS = [
  ["direction", "방향"], ["type", "자료형"], ["unit", "단위"], ["min", "최소"], ["max", "최대"], ["initial", "초기값"], ["description", "설명"], ["requirements", "쓰는 요구사항"],
];

// 두 Baseline 의 신호 표를 비교하고, 바뀐 신호를 설계 문서의 어디가 선언(@signal)하고 있는지 찾는다.
function diffSignals(fromB, toB, model) {
  const list = (b) => (b && Array.isArray(b.signals) ? b.signals : []);
  const before = new Map(list(fromB).map((s) => [s.name, s]));
  const after = new Map(list(toB).map((s) => [s.name, s]));
  const out = [];
  for (const name of uniq([...before.keys(), ...after.keys()]).sort()) {
    const a = before.get(name);
    const b = after.get(name);
    if (a && b && a.content_hash === b.content_hash) continue;
    const change = !a ? "added" : !b ? "removed" : "modified";
    const fields = a && b ? SIGNAL_FIELDS.filter(([k]) => baselineApi.canonicalize(a[k]) !== baselineApi.canonicalize(b[k])).map(([field, label]) => ({ field, label, before: a[field], after: b[field] })) : [];
    const declared = (model.signalRefs || []).filter((r) => r.id === name).map((r) => ({
      file: r.file, line: r.line, linked_version: r.version,
      state: change === "removed" ? "표에서 빠진 신호" : r.version === b.version ? "반영됨" : "재확인 필요",
    }));
    const requirements = uniq([...(a ? a.requirements : []), ...(b ? b.requirements : [])]).sort(byId);
    const pending = declared.filter((d) => d.state !== "반영됨").length;
    out.push({
      name, change, from_version: a ? a.version : null, to_version: b ? b.version : null, fields, requirements, declared,
      action: change === "added" ? "새 신호 — 이 신호를 쓰는 설계의 인터페이스 절에 @signal 로 선언"
        : change === "removed" ? (declared.length ? "표에서 빠진 신호 — 설계·코드·시험에서 쓰는 곳을 제거하거나 다른 신호로 바꿈" : "표에서 빠진 신호 — 선언한 설계 없음")
          : pending ? `바뀐 신호 — 이 신호를 쓰는 설계·코드·시험(${requirements.join(", ") || "연결된 요구사항 없음"})을 바뀐 자료형·단위·범위에 맞게 확인한 뒤 태그를 @v${b.version} 으로 갱신`
            : declared.length ? "바뀐 신호 — 선언한 설계가 모두 새 버전으로 갱신됨" : "바뀐 신호 — 선언한 설계가 아직 없음",
    });
  }
  return out;
}

const linkState = (item, version) => {
  if (item.change === "removed") return "근거 요구사항 삭제됨";
  if (version === null) return "버전 없음";
  return version === item.to_version ? "반영됨" : "재확인 필요";
};

function actionFor(item, designs, tests) {
  if (item.change === "added") {
    // 처음 고정한 요구사항이라도 이미 연결된 산출물이 있으면 "만들어야 함"이 아니다. 무엇이 있고 무엇이 없는지 말한다.
    const pending = designs.filter((d) => d.state !== "반영됨").length + tests.filter((t) => t.state !== "반영됨").length;
    if (!designs.length && !tests.length) return "새 요구사항 — 설계·코드·시험을 만들어야 함";
    if (pending) return `새 요구사항 — 연결된 설계·시험 가운데 ${pending}개가 이 버전을 가리키지 않음, 확인 필요`;
    if (!designs.length) return "새 요구사항 — 시험은 연결됨, 설계·코드를 만들어야 함";
    if (!tests.length) return "새 요구사항 — 설계·코드는 연결됨, 시험을 만들어야 함";
    return "새 요구사항 — 설계·코드·시험이 이미 연결되어 있음";
  }
  if (item.change === "removed") {
    return designs.length || tests.length
      ? "삭제된 요구사항 — 연결된 설계·코드·시험을 제거하거나 다른 요구사항에 다시 연결"
      : "삭제된 요구사항 — 연결된 산출물 없음";
  }
  const pending = designs.filter((d) => d.state !== "반영됨").length + tests.filter((t) => t.state !== "반영됨").length;
  if (!designs.length && !tests.length) return "변경된 요구사항 — 연결된 산출물이 아직 없음";
  return pending
    ? `변경된 요구사항 — 설계·코드와 시험의 기대 결과를 바뀐 내용에 맞게 확인한 뒤 태그를 @v${item.to_version} 으로 갱신`
    : "변경된 요구사항 — 연결된 설계·시험이 모두 새 버전으로 갱신됨";
}

// 바뀐 요구사항마다 연결된 설계 항목·함수·시험을 찾는다.
function artifactImpact(model, items, fromB, toB) {
  const reqOf = (id) => toB.requirements.find((r) => r.requirement_id === id) || (fromB && fromB.requirements.find((r) => r.requirement_id === id));
  const result = [];
  for (const item of items.filter((i) => i.change !== "unchanged")) {
    const designs = [...model.designs.values()]
      .filter((d) => d.links.some((l) => l.id === item.id))
      .map((d) => {
        const v = d.links.find((l) => l.id === item.id).version;
        return { id: d.id, file: d.file, line: d.line, linked_version: v, state: linkState(item, v) };
      });
    const designIds = new Set(designs.map((d) => d.id));
    const functions = model.units
      .filter((u) => u.implements.some((x) => designIds.has(x)))
      .map((u) => ({ file: u.file, func: u.func, line: u.line, via: u.implements.filter((x) => designIds.has(x)) }));
    const tests = [...model.tests.values()]
      .filter((t) => t.links.some((l) => l.id === item.id || designIds.has(l.id)))
      .map((t) => {
        const direct = t.links.find((l) => l.id === item.id);
        const v = direct ? direct.version : null;
        return { id: t.id, file: t.file, line: t.line, linked_version: v, via: direct ? item.id : t.links.find((l) => designIds.has(l.id)).id, state: direct ? linkState(item, v) : "설계 항목을 통해 영향" };
      });
    // 같은 함수를 쓰는 다른 요구사항: 이 요구사항 때문에 그 함수가 바뀌면 그쪽 시험도 다시 돌려야 한다(태그는 그대로 둔다).
    const ownTests = new Set(tests.map((t) => t.id));
    const sharedDesigns = new Set();
    for (const u of model.units.filter((x) => x.implements.some((d) => designIds.has(d)))) for (const d of u.implements) if (!designIds.has(d)) sharedDesigns.add(d);
    const sharedReqs = new Map(); // 요구사항 → 그 요구사항으로 이어지는 공유 함수
    for (const d of sharedDesigns) {
      const design = model.designs.get(d);
      if (!design) continue;
      const via = model.units.filter((u) => u.implements.includes(d) && u.implements.some((x) => designIds.has(x))).map((u) => (u.func ? `${u.file}:${u.func}` : u.file));
      for (const l of design.links) if (l.id !== item.id) sharedReqs.set(l.id, [...new Set([...(sharedReqs.get(l.id) || []), ...via])]);
    }
    const related_tests = [...model.tests.values()]
      .filter((t) => !ownTests.has(t.id) && t.links.some((l) => sharedReqs.has(l.id) || sharedDesigns.has(l.id)))
      .map((t) => { const l = t.links.find((x) => sharedReqs.has(x.id) || sharedDesigns.has(x.id)); return { id: t.id, file: t.file, line: t.line, requirement: l.id, via: sharedReqs.get(l.id) || [] }; })
      .sort((a, b) => byId(a.id, b.id));
    const req = reqOf(item.id);
    const children = toB.requirements.filter((r) => r.parent === item.id).map((r) => r.requirement_id).sort(byId);
    result.push(Object.assign({}, item, {
      parent: req ? req.parent || null : null,
      children,
      designs, functions, tests, related_tests,
      // 하위 요구사항으로 나뉜 상위 요구사항은 직접 연결이 없어도 된다(하위의 연결을 본다).
      action: children.length && !designs.length && !tests.length && item.change !== "removed" ? `${item.change === "added" ? "새" : "바뀐"} 요구사항 — 하위 요구사항 ${children.join(", ")} 으로 구체화됨, 그쪽의 설계·코드·시험을 본다` : actionFor(item, designs, tests),
      review_children: item.change === "modified" && children.length > 0,
    }));
  }
  return result;
}

// ───────────────────────── 함수 호출 관계(간접 영향) ─────────────────────────
// src/ 의 C 함수마다 본문(주석·문자열 제외)에서 다른 함수를 부르는 곳을 찾는다.
// 바뀐 함수를 부르는 함수는 동작이 바뀔 수 있으므로 간접 영향이다(부르는 쪽으로만 거슬러 올라감, 최대 3단계).
function callGraph(root, codeDirs) {
  const files = [];
  const walkC = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walkC(full);
      else if (/\.c$/i.test(d.name)) files.push(full);
    }
  };
  for (const d of codeDirs) walkC(path.join(root, d));
  const funcs = []; // { file, name, startLine, endLine, body }
  for (const full of files) {
    const text = fs.readFileSync(full, "utf8").replace(/\r\n?/g, "\n");
    const masked = trace.blankNonCode(text).split("\n");
    const file = path.relative(root, full).split(path.sep).join("/");
    for (const u of trace.cUnits(text).units) funcs.push({ file, name: u.name, startLine: u.startLine, endLine: u.endLine, body: masked.slice(u.startLine, u.endLine).join("\n") });
  }
  const names = new Set(funcs.map((f) => f.name));
  const callers = new Map(); // 이름 → [{ file, name, line }]
  for (const f of funcs) {
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(f.body))) {
      const callee = m[1];
      if (callee === f.name || !names.has(callee) || seen.has(callee)) continue;
      seen.add(callee);
      const line = f.startLine + 1 + (f.body.slice(0, m.index).match(/\n/g) || []).length;
      if (!callers.has(callee)) callers.set(callee, []);
      callers.get(callee).push({ file: f.file, name: f.name, line });
    }
  }
  // 이 함수를 (거슬러 올라가며) 부르는 함수들: [{ file, name, line, via, depth }]
  const upstream = (name, maxDepth) => {
    const out = [];
    const seen = new Set([name]);
    let frontier = [{ name, path: [name] }];
    for (let depth = 1; depth <= (maxDepth || 3) && frontier.length; depth++) {
      const next = [];
      for (const cur of frontier) for (const c of callers.get(cur.name) || []) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        out.push({ file: c.file, name: c.name, line: c.line, depth, chain: [c.name, ...cur.path] });
        next.push({ name: c.name, path: [c.name, ...cur.path] });
      }
      frontier = next;
    }
    return out;
  };
  return { funcs, callers, upstream };
}

// ───────────────────────── 영향 판정(5단계)과 근거, 기존 시험 증거의 유효성 ─────────────────────────
// direct    직접 영향      — 바뀐 요구사항에 명시적 추적 태그(@satisfies·@verifies)로 연결됨 → 수정·재검토
// indirect  간접 영향      — 설계 항목을 거쳐(@implements·설계를 @verifies), 같은 함수를 함께 쓰거나, 상위·하위 관계로 이어짐 → 연쇄 영향 확인
// potential 잠재 영향      — 같은 신호를 함께 쓰는 등 의미상 영향 가능성이 있으나 확정되지 않음 → 담당자 검토
// none      영향 없음 확인 — 분석 범위(추적 태그·함수 공유·신호·상하위)에서 연결이 없고, 자신의 추적 연결은 갖춰짐 → 근거 기록 후 제외 가능
// unknown   미확인        — 추적 연결이 없어 판단할 수 없음. '영향 없음'으로 처리하지 않는다
const VERDICT_LABEL = { direct: "직접 영향", indirect: "간접 영향", potential: "잠재 영향", none: "영향 없음 확인", unknown: "미확인" };

// 시험 하나의 기존 증거가 새 고정본에서도 쓸 수 있는지. 지난 결과는 지우지 않고 '어느 형상의 증거인지'만 판정한다.
function evidenceOf(last, impacted, toId) {
  if (!last || !last.result) return { state: "none", label: "시험 결과 없음", result: null };
  const at = last.run || {};
  const base = { result: last.result, run_file: at.file || null, run_at: at.started_at || null, run_baseline: at.baseline_id || null, source: at.source || null };
  if (last.outdated) return Object.assign(base, { state: "stale", label: "결과 뒤에 소스·시험이 바뀜 — 다시 실행해야 함" });
  if (impacted && at.baseline_id !== toId) return Object.assign(base, { state: "previous", label: `이전 형상(${at.baseline_id || "고정본 없음"})의 증거 — ${toId} 에서 재검증 필요` });
  if (impacted) return Object.assign(base, { state: "revalidated", label: `${toId} 에서 다시 확인됨` });
  return Object.assign(base, { state: "valid", label: "영향 없음 — 기존 증거 유지" });
}

// 검토 우선순위: 변경 종류·바뀐 항목·요구사항 유형·프로젝트 등급(같은 도메인 안의 순위)·영향 범위·확정 안 된 영향·재검증 여부
// 등급은 다른 표준의 등급으로 바꾸지 않는다. 이 도메인의 등급 목록에서 몇 번째인지만 쓴다.
function projectLevel(root) {
  try {
    const cfg = require("../project/config.js");
    const l = cfg.load(root);
    if (!l || !l.config) return null;
    const dom = cfg.DOMAINS[l.config.domain];
    const ids = dom ? dom.levels.map(([id]) => id) : [];
    const i = ids.indexOf(String(l.config.level));
    return { text: cfg.levelText(l.config), rank: ids.length > 1 && i >= 0 ? i / (ids.length - 1) : null };
  } catch (_) { return null; }
}
function priorityOf(q, items, req, level) {
  const reasons = [];
  let score = 0;
  const add = (n, why) => { score += n; reasons.push(why); };
  if (q.change === "removed") add(3, "요구사항 삭제 — 연결된 산출물 정리 필요");
  else if (q.change === "modified") add(2, "요구사항 변경");
  else add(1, "새 요구사항");
  const fields = (q.fields || []).map((x) => x.field);
  if (fields.includes("text") || fields.includes("acceptance_criteria")) add(2, "문장·수용 기준 변경 — 기대값(Oracle)에 영향");
  if (fields.includes("ears_type")) add(1, "EARS 유형 변경");
  if (fields.includes("parent")) add(1, "상위 요구사항 변경");
  if (req && /unwanted/i.test(String(req.ears_type || ""))) add(1, "이상 상황 대응(Unwanted Behaviour) 요구사항");
  if (level && level.rank !== null) { if (level.rank >= 0.75) add(2, `${level.text} 프로젝트`); else if (level.rank >= 0.5) add(1, `${level.text} 프로젝트`); }
  const tests = items.filter((x) => x.kind === "시험");
  if (tests.length >= 10) add(1, `영향받는 시험 ${tests.length}개`);
  if (items.some((x) => x.verdict === "potential" || x.verdict === "unknown")) add(1, "확정되지 않은 영향(잠재·미확인) 있음");
  if (tests.some((x) => x.evidence_state && x.evidence_state.state !== "revalidated")) add(1, "새 고정본에서 재검증되지 않은 시험 있음");
  const levelKey = score >= 6 ? "high" : score >= 3 ? "medium" : "low";
  return { level: levelKey, label: { high: "높음", medium: "보통", low: "낮음" }[levelKey], score, reasons };
}

function classifyImpact(root, model, toB, fromB, changed, signals, dirs) {
  const level = projectLevel(root);
  let graph = null;
  try { graph = callGraph(root, (dirs && dirs.code) || DEFAULT_DIRS.code); } catch (_) { graph = null; }
  let lastOf = () => null;
  // 이 PC 에서 TC 하나씩 실행한 회귀 결과(디버깅용 보관, trace-out/tc-runs.json)
  let reg = {};
  try { reg = require("./tc-run.js").loadRuns(root).runs || {}; } catch (_) { reg = {}; }
  const regOf = (id) => { const x = reg[id]; return x ? { result: x.result, ran_at: x.ran_at || null, stale: x.stale, isolated: x.isolated } : null; };
  try { const tc = require("./testcases.js").table(root); const m = new Map(tc.testcases.map((t) => [t.id, t])); lastOf = (id) => m.get(id) || null; } catch (_) { /* 시험 결과를 읽지 못함 */ }
  const toId = toB.baseline_id;
  const changedIds = new Set(changed.map((q) => q.id));
  const reqs = new Map(toB.requirements.map((r) => [r.requirement_id, r]));
  // 신호 → 그 신호를 쓰는 요구사항
  const signalUsers = new Map();
  for (const s of (toB.signals || [])) for (const id of s.requirements || []) { if (!signalUsers.has(id)) signalUsers.set(id, new Set()); signalUsers.get(id).add(s.name); }
  const changedSignals = new Set((signals || []).map((s) => s.name));
  const impactedTests = new Set();
  // 다른 요구사항 수준의 판정(바뀐 요구사항이 아닌 것)
  const others = new Map(); // id → { verdict, evidence: [] }
  const RANK = { direct: 4, indirect: 3, potential: 2, unknown: 1, none: 0 };
  const mark = (id, verdict, why) => {
    if (changedIds.has(id)) return;
    const cur = others.get(id) || { id, verdict, evidence: [] };
    if (RANK[verdict] > RANK[cur.verdict]) cur.verdict = verdict;
    if (!cur.evidence.includes(why)) cur.evidence.push(why);
    others.set(id, cur);
  };

  for (const q of changed) {
    const items = [];
    const ev = (t) => Object.assign(evidenceOf(lastOf(t.id), true, toId), { regression: regOf(t.id) });
    for (const d of q.designs) items.push({ verdict: "direct", kind: "설계", id: d.id, file: d.file, line: d.line, evidence: `${d.file}:${d.line} 의 @satisfies ${q.id}${d.linked_version ? "@v" + d.linked_version : ""}`, todo: d.state === "반영됨" ? "새 버전으로 갱신됨 — 바뀐 내용과 맞는지 확인" : q.change === "removed" ? "근거 요구사항 삭제 — 제거 또는 다른 요구사항에 연결" : "설계 내용 수정·재검토 후 태그 갱신" });
    for (const t of q.tests) {
      impactedTests.add(t.id);
      const direct = t.via === q.id;
      items.push({ verdict: direct ? "direct" : "indirect", kind: "시험", id: t.id, file: t.file, line: t.line,
        evidence: direct ? `${t.file}:${t.line} 의 @verifies ${q.id}${t.linked_version ? "@v" + t.linked_version : ""}` : `설계 ${t.via} 를 @verifies — 설계를 거쳐 이어짐`,
        todo: q.change === "removed" ? "근거 요구사항 삭제 — 시험 제거 또는 재연결" : "기대값(Oracle)·입력 재산정 후 재실행", evidence_state: ev(t) });
    }
    for (const f of q.functions) items.push({ verdict: "indirect", kind: "함수", id: `${f.file}:${f.func}()`, file: f.file, line: f.line, evidence: `@implements ${f.via.join(", ")} — 바뀐 요구사항의 설계를 구현`, todo: "비교 로직·상수·인터페이스 확인" });
    // 호출 관계: 바뀐 요구사항의 함수를 부르는 함수와, 그 함수가 구현하는 다른 요구사항·시험
    if (graph) {
      const own = new Set(q.functions.map((x) => x.func));
      const done = new Set();
      const callerTests = new Map();
      for (const fn of q.functions) for (const up of graph.upstream(fn.func, 3)) {
        if (own.has(up.name) || done.has(up.name)) continue;
        done.add(up.name);
        items.push({ verdict: "indirect", kind: "호출하는 함수", id: `${up.file}:${up.name}()`, file: up.file, line: up.line, evidence: `${up.chain.join("() → ")}() — 바뀐 함수를 ${up.depth}단계 거쳐 호출`, todo: "호출 결과·값 범위·인터페이스가 맞는지 확인" });
        const unit = model.units.find((u) => u.func === up.name && u.file === up.file);
        const designIds = unit ? unit.implements : [];
        for (const d of designIds) {
          const design = model.designs.get(d);
          for (const l of design ? design.links : []) if (l.id !== q.id) mark(l.id, "indirect", `${up.name}() 가 바뀐 함수 ${fn.func}() 를 호출`);
        }
        for (const t of model.tests.values()) {
          if (callerTests.has(t.id) || q.tests.some((x) => x.id === t.id) || (q.related_tests || []).some((x) => x.id === t.id)) continue;
          const hit = t.links.find((l) => designIds.includes(l.id) || designIds.some((d) => (model.designs.get(d) || { links: [] }).links.some((x) => x.id === l.id)));
          if (hit) callerTests.set(t.id, { t, why: `${up.name}() (바뀐 ${fn.func}() 를 호출)를 쓰는 ${hit.id} 의 시험` });
        }
      }
      for (const { t, why } of callerTests.values()) {
        impactedTests.add(t.id);
        items.push({ verdict: "indirect", kind: "시험", id: t.id, file: t.file, line: t.line, evidence: why, todo: "회귀 시험으로 다시 실행", evidence_state: Object.assign(evidenceOf(lastOf(t.id), true, toId), { regression: regOf(t.id) }) });
      }
    }
    for (const t of q.related_tests || []) {
      impactedTests.add(t.id);
      if (changedIds.has(t.requirement)) continue; // 그 요구사항도 바뀌었으면 그쪽 카드에서 직접 영향으로 보인다
      items.push({ verdict: "indirect", kind: "시험", id: t.id, file: t.file, line: t.line, evidence: `같은 함수(${t.via.join(", ")})를 쓰는 ${t.requirement} 의 시험`, todo: "회귀 시험으로 다시 실행", evidence_state: Object.assign(evidenceOf(lastOf(t.id), true, toId), { regression: regOf(t.id) }) });
      mark(t.requirement, "indirect", `${q.id} 와 같은 함수(${t.via.join(", ")})를 씀`);
    }
    for (const c of q.children || []) { items.push({ verdict: "indirect", kind: "하위 요구사항", id: c, evidence: `parent: ${q.id}`, todo: "상위 변경에 맞는지 검토" }); mark(c, "indirect", `상위 요구사항 ${q.id} 가 바뀜`); }
    if (q.parent) { items.push({ verdict: "indirect", kind: "상위 요구사항", id: q.parent, evidence: `${q.id} 의 parent`, todo: "상위 요구사항과 일관한지 검토" }); mark(q.parent, "indirect", `하위 요구사항 ${q.id} 가 바뀜`); }
    // 같은 신호를 쓰는 다른 요구사항: 의미상 영향 가능(예: 정지 임계값이 바뀌면 같은 온도를 쓰는 복귀 조건)
    const mine = signalUsers.get(q.id) || new Set();
    for (const [rid, names] of signalUsers) {
      if (rid === q.id || changedIds.has(rid) || (q.children || []).includes(rid) || rid === q.parent) continue;
      const shared = [...names].filter((n) => mine.has(n));
      if (!shared.length) continue;
      items.push({ verdict: "potential", kind: "요구사항", id: rid, evidence: `같은 신호 ${shared.join(", ")} 를 씀`, todo: "변경 의도와 일관한지 담당자 검토(자동으로 바꾸지 않음)" });
      mark(rid, "potential", `${q.id} 와 같은 신호 ${shared.join(", ")} 를 씀`);
    }
    // 연결이 하나도 없으면 '영향 없음'이 아니라 '미확인'
    if (q.change !== "removed" && !q.designs.length && !q.tests.length && !(q.children || []).length) {
      items.push({ verdict: "unknown", kind: "요구사항", id: q.id, evidence: "추적 연결(설계·시험)이 없어 영향 범위를 판단할 수 없음", todo: "설계·시험을 연결한 뒤 다시 분석" });
    }
    const order = { direct: 0, indirect: 1, potential: 2, unknown: 3, none: 4 };
    items.sort((a, b) => order[a.verdict] - order[b.verdict]);
    q.impacts = items;
    q.priority = priorityOf(q, items, reqs.get(q.id) || (fromB && fromB.requirements.find((x) => x.requirement_id === q.id)) || null, level);
    q.verdict_counts = Object.fromEntries(Object.keys(VERDICT_LABEL).map((k) => [k, items.filter((x) => x.verdict === k).length]));
  }

  // 바뀌지 않은 요구사항 가운데 위에서 표시되지 않은 것: 자신의 추적 연결이 있으면 '영향 없음 확인', 없으면 '미확인'
  const linkedTests = (id) => [...model.tests.values()].filter((t) => t.links.some((l) => l.id === id || [...model.designs.values()].some((d) => d.id === l.id && d.links.some((x) => x.id === id))));
  const hasDesign = (id) => [...model.designs.values()].some((d) => d.links.some((l) => l.id === id));
  for (const [id, r] of reqs) {
    if (changedIds.has(id) || others.has(id)) continue;
    const kids = toB.requirements.some((x) => x.parent === id);
    const tests = linkedTests(id);
    if (tests.length || hasDesign(id) || kids) others.set(id, { id, verdict: "none", evidence: [`바뀐 요구사항과 추적 태그·함수·신호·상하위 연결이 없음${changedSignals.size ? ` · 바뀐 신호(${[...changedSignals].join(", ")})도 쓰지 않음` : ""}`, tests.length ? `자신의 시험 ${tests.length}개 연결` : kids ? "하위 요구사항으로 구체화됨" : "설계 연결"] });
    else others.set(id, { id, verdict: "unknown", evidence: ["설계·시험 연결이 없어 영향 여부를 확인할 수 없음 — '영향 없음'으로 처리하지 않음"] });
    void r;
  }
  const list = [...others.values()].map((o) => Object.assign(o, { summary: (reqs.get(o.id) || {}).summary || "", tests: o.verdict === "none" ? linkedTests(o.id).map((t) => ({ id: t.id, evidence_state: evidenceOf(lastOf(t.id), false, toId) })) : [] })).sort((a, b) => byId(a.id, b.id));
  const counts = { direct: 0, indirect: 0, potential: 0, none: 0, unknown: 0 };
  for (const q of changed) for (const it of q.impacts) counts[it.verdict]++;
  for (const o of list) counts[o.verdict]++;
  // 재검증 범위: 영향받은 시험 각각의 기존 증거 상태
  const evidence = [...impactedTests].sort(byId).map((id) => Object.assign({ id }, evidenceOf(lastOf(id), true, toId), { regression: regOf(id) }));
  const priority = { high: changed.filter((q) => q.priority.level === "high").length, medium: changed.filter((q) => q.priority.level === "medium").length, low: changed.filter((q) => q.priority.level === "low").length };
  return { labels: VERDICT_LABEL, counts, priority, level: level ? level.text : null, other_requirements: list, retest: evidence };
}

async function analyzeRequirementImpact(root, opts) {
  opts = opts || {};
  const all = loadBaselines(root);
  if (!all.length) throw new UsageError(`고정본 파일이 없음: ${path.join(root, "requirements", "baseline")}`);
  const find = (id) => {
    const e = all.find((x) => x.baseline.baseline_id === id);
    if (!e) throw new UsageError(`대상 프로젝트에 ${id} 가 없음 (있는 것: ${all.map((x) => x.baseline.baseline_id).join(", ")})`);
    return e;
  };
  const toEntry = opts.to ? find(opts.to) : all[all.length - 1];
  let fromEntry = null;
  if (opts.from) fromEntry = find(opts.from);
  else {
    const prevId = toEntry.baseline.previous_baseline && toEntry.baseline.previous_baseline.baseline_id;
    fromEntry = (prevId && all.find((x) => x.baseline.baseline_id === prevId)) || all.filter((x) => x.n < toEntry.n).pop() || null;
  }
  if (fromEntry && fromEntry.n >= toEntry.n) throw new UsageError(`비교 기준(${fromEntry.baseline.baseline_id})은 대상(${toEntry.baseline.baseline_id})보다 이전 고정본이어야 함`);
  const toB = await verified(toEntry);
  const fromB = fromEntry ? await verified(fromEntry) : null;

  const items = diffRequirements(fromB, toB);
  const model = trace.collect(root, dirsOf(opts));
  const changed = artifactImpact(model, items, fromB, toB);
  const signals = diffSignals(fromB, toB, model);
  const classification = classifyImpact(root, model, toB, fromB, changed, signals, dirsOf(opts));
  const count = (c) => items.filter((i) => i.change === c).length;
  const stale = (list) => list.filter((x) => x.state === "재확인 필요" || x.state === "근거 요구사항 삭제됨");
  return {
    kind: "requirements",
    from: fromB ? { baseline_id: fromB.baseline_id, baseline_hash: fromB.baseline_hash, file: fromEntry.file } : null,
    to: { baseline_id: toB.baseline_id, baseline_hash: toB.baseline_hash, file: toEntry.file },
    summary: {
      added: count("added"), modified: count("modified"), removed: count("removed"), unchanged: count("unchanged"),
      designs_to_review: uniq(changed.flatMap((c) => stale(c.designs).map((d) => d.id))).length,
      functions_affected: uniq(changed.flatMap((c) => c.functions.map((f) => `${f.file}:${f.func}`))).length,
      tests_to_review: uniq(changed.flatMap((c) => stale(c.tests).map((t) => t.id))).length,
      // 직접 연결된 시험 + 같은 함수를 쓰는 다른 요구사항의 시험
      tests_to_rerun: uniq(changed.flatMap((c) => [...c.tests.map((t) => t.id), ...(c.related_tests || []).map((t) => t.id)])).length,
      related_tests: uniq(changed.flatMap((c) => (c.related_tests || []).map((t) => t.id))).length,
      // 신호 표가 바뀌었을 때만 적는다.
      ...(signals.length ? { signals_changed: signals.length, signals_to_review: signals.filter((s) => s.declared.some((d) => d.state !== "반영됨")).length } : {}),
    },
    ...(signals.length ? { signals } : {}),
    requirements: changed,
    unchanged: items.filter((i) => i.change === "unchanged").map((i) => i.id),
    classification,
  };
}

// ───────────────────────── 코드 변경 영향 ─────────────────────────

function git(root, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

// `git diff -U0` 출력 → [{ oldPath, newPath, hunks: [{ oldStart, oldLen, newStart, newLen }] }]
function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
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
}

// 바뀐 줄 범위. 한쪽 길이가 0인 hunk(순수 삭제·순수 추가)는 그쪽에 바뀐 줄이 없다.
// git 은 이때 시작 위치로 "바로 앞 줄"을 적으므로, 그 줄을 바뀐 줄로 보면 이웃 항목이 잘못 잡힌다.
const rangesOf = (hunks, side) => hunks
  .map((h) => (side === "old" ? [h.oldStart, h.oldLen] : [h.newStart, h.newLen]))
  .filter(([, len]) => len > 0)
  .map(([start, len]) => [start, start + len - 1]);
const touches = (ranges, a, b) => ranges.some(([s, e]) => s <= b && e >= a);

// 태그 블록: 선언 태그(@design·@testcase) 줄부터 다음 선언 태그 앞까지.
function tagBlocks(text, declTag, linkTag) {
  const tags = trace.parseTags(text);
  const lines = text.split(/\r?\n/).length;
  const decls = tags.filter((t) => t.tag === declTag && t.args[0]);
  return decls.map((d, i) => ({
    id: d.args[0],
    startLine: d.line,
    endLine: i + 1 < decls.length ? decls[i + 1].line - 1 : lines,
    links: tags.filter((t) => t.tag === linkTag && t.line >= d.line && (i + 1 >= decls.length || t.line < decls[i + 1].line)).flatMap((t) => t.args.map(trace.parseRef)),
  }));
}

function changedItems(oldList, newList, oldRanges, newRanges, keyOf) {
  const out = new Map();
  const add = (x, status) => { const k = keyOf(x); if (!out.has(k)) out.set(k, Object.assign({}, x, { status })); };
  const oldKeys = new Set(oldList.map(keyOf));
  const newKeys = new Set(newList.map(keyOf));
  for (const x of newList) if (touches(newRanges, x.startLine, x.endLine)) add(x, oldKeys.has(keyOf(x)) ? "modified" : "added");
  for (const x of oldList) if (touches(oldRanges, x.startLine, x.endLine)) add(x, newKeys.has(keyOf(x)) ? "modified" : "removed");
  // 다른 곳의 변경으로 생기거나 사라진 항목(예: 파일 전체 추가·삭제)
  for (const x of newList) if (!oldKeys.has(keyOf(x))) add(x, "added");
  for (const x of oldList) if (!newKeys.has(keyOf(x))) add(x, "removed");
  return [...out.values()];
}

async function analyzeCodeImpact(root, opts) {
  opts = opts || {};
  const base = opts.base || "HEAD";
  if (!/^[\w./~^@{}-]+$/.test(base) || base.startsWith("-")) throw new UsageError(`기준 커밋 표기가 올바르지 않음: ${base}`);
  let baseCommit;
  try { baseCommit = git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).trim(); }
  catch (e) {
    const msg = String(e.stderr || "").trim();
    throw new UsageError(msg.includes("not a git repository") ? "대상 폴더가 Git 저장소 안에 있지 않음" : `기준 커밋을 찾을 수 없음: ${base}`);
  }
  const dirs = dirsOf(opts);
  const pathspecs = [...dirs.design, ...dirs.code, ...dirs.tests];
  const kindOf = (p) => {
    const under = (list) => list.some((d) => p === d || p.startsWith(d.replace(/\/$/, "") + "/"));
    return under(dirs.code) ? "code" : under(dirs.tests) ? "tests" : under(dirs.design) ? "design" : null;
  };

  const files = parseUnifiedDiff(git(root, ["diff", "--relative", "--no-color", "--no-ext-diff", "--find-renames", "-U0", baseCommit, "--", ...pathspecs]));
  for (const p of git(root, ["ls-files", "--others", "--exclude-standard", "--", ...pathspecs]).split(/\r?\n/).filter(Boolean)) {
    files.push({ oldPath: null, newPath: p, hunks: [] });
  }

  const readNew = (p) => { try { return fs.readFileSync(path.join(root, p), "utf8"); } catch (_) { return null; } };
  const readOld = (p) => { try { return git(root, ["show", `${baseCommit}:./${p}`]); } catch (_) { return null; } };

  const functions = [];
  const designs = [];
  const tests = [];
  const other = [];
  for (const f of files) {
    const p = f.newPath || f.oldPath;
    const kind = kindOf(p);
    if (!kind) continue;
    const newText = f.newPath ? readNew(f.newPath) : null;
    const oldText = f.oldPath ? readOld(f.oldPath) : null;
    const newRanges = rangesOf(f.hunks, "new");
    const oldRanges = rangesOf(f.hunks, "old");
    const fileStatus = !f.oldPath ? "added" : !f.newPath ? "removed" : "modified";
    // 주석을 뺀 코드(줄 끝 공백·빈 줄 무시). 같으면 주석만 바뀐 것이다.
    const codeNorm = (text) => require("./consistency.js").codeForCompare(text); // 도구가 읽는 주석이 바뀐 것은 주석만 바뀐 것이 아니다
    const slice = (text, x) => String(text || "").split(/\r?\n/).slice(x.startLine - 1, x.endLine).join("\n");
    const isC = trace.C_EXT.has(path.extname(p).toLowerCase());
    const fileCommentOnly = isC && fileStatus === "modified" && oldText !== null && newText !== null && codeNorm(oldText) === codeNorm(newText);
    const sameList = (a, b) => JSON.stringify([...(a || [])].map((x) => (typeof x === "string" ? x : `${x.id}@${x.version}`)).sort()) === JSON.stringify([...(b || [])].map((x) => (typeof x === "string" ? x : `${x.id}@${x.version}`)).sort());

    if (kind === "code" && trace.C_EXT.has(path.extname(p).toLowerCase())) {
      const nu = newText === null ? [] : trace.cUnits(newText).units;
      const ou = oldText === null ? [] : trace.cUnits(oldText).units;
      const changed = changedItems(ou, nu, oldRanges, newRanges, (u) => u.name);
      for (const u of changed) {
        const cur = nu.find((x) => x.name === u.name);
        const prev = ou.find((x) => x.name === u.name);
        // 주석만 바뀌고(코드 같음) 추적 태그도 그대로면 동작에 영향이 없다: 목록에는 보이되 요구사항·재시험으로 잇지 않는다.
        const commentOnly = u.status === "modified" && Boolean(cur && prev) && sameList(cur.implements, prev.implements) && cur.exempt === prev.exempt
          && (fileCommentOnly || codeNorm(slice(newText, cur)) === codeNorm(slice(oldText, prev)));
        functions.push(Object.assign({ file: p, func: u.name, status: u.status, implements: uniq([...(cur ? cur.implements : []), ...(prev ? prev.implements : [])]), exempt: (cur || prev).exempt }, commentOnly ? { comment_only: true } : {}));
      }
      // 함수 밖의 변경(매크로·자료형·전역 등): 어떤 함수에 영향을 주는지 줄 단위로는 알 수 없다.
      const inside = (ranges, units) => ranges.filter(([s, e]) => !units.some((u) => u.startLine <= e && u.endLine >= s));
      const outside = fileStatus === "modified" && !fileCommentOnly ? inside(newRanges, nu).length + inside(oldRanges, ou).length : 0;
      if (outside) other.push({ file: p, kind, status: fileStatus, note: "함수 밖 변경(매크로·자료형·선언 등) — 이 파일을 쓰는 모든 함수에 영향 가능" });
    } else if (kind === "design") {
      const nb = newText === null ? [] : tagBlocks(newText, "design", "satisfies");
      const ob = oldText === null ? [] : tagBlocks(oldText, "design", "satisfies");
      for (const b of changedItems(ob, nb, oldRanges, newRanges, (x) => x.id)) {
        const cur = nb.find((x) => x.id === b.id);
        designs.push({ id: b.id, file: p, status: b.status, satisfies: (cur || b).links });
      }
    } else if (kind === "tests") {
      const nb = newText === null ? [] : tagBlocks(newText, "testcase", "verifies");
      const ob = oldText === null ? [] : tagBlocks(oldText, "testcase", "verifies");
      const changed = changedItems(ob, nb, oldRanges, newRanges, (x) => x.id);
      for (const b of changed) {
        const cur = nb.find((x) => x.id === b.id);
        const prevB = ob.find((x) => x.id === b.id);
        const commentOnly = isC && b.status === "modified" && Boolean(cur && prevB) && sameList(cur.links, prevB.links)
          && (fileCommentOnly || codeNorm(slice(newText, cur)) === codeNorm(slice(oldText, prevB)));
        tests.push(Object.assign({ id: b.id, file: p, status: b.status, verifies: (cur || b).links }, commentOnly ? { comment_only: true } : {}));
      }
      const firstDecl = (blocks) => (blocks.length ? blocks[0].startLine : Infinity);
      const outside = fileStatus === "modified" && !fileCommentOnly && (newRanges.some(([s]) => s < firstDecl(nb)) || oldRanges.some(([s]) => s < firstDecl(ob)));
      if (outside) other.push({ file: p, kind, status: fileStatus, note: "시험 공통 코드 변경 — 이 파일의 모든 시험을 다시 실행해야 함" });
    } else {
      other.push({ file: p, kind, status: fileStatus, note: "추적 태그를 해석하지 않는 파일 — 영향 범위를 자동으로 판단하지 못함" });
    }
  }

  // 현재 산출물 기준으로 요구사항까지 이어 간다.
  const model = trace.collect(root, dirs);
  const satisfiesOf = (designId) => {
    const d = model.designs.get(designId);
    if (d) return d.links;
    const removed = designs.find((x) => x.id === designId);
    return removed ? removed.satisfies : [];
  };
  const reqs = new Map();
  const touch = (ref, via) => {
    if (!reqs.has(ref.id)) reqs.set(ref.id, { id: ref.id, via: [] });
    reqs.get(ref.id).via.push(via);
  };
  // 주석만 바뀐 것은 영향 추적에서 뺀다(아래의 요구사항·호출 함수·재시험 계산은 liveFns · liveTests 로 한다)
  const liveFns = functions.filter((fn) => !fn.comment_only);
  const liveTests = tests.filter((t) => !t.comment_only);
  for (const fn of liveFns) for (const d of fn.implements) for (const r of satisfiesOf(d)) touch(r, `${fn.file}:${fn.func} → ${d}`);
  // 바뀐 함수를 부르는 함수(호출 관계, 최대 3단계)도 그 함수가 구현하는 요구사항에 닿는다.
  const callerFns = [];
  let graphC = null;
  try { graphC = callGraph(root, dirs.code); } catch (_) { graphC = null; }
  if (graphC) for (const fn of liveFns.filter((x) => x.status !== "removed")) for (const up of graphC.upstream(fn.func, 3)) {
    if (functions.some((x) => x.func === up.name) || callerFns.some((x) => x.func === up.name)) continue;
    const unit = model.units.find((u) => u.func === up.name && u.file === up.file);
    callerFns.push({ file: up.file, func: up.name, calls: fn.func, depth: up.depth, chain: up.chain, implements: unit ? unit.implements : [] });
    for (const d of unit ? unit.implements : []) for (const r of satisfiesOf(d)) touch(r, `${up.file}:${up.name} (바뀐 ${fn.func}() 를 호출) → ${d}`);
  }
  for (const d of designs) for (const r of d.satisfies) touch(r, `설계 ${d.id}`);
  for (const t of liveTests) for (const r of t.verifies) if (!r.id.startsWith("SWD-")) touch(r, `시험 ${t.id}`);

  const rerun = new Set(liveTests.filter((t) => t.status !== "removed").map((t) => t.id));
  for (const t of model.tests.values()) {
    if (t.links.some((l) => reqs.has(l.id))) rerun.add(t.id);
    const viaDesign = t.links.filter((l) => l.id.startsWith("SWD-")).some((l) => liveFns.some((fn) => fn.implements.includes(l.id)) || callerFns.some((fn) => fn.implements.includes(l.id)) || designs.some((d) => d.id === l.id));
    if (viaDesign) rerun.add(t.id);
  }
  for (const o of other.filter((x) => x.kind === "tests")) for (const t of model.tests.values()) if (t.file === o.file) rerun.add(t.id);

  const untraced = functions.filter((fn) => fn.status !== "removed" && !fn.implements.length && fn.exempt === null);
  // 줄 단위로 범위를 좁힐 수 없는 코드 변경이 있으면 보수적으로 전체 재실행을 권한다.
  const rerunAll = other.some((o) => o.kind === "code");
  if (rerunAll) for (const t of model.tests.values()) rerun.add(t.id);
  return {
    kind: "code",
    base: { ref: base, commit: baseCommit },
    summary: {
      functions: functions.length, designs: designs.length, tests: tests.length,
      requirements: reqs.size, tests_to_rerun: rerun.size, untraced: untraced.length, other: other.length, callers: callerFns.length,
      rerun_all: rerunAll,
      // 주석만 바뀐 함수·시험의 수(동작은 그대로라 다시 시험할 대상에 넣지 않았다)
      comment_only: functions.filter((x) => x.comment_only).length + tests.filter((x) => x.comment_only).length,
    },
    changes: { functions, designs, tests, other, callers: callerFns },
    requirements: [...reqs.values()].sort((a, b) => byId(a.id, b.id)),
    rerun_tests: [...rerun].sort(byId),
    untraced: untraced.map((fn) => `${fn.file}:${fn.func}`),
  };
}

// ───────────────────────── 출력 ─────────────────────────

const CHANGE_LABEL = { added: "신규", modified: "변경", removed: "삭제", unchanged: "유지" };

function renderRequirementText(r) {
  const lines = [`# 요구사항 변경 영향: ${r.from ? r.from.baseline_id : "(없음)"} → ${r.to.baseline_id}`];
  const s = r.summary;
  lines.push(`신규 ${s.added} · 변경 ${s.modified} · 삭제 ${s.removed} · 유지 ${s.unchanged} | 재확인할 설계 ${s.designs_to_review} · 영향받는 함수 ${s.functions_affected} · 재확인할 시험 ${s.tests_to_review} · 다시 실행할 시험 ${s.tests_to_rerun}`);
  for (const q of r.requirements) {
    const v = q.change === "modified" ? ` v${q.from_version}→v${q.to_version}` : q.change === "added" ? ` v${q.to_version}` : ` v${q.from_version}`;
    lines.push("", `## [${CHANGE_LABEL[q.change]}] ${q.id}${v} ${q.summary}`);
    for (const f of q.fields) lines.push(`- ${f.label}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`);
    for (const d of q.designs) lines.push(`- 설계 ${d.id} (@v${d.linked_version}) — ${d.state}  ${d.file}:${d.line}`);
    for (const f of q.functions) lines.push(`- 함수 ${f.file}:${f.func}() — ${f.via.join(", ")} 을 통해 영향`);
    for (const t of q.tests) lines.push(`- 시험 ${t.id}${t.linked_version ? ` (@v${t.linked_version})` : ""} — ${t.state}`);
    if (q.review_children) lines.push(`- 하위 요구사항 ${q.children.join(", ")} — 상위 요구사항 변경에 맞는지 검토`);
    lines.push(`→ ${q.action}`);
  }
  if (!r.requirements.length) lines.push("", "바뀐 요구사항이 없음");
  return lines.join("\n");
}

function renderCodeText(r) {
  const lines = [`# 코드 변경 영향: ${r.base.ref} (${r.base.commit.slice(0, 12)}) 이후`];
  const s = r.summary;
  lines.push(`함수 ${s.functions} · 설계 항목 ${s.designs} · 시험 ${s.tests} · 기타 ${s.other} | 영향받는 요구사항 ${s.requirements} · 다시 실행할 시험 ${s.tests_to_rerun} · 태그 없는 함수 ${s.untraced}`);
  for (const f of r.changes.functions) {
    const link = f.implements.length ? "→ " + f.implements.join(", ") : f.exempt !== null ? `(추적 제외: ${f.exempt || "사유 없음"})` : "(추적 태그 없음)";
    lines.push(`- [${CHANGE_LABEL[f.status]}] 함수 ${f.file}:${f.func}() ${link}`);
  }
  for (const d of r.changes.designs) lines.push(`- [${CHANGE_LABEL[d.status]}] 설계 ${d.id} → ${d.satisfies.map((x) => x.id + (x.version ? "@v" + x.version : "")).join(", ") || "-"}`);
  for (const t of r.changes.tests) lines.push(`- [${CHANGE_LABEL[t.status]}] 시험 ${t.id} → ${t.verifies.map((x) => x.id + (x.version ? "@v" + x.version : "")).join(", ") || "-"}`);
  for (const o of r.changes.other) lines.push(`- [${CHANGE_LABEL[o.status]}] ${o.file} — ${o.note}`);
  lines.push("", `영향받는 요구사항: ${r.requirements.map((q) => q.id).join(", ") || "없음"}`);
  lines.push(`다시 실행할 시험: ${r.rerun_tests.join(", ") || "없음"}${s.rerun_all ? " (함수 밖 코드 변경이 있어 전체 재실행)" : ""}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const opts = { root: ".", from: null, to: null, code: false, base: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} 뒤에 값이 필요함`); return argv[++i]; };
    if (a === "--root") opts.root = value();
    else if (a === "--from") opts.from = value();
    else if (a === "--to") opts.to = value();
    else if (a === "--code") opts.code = true;
    else if (a === "--base") opts.base = value();
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new UsageError(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

const HELP = `변경 영향도 분석

  node tools/trace/impact.js --root <대상> [--from BL-001] [--to BL-002] [--json]
      요구사항 변경 영향. 기본은 최신 고정본과 그 직전 고정본 비교
  node tools/trace/impact.js --root <대상> --code [--base HEAD] [--json]
      코드 변경 영향. 기준 커밋 이후(커밋되지 않은 변경 포함) 바뀐 함수·설계·시험

종료 코드: 0 분석 완료, 2 실행 조건 오류`;

async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return { code: 0, text: HELP };
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`대상 폴더를 찾을 수 없음: ${root}`);
  const report = opts.code ? await analyzeCodeImpact(root, { base: opts.base }) : await analyzeRequirementImpact(root, { from: opts.from, to: opts.to });
  const text = opts.json ? JSON.stringify(report, null, 2) : (opts.code ? renderCodeText(report) : renderRequirementText(report));
  return { code: 0, text, report };
}

module.exports = { run, byId, classifyImpact, evidenceOf, VERDICT_LABEL, callGraph, priorityOf, diffRequirements, analyzeRequirementImpact, analyzeCodeImpact, parseUnifiedDiff, loadBaselines };

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (r) => { console.log(r.text); process.exitCode = r.code; },
    (e) => { console.error(e instanceof UsageError ? e.message : e); process.exitCode = 2; }
  );
}
