/* 아키텍처 결정 — 설계 결정 요인 · 후보 · 평가 · 결정 기록(ADR) · 아키텍처 Baseline(ABL). 결정 D-013,
 * 계획 docs/requirements/architecture-decision.md.
 *
 * 작업본  design/architecture/work.json                       결정 요인·후보·평가·선택(덮어쓸 수 있음)
 * 승인본  design/architecture/baseline/ABL-NNN_<이름>.json    선택한 후보의 구조 + ADR + 근거 BL. 한 번만 씀(wx), 해시·사슬
 * 기록    design/adr/ADR-NNN.json                             ABL 과 함께 쓰는 결정 기록(같은 번호)
 *
 * 원칙: 필수 제약을 어긴 후보는 점수와 관계없이 고를 수 없다. 필수 제약을 판단할 수 없으면 '증거 필요' — 조건부로만.
 * 측정하지 않은 성능·자원 수치는 만들지 않는다(값이 있으면 출처 필수). 평가 등급은 낮음/보통/높음/미확인 + 근거.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const baselineApi = require("../../webapp/baseline.js");
const designModel = require("../../webapp/design-model.js");

const WORK_FILE = "design/architecture/work.json";
const BASELINE_DIR = "design/architecture/baseline";
const ADR_DIR = "design/adr";
const SCHEMA = "ears-architecture-baseline/v1";
const WORK_SCHEMA = "ears-architecture-work/v1";
const PATTERN_DIR = path.join(__dirname, "..", "..", "docs", "architecture-patterns");
const ID_RE = /^ABL-(\d{3,})$/;

const DRIVER_KINDS = ["functionality", "safety", "performance", "resource", "maintainability", "testability", "modifiability", "reusability", "scalability", "reliability", "security", "complexity", "other"];
const DRIVER_KIND_LABELS = { functionality: "기능", safety: "안전", performance: "성능", resource: "자원", maintainability: "유지보수", testability: "검증 용이성", modifiability: "변경 용이성", reusability: "재사용", scalability: "확장", reliability: "신뢰성", security: "보안", complexity: "복잡도", other: "기타" };
const DRIVER_CLASSES = ["hard", "preference", "undecided"];
const HARD_RESULTS = ["SATISFIED", "VIOLATED", "EVIDENCE_PENDING"];
const RATINGS = ["low", "medium", "high", "unknown"];
const RATING_VALUE = { low: 1, medium: 2, high: 3 };
const TRIGGERS = ["periodic", "event", "unknown"];
const ISOLATION = ["yes", "no", "unknown"];
const RESOURCE_KINDS = ["cpu", "ram", "stack", "wcet", "other"];

class ArchError extends Error { constructor(message, status, details) { super(message); this.status = status || 400; if (details) this.details = details; } }

const text = (v, max) => String(v == null ? "" : v).normalize("NFC").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, max || 300);
const list = (v) => (Array.isArray(v) ? v : []);
// 글 하나로 온 목록도 받는다(AI 가 pros: "단순함" 처럼 주는 일) · 객체가 섞이면 글로 바꾸지 않고 뺀다
const strs = (v, max, n) => (typeof v === "string" ? [v] : list(v)).filter((x) => x != null && typeof x !== "object").map((x) => text(x, max || 300)).filter(Boolean).slice(0, n || 30);
const full = (root, rel) => path.join(root, ...rel.split("/"));
const sha = (s) => "sha256:" + crypto.createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (v) => baselineApi.canonicalize(v);

// ───────────────────────── 패턴 라이브러리 ─────────────────────────

function loadPatterns(dir) {
  const base = dir || PATTERN_DIR;
  const out = { patterns: [], problems: [] };
  if (!fs.existsSync(base)) { out.problems.push("패턴 라이브러리 폴더가 없음"); return out; }
  for (const name of fs.readdirSync(base).filter((n) => n.endsWith(".json")).sort()) {
    let o;
    try { o = JSON.parse(fs.readFileSync(path.join(base, name), "utf8")); } catch (e) { out.problems.push(`${name}: JSON 오류 (${e.message})`); continue; }
    if (!o || o.schema !== "architecture-patterns/v1") { out.problems.push(`${name}: schema 가 architecture-patterns/v1 가 아님`); continue; }
    for (const p of list(o.patterns)) {
      if (!/^[A-Z]+-P-[A-Z0-9-]+$/.test(String(p.id || ""))) out.problems.push(`${name}: 패턴 ID 형식(예 AUTO-P-PIPELINE): ${p.id}`);
      if (!p.name || !p.summary) out.problems.push(`${name}:${p.id}: name·summary 가 없음`);
      if (out.patterns.some((x) => x.id === p.id)) out.problems.push(`${name}:${p.id}: 패턴 ID 중복`);
      out.patterns.push(Object.assign({ domain: o.domain, file: name }, p));
    }
  }
  return out;
}
const patternsFor = (domain, dir) => loadPatterns(dir).patterns.filter((p) => p.domain === domain || p.domain === "general");

// ───────────────────────── 모양 ─────────────────────────

function normalizeDriver(raw, i) {
  if (!raw || typeof raw !== "object") return null;
  const statement = text(raw.statement, 500);
  if (!statement) return null;
  const kind = DRIVER_KINDS.includes(raw.kind) ? raw.kind : "other";
  const klass = DRIVER_CLASSES.includes(raw.class) ? raw.class : "undecided";
  const weight = Number(raw.weight);
  return {
    id: /^DRV-\d{2,}$/.test(String(raw.id || "")) ? raw.id : `DRV-${String(i + 1).padStart(2, "0")}`,
    kind, class: klass, statement,
    requirements: strs(raw.requirements, 80).map((x) => x.replace(/@v\d+$/, "")),
    origin: raw.origin === "human" ? "human" : "requirements",
    value: text(raw.value, 120),
    weight: klass === "preference" && weight >= 0 && weight <= 100 ? Math.round(weight) : klass === "preference" ? 0 : null,
    confirmed: Boolean(raw.confirmed),
    question: text(raw.question, 500),
  };
}

// 기능 분해(STEP 03): 구성요소를 정하기 전에 기능과 관계를 먼저 본다. 기능은 아직 구조가 아니다.
const DEP_KINDS = ["data", "control", "state", "time"];
const TRI = ["yes", "no", "unknown"];
function normalizeFunction(raw, i) {
  if (!raw || typeof raw !== "object") return null;
  const name = text(raw.name, 120);
  if (!name) return null;
  return {
    id: /^FN-\d{2,}$/.test(String(raw.id || "")) ? raw.id : `FN-${String(i + 1).padStart(2, "0")}`,
    name, responsibility: text(raw.responsibility, 800),
    requirements: strs(raw.requirements, 80).map((x) => x.replace(/@v\d+$/, "")),
    depends: list(raw.depends).slice(0, 30).map((d) => ({ on: text(d && d.on, 20), kind: DEP_KINDS.includes(d && d.kind) ? d.kind : "data", note: text(d && d.note, 200) })).filter((d) => /^FN-\d{2,}$/.test(d.on)),
    safety_related: TRI.includes(raw.safety_related) ? raw.safety_related : "unknown",
    change_independent: TRI.includes(raw.change_independent) ? raw.change_independent : "unknown",
  };
}

// 아키텍처 설계 준비성 검토(Readiness): 승인된 요구사항과 설계 입력이 구조를 정하기에 충분한가
const READINESS_ITEMS = ["functional_completeness", "sw_boundary", "interfaces", "execution", "safety", "resources", "priorities"];
const READINESS_LABELS = { functional_completeness: "기능적 완전성(예외 동작 포함)", sw_boundary: "SW 경계", interfaces: "외부 인터페이스", execution: "실행 제약(실행 기준·시간 제약)", safety: "안전 제약·격리 조건", resources: "자원 제약(MCU·RAM 등)", priorities: "설계 우선순위(비교 기준)" };
const READY = ["sufficient", "insufficient", "not_applicable", "unknown"];
// ASR(아키텍처 중요 요구사항): 구조·주요 결정에 영향을 주는 요구사항
const ASR_AFFECTS = ["structure", "interface", "execution", "safety", "resource", "reuse"];
// 파생 요구사항·변경 요청: 설계 중 발견한 누락·실현 불가. 에이전트는 요구사항을 고치지 않고 요청만 낸다.
const CR_KINDS = ["requirement", "design_decision"];
const CR_STATUS = ["proposed", "accepted", "rejected"];

// ── 구조 설계 단계의 확인 사항(findings) — docs/requirements/architecture-questions.md ──
// 아키텍처 에이전트는 구조를 정한다. 요구사항 품질은 요구사항 검사가, 구현 방법은 상세설계가, 검증 방법은 검증 계획이 정한다.
// 분류: 이미 있는 정보로 해결 · AI 가 정함 · 설계 결정(제안) · 후속 단계에서 확인 · 선택 권고 · 지금 답해야 하는 질문(차단)
const RESOLUTIONS = ["RESOLVED_FROM_SOURCE", "AUTO_RESOLVABLE", "DESIGN_DECISION", "DEFERRED", "ADVISORY", "BLOCKING_QUESTION"];
const RESOLUTION_LABELS = { RESOLVED_FROM_SOURCE: "기존 정보로 해결", AUTO_RESOLVABLE: "AI 설계 과정에서 결정", DESIGN_DECISION: "AI 설계 과정에서 결정", DEFERRED: "후속 단계에서 확인", ADVISORY: "선택적 개선 권고", BLOCKING_QUESTION: "지금 답할 질문" };
// 질문을 합치는 근본 원인(같은 원인이면 한 번만 묻는다)
const TOPICS = ["safety_responsibility", "sw_boundary", "isolation", "function_decomposition", "interface", "execution_timing", "resource", "initial_state", "input_validity", "priority_arbitration", "scope_extension", "traceability", "requirement_quality", "other"];
const TOPIC_LABELS = { safety_responsibility: "안전 책임·격리", sw_boundary: "SW 경계", isolation: "독립 실행·간섭 방지", function_decomposition: "기능 분해·책임", interface: "인터페이스", execution_timing: "실행·타이밍", resource: "자원", initial_state: "초기값·첫 판정 전 출력·재초기화", input_validity: "입력 범위·스케일·무효 값", priority_arbitration: "우선순위·유지", scope_extension: "범위 확장", traceability: "추적성", requirement_quality: "요구사항 문장 품질", other: "기타" };
// 이 단계가 아닌 곳에서 다루는 원인: 구조 설계를 막지 않는다
const OFF_STAGE_TOPICS = { traceability: "추적성은 프로그램 검사(요구사항 검사·추적성 관문)가 찾는다", requirement_quality: "요구사항 문장 품질은 요구사항 검사가 다룬다" };
// 사람에게 물을 수 있는 원인(아키텍처 구조를 실제로 바꾸는 것만 — 사용자 2026-11-26 '아키텍처 범위 간소화').
// 그 밖의 원인(초기값·입력 범위·스케일·우선순위·범위 확장·문장·추적성·기능 분해 등)은 묻지 않고 기존 정보로 풀거나 상세설계로 넘긴다
const QUESTION_TOPICS = ["safety_responsibility", "sw_boundary", "isolation", "execution_timing", "resource", "interface"];
const NON_QUESTION = {
  initial_state: ["DEFERRED", "detail_design", "초기값·첫 판정 전 출력은 상세설계에서 구체화(구조적·안전상 제약이 아니면 묻지 않음)"],
  input_validity: ["DEFERRED", "detail_design", "Min/Max·Scaling·Resolution·경계값은 상세설계에서 구체화"],
  function_decomposition: ["DESIGN_DECISION", "", "기능 분해·구성요소 분할은 AI 가 후보로 만들어 비교"],
  priority_arbitration: ["ADVISORY", "", "조건 우선순위는 기존 수용 기준을 쓴다"],
  scope_extension: ["ADVISORY", "", "요구사항에 정의된 범위를 유지한다(범위 확장은 요구사항 단계에서)"],
  other: ["DEFERRED", "detail_design", "구조를 바꾸는 원인이 아니어서 상세설계에서 확인"],
};
const STAGES = ["architecture", "detail_design", "interface", "code", "verification_plan", "test_execution"];
const STAGE_LABELS = { architecture: "구조 설계", detail_design: "상세설계", interface: "인터페이스 설계", code: "코드 구현", verification_plan: "검증 계획", test_execution: "시험 실행" };
// 안전 책임 질문의 답(필수/선호/해당 없음이 아니라 누가 맡는지)
const SAFETY_OPTIONS = [
  { id: "sw", label: "이 소프트웨어가 담당", requirement_change: true },
  { id: "external", label: "상위 시스템 또는 외부 감시가 담당", requirement_change: false },
  { id: "undecided", label: "아직 정해지지 않음(초안은 이 SW 밖으로 가정)", requirement_change: false },
];
function normalizeFinding(raw, i) {
  if (!raw || typeof raw !== "object") return null;
  const statement = text(raw.statement, 800);
  if (!statement) return null;
  const b = raw.blocking && typeof raw.blocking === "object" ? raw.blocking : {};
  const df = raw.defer && typeof raw.defer === "object" ? raw.defer : {};
  const f = {
    id: /^Q-\d{2,}$/.test(String(raw.id || "")) ? raw.id : `Q-${String(i + 1).padStart(2, "0")}`,
    resolution: RESOLUTIONS.includes(raw.resolution) ? raw.resolution : "ADVISORY",
    topic: TOPICS.includes(raw.topic) ? raw.topic : "other",
    statement,
    related: strs(raw.related, 40).map((x) => x.replace(/@v\d+$/, "")),
    sources: strs(raw.sources, 20).map((x) => x.replace(/@v\d+$/, "")),
    resolved_by: text(raw.resolved_by, 600),
    decision: text(raw.decision, 800),
    blocking: { missing: text(b.missing, 500), checked: strs(b.checked, 20), affects: text(b.affects, 500), why: text(b.why, 500), needed_by: STAGES.includes(b.needed_by) ? b.needed_by : "", changes_structure: b.changes_structure === true, alternatives: b.alternatives === true },
    // 이 설계(후보)에서 쓴 가정과 적용 범위 — 미정 사항을 지우거나 임의 확정하지 않고 가정으로 둔다
    assumption: text(raw.assumption, 500),
    defer: { stage: STAGES.includes(df.stage) ? df.stage : "", element: text(df.element, 200), needed_by: text(df.needed_by, 200), blocking: Boolean(df.blocking) },
    options: list(raw.options).slice(0, 5).map((o, k) => typeof o === "string" ? { id: `o${k + 1}`, label: text(o, 200), requirement_change: false } : { id: text(o && o.id, 20) || `o${k + 1}`, label: text(o && o.label, 200), requirement_change: Boolean(o && o.requirement_change) }).filter((o) => o.label),
    requirement_change: Boolean(raw.requirement_change),
    note: text(raw.note, 500),
  };
  if (raw.answer && typeof raw.answer === "object" && raw.answer.option) f.answer = { option: text(raw.answer.option, 20), label: text(raw.answer.label, 200), note: text(raw.answer.note, 500), by: text(raw.answer.by, 80), at: text(raw.answer.at, 40) };
  if (raw.resolved && typeof raw.resolved === "object" && raw.resolved.at) f.resolved = { by: text(raw.resolved.by, 80), at: text(raw.resolved.at, 40), note: text(raw.resolved.note, 500) };
  if (raw.merged) f.merged = strs(raw.merged, 10);
  if (raw.carried) f.carried = true;
  // 사람이 만든 확인 사항(예: 요구사항 변경 요청을 검증 계획으로 넘김) — 다시 분석해도 지우지 않는다
  if (raw.origin === "human") f.origin = "human";
  if (raw.downgraded) f.downgraded = text(raw.downgraded, 200);
  return f;
}
// 지금 답해야 하는 질문: 근거(부족한 정보·확인한 출처·영향받는 결정·막는 이유·필요 시점)를 다 갖추고, 지금(구조 설계) 필요하며, 아직 답하지 않은 것
const isBlockingNow = (f) => f && f.resolution === "BLOCKING_QUESTION" && !f.answer && !f.resolved;
// AI 가 낸 확인 사항을 프로그램 규칙으로 다시 분류하고 같은 원인을 합친다(결정적 — 같은 입력이면 같은 결과)
//  opts: requirementIds(고정본의 요구사항 ID), prior(이전 확인 사항 — 사람의 답·처리를 이어받음), changed(바뀐 요구사항 ID, 없으면 전체를 새로 본 것)
function classifyFindings(rawList, opts) {
  const o = opts || {};
  const ids = new Set(list(o.requirementIds));
  const prior = list(o.prior).map(normalizeFinding).filter(Boolean);
  const changed = o.changed ? new Set(list(o.changed)) : null;
  const notes = [];
  let fs0 = list(rawList).map(normalizeFinding).filter(Boolean);
  for (const f of fs0) {
    f.related = f.related.filter((x) => !/^REQ-/.test(x) || ids.has(x) || !ids.size);
    // 1) 이 단계가 아닌 원인은 권고로(추적성은 프로그램이, 문장 품질은 요구사항 검사가)
    if (OFF_STAGE_TOPICS[f.topic] && f.resolution !== "RESOLVED_FROM_SOURCE") { f.resolution = "ADVISORY"; f.note = OFF_STAGE_TOPICS[f.topic]; }
    // 2) 기존 정보로 해결: 근거 출처가 실제 요구사항이어야 한다
    if (f.resolution === "RESOLVED_FROM_SOURCE" && !f.sources.some((x) => ids.has(x) || /^(DATA|SIG)-|신호|signal/i.test(x))) { f.resolution = "ADVISORY"; f.downgraded = "해결 근거(요구사항 ID)가 없음 — 확인 권고"; }
    // 3a) 구조를 바꾸지 않는 원인은 묻지 않는다(기존 정보로 풀거나 상세설계로)
    if (f.resolution === "BLOCKING_QUESTION" && !QUESTION_TOPICS.includes(f.topic)) {
      const [res, stage, why] = NON_QUESTION[f.topic] || NON_QUESTION.other;
      f.resolution = res; if (stage) f.defer = Object.assign({}, f.defer, { stage }); f.downgraded = why;
    }
    // 3b) 답에 따라 구조가 달라지지 않으면 묻지 않는다 · 대안으로 나타낼 수 있으면 후보에 반영해 비교한다(묻기 전에)
    if (f.resolution === "BLOCKING_QUESTION" && !f.blocking.changes_structure) { f.resolution = "DEFERRED"; f.defer = Object.assign({}, f.defer, { stage: f.defer.stage || "detail_design" }); f.downgraded = "답에 따라 아키텍처 구조가 달라지지 않음 — 상세설계에서 확인"; }
    if (f.resolution === "BLOCKING_QUESTION" && f.blocking.alternatives) { f.resolution = "DESIGN_DECISION"; f.downgraded = "설계 대안으로 나타낼 수 있음 — 후보 구조에 반영해 비교(구조 승인 때 고른 후보가 답이 됨)"; }
    // 3) 차단 질문의 조건
    if (f.resolution === "BLOCKING_QUESTION") {
      const b = f.blocking;
      const missing = [!b.missing && "부족한 정보", !b.checked.length && "확인한 출처", !b.affects && "영향받는 설계 결정", !b.why && "막는 이유", !b.needed_by && "필요한 시점"].filter(Boolean);
      if (missing.length) { f.resolution = "DEFERRED"; f.defer = Object.assign({}, f.defer, { stage: f.defer.stage || "detail_design" }); f.downgraded = `질문 근거 부족(${missing.join("·")}) — 후속 단계에서 확인`; }
      else if (b.needed_by !== "architecture") { f.resolution = "DEFERRED"; f.defer = Object.assign({}, f.defer, { stage: b.needed_by, blocking: true }); f.downgraded = `${STAGE_LABELS[b.needed_by]} 전에 필요 — 지금 구조 설계를 막지 않음`; }
    }
    if (f.resolution === "DEFERRED" && !f.defer.stage) f.defer.stage = "detail_design";
  }
  // 4) 같은 원인 합치기: 같은 주제·같은 분류는 하나로(관련 요구사항·출처를 모으고 다른 문장은 merged 에)
  const rank = { BLOCKING_QUESTION: 0, DEFERRED: 1, DESIGN_DECISION: 2, AUTO_RESOLVABLE: 3, ADVISORY: 4, RESOLVED_FROM_SOURCE: 5 };
  const out = [];
  for (const f of fs0.slice().sort((a, b) => rank[a.resolution] - rank[b.resolution])) {
    const key = f.topic === "other" ? null : f.topic;
    // 차단 질문이 있는 주제의 나머지(후속·결정·권고)는 그 질문에 합친다(한 번 답하면 함께 정해짐)
    const hit = key && out.find((x) => x.topic === key && (x.resolution === f.resolution || x.resolution === "BLOCKING_QUESTION" && f.resolution !== "RESOLVED_FROM_SOURCE"));
    if (hit) {
      for (const r of f.related) if (!hit.related.includes(r)) hit.related.push(r);
      for (const r of f.sources) if (!hit.sources.includes(r)) hit.sources.push(r);
      hit.merged = [...new Set([...(hit.merged || []), f.statement])].slice(0, 10);
      if (!hit.options.length && f.options.length) hit.options = f.options;
      continue;
    }
    out.push(f);
  }
  // 5) 안전 책임 질문은 누가 맡는지 묻는다(필수/선호가 아님). 다른 차단 질문도 '아직 정하지 않음'을 고를 수 있다
  for (const f of out) {
    if (f.resolution !== "BLOCKING_QUESTION") continue;
    if (f.topic === "safety_responsibility") f.options = SAFETY_OPTIONS.map((x) => Object.assign({}, x));
    else {
      if (!f.options.length) f.options = [{ id: "o1", label: "AI 제안대로 진행", requirement_change: false }];
      if (!f.options.some((x) => /정해지지|정하지 않/.test(x.label))) f.options.push({ id: "later", label: "아직 정해지지 않음(초안은 가정으로 진행)", requirement_change: false });
    }
  }
  // 6) 이전 답·처리 이어받기: 같은 원인의 질문에 이미 답했으면 다시 묻지 않는다
  for (const f of out) {
    const was = prior.find((x) => x.topic === f.topic && f.topic !== "other" && (x.answer || x.resolved)) || prior.find((x) => (x.answer || x.resolved) && similarity(x.statement, f.statement) >= 0.5);
    if (was) { if (was.answer) f.answer = was.answer; if (was.resolved) f.resolved = was.resolved; f.carried = true; }
  }
  // 7) 바뀐 곳만 본 분석: 바뀌지 않은 요구사항에만 걸린 새 차단 질문은 막지 않는다(이전에 묻지 않은 것을 새로 묻지 않음) — 이전 것은 이어받음
  if (changed) {
    for (const f of out) {
      if (f.resolution === "BLOCKING_QUESTION" && !f.carried && f.related.length && !f.related.some((r) => changed.has(r)) && !prior.some((x) => x.topic === f.topic)) {
        f.resolution = "ADVISORY"; f.downgraded = "바뀌지 않은 요구사항에서 새로 나온 질문 — 막지 않음(다음 전체 분석에서 확인)";
      }
    }
    for (const x of prior) if (!out.some((f) => f.topic === x.topic && x.topic !== "other") && x.related.length && !x.related.some((r) => changed.has(r))) out.push(Object.assign({}, x, { carried: true }));
  }
  // 사람이 만든 확인 사항은 늘 이어받는다(AI 가 다시 내지 않아도) — 예전에는 다시 분석하면 사라졌다(QA 2026-11-26)
  for (const x of prior) if (x.origin === "human" && !out.some((f) => f.origin === "human" && f.statement === x.statement)) out.push(Object.assign({}, x, { carried: true }));
  const MAX_BLOCKING = 5;
  let nb = 0;
  for (const f of out) if (f.resolution === "BLOCKING_QUESTION" && !f.answer && !f.resolved && ++nb > MAX_BLOCKING) { f.resolution = "DEFERRED"; f.defer = Object.assign({}, f.defer, { stage: f.blocking.needed_by && f.blocking.needed_by !== "architecture" ? f.blocking.needed_by : "detail_design" }); f.downgraded = `차단 질문이 ${MAX_BLOCKING}건을 넘음 — 앞의 ${MAX_BLOCKING}건만 지금 묻고 나머지는 후속 단계에서 확인`; }
  if (nb > MAX_BLOCKING) notes.push(`차단 질문 ${nb}건 중 ${MAX_BLOCKING}건만 남김`);
  out.splice(80);
  out.forEach((f, i) => { f.id = `Q-${String(i + 1).padStart(2, "0")}`; });
  return { findings: out, notes };
}
// 결정 기록(ADR)·상세설계로 넘길 미확정 사항: 미정 정보·관련 요구사항·영향받는 설계 요소·해결 단계·승인 차단 여부·설계에서 쓴 가정
function openItems(work) {
  return list(work && work.findings).filter((f) => f && (f.resolution === "DEFERRED" || f.resolution === "DESIGN_DECISION" || f.resolution === "BLOCKING_QUESTION")).map((f) => ({
    id: f.id, topic: f.topic, resolution: f.resolution, statement: f.statement, related: f.related || [],
    element: (f.defer && f.defer.element) || (f.blocking && f.blocking.affects) || "", stage: f.resolution === "DEFERRED" ? (f.defer && f.defer.stage) || "" : f.resolution === "BLOCKING_QUESTION" ? "architecture" : "",
    blocking: f.resolution === "BLOCKING_QUESTION" ? !f.answer && !f.resolved : Boolean(f.defer && f.defer.blocking && !f.resolved),
    assumption: f.assumption || "", decision: f.decision || "", answer: f.answer ? f.answer.label : "", resolved: f.resolved ? f.resolved.note || "처리함" : "",
  }));
}
// 후속 단계에서 확인할 것(그 단계 승인 전에 다시 본다): 아직 처리하지 않은 것. blocking 이면 그 단계 승인을 막는다
function deferredFor(work, stages) {
  const want = new Set(list(stages));
  return list(work && work.findings).filter((f) => f && f.resolution === "DEFERRED" && want.has(f.defer && f.defer.stage) && !f.resolved);
}

function normalizeComponent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id, 60);
  if (!id) return null;
  const ex = raw.execution && typeof raw.execution === "object" ? raw.execution : {};
  const sf = raw.safety && typeof raw.safety === "object" ? raw.safety : {};
  const period = Number(ex.period_ms);
  return {
    id, name: text(raw.name, 120), responsibility: text(raw.responsibility, 800),
    requirements: strs(raw.requirements, 80).map((x) => x.replace(/@v\d+$/, "")),
    functions: strs(raw.functions, 20, 40).filter((x) => /^FN-\d{2,}$/.test(x)),
    parent: text(raw.parent, 60) || null,
    execution: {
      trigger: TRIGGERS.includes(ex.trigger) ? ex.trigger : "unknown",
      // 주기는 요구사항이나 사람이 준 값만. 출처가 없으면 버린다(지어내지 않음).
      period_ms: period > 0 && text(ex.period_source, 120) ? period : null,
      period_source: period > 0 ? text(ex.period_source, 120) : "",
      order: text(ex.order, 200), priority: text(ex.priority, 60),
    },
    modes: list(raw.modes).slice(0, 20).map((m) => ({ mode: text(m && m.mode, 80), behavior: text(m && m.behavior, 400) })).filter((m) => m.mode),
    safety: { isolation_needed: ISOLATION.includes(sf.isolation_needed) ? sf.isolation_needed : "unknown", rationale: text(sf.rationale, 500) },
  };
}

// 구성요소 ID 는 CMP-대문자. AI 가 CMP-OverTemp 처럼 쓰면 CMP-OVERTEMP 로 맞추고, 연결·제어 흐름의 참조도 같이 바꾼다.
const fixCmp = (x) => { const s = String(x == null ? "" : x).trim(); return /^cmp-/i.test(s) ? "CMP-" + s.slice(4).toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 40) : s; };
// AI 가 목록 칸에 객체 대신 글을 주는 일이 있다(예: shared_resources: ["CPU 시간(공유)"]) — 버리지 않고 이름으로 받는다.
// 예전에는 글에 속성을 넣으려다 서버 오류(TypeError)로 후보 생성 전체가 멈췄다(사용자 보고 2026-11-26)
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function coerceList(v, key) { return list(typeof v === "string" ? [v] : v).map((x) => (isObj(x) ? x : typeof x === "string" && x.trim() ? { [key]: x.trim() } : null)).filter(Boolean); }
function fixIds(raw) {
  const r = JSON.parse(JSON.stringify(raw));
  r.components = coerceList(r.components, "name").map((c, i) => { if (c.id) return c; const k = String(c.name || "").toUpperCase().replace(/[^A-Z0-9_]/g, ""); return Object.assign({ id: `CMP-${k ? k.slice(0, 30) : `C${i + 1}`}` }, c); });
  r.connections = coerceList(r.connections, "signal").filter((c) => c.owner || list(c.accesses).length);
  r.control_flow = coerceList(r.control_flow, "note").filter((c) => c.from && c.to);
  r.shared_resources = coerceList(r.shared_resources, "name");
  r.resources = coerceList(r.resources, "note").filter((x) => x.component || x.kind);
  for (const c of r.components) { c.modes = coerceList(c.modes, "mode"); for (const k of ["execution", "safety"]) if (!isObj(c[k])) c[k] = {}; }
  for (const c of r.connections) c.accesses = coerceList(c.accesses, "by");
  for (const c of list(r.components)) { if (c) { c.id = fixCmp(c.id); if (c.parent) c.parent = fixCmp(c.parent); } }
  for (const c of list(r.connections)) { if (c) { c.owner = fixCmp(c.owner); for (const a of list(c.accesses)) if (a) a.by = fixCmp(a.by); } }
  for (const f of list(r.control_flow)) if (f) { f.from = fixCmp(f.from); f.to = fixCmp(f.to); }
  for (const s of list(r.shared_resources)) if (isObj(s)) s.users = list(typeof s.users === "string" ? [s.users] : s.users).map(fixCmp);
  for (const x of list(r.resources)) if (x) x.component = fixCmp(x.component);
  return r;
}

function normalizeCandidate(raw0, i) {
  if (!raw0 || typeof raw0 !== "object") return null;
  const raw = fixIds(raw0);
  const id = /^ARC-[A-Z]$/.test(String(raw.id || "")) ? raw.id : `ARC-${String.fromCharCode(65 + i)}`;
  return {
    id, title: text(raw.title, 120), summary: text(raw.summary, 1000),
    patterns: strs(raw.patterns, 60, 10),
    components: list(raw.components).slice(0, 40).map(normalizeComponent).filter(Boolean),
    // 구성요소 사이 데이터 흐름: 설계 모델과 같은 모양(by 는 구성요소 ID 또는 EXT)
    connections: designModel.normalize({ connections: raw.connections }).connections,
    control_flow: list(raw.control_flow).slice(0, 60).map((c) => ({ from: text(c && c.from, 60), to: text(c && c.to, 60), kind: ["call", "event", "data"].includes(c && c.kind) ? c.kind : "call", note: text(c && c.note, 200) })).filter((c) => c.from && c.to),
    shared_resources: list(raw.shared_resources).slice(0, 20).map((r) => ({ name: text(r && r.name, 80), users: strs(r && r.users, 60), sync: text(r && r.sync, 200) })).filter((r) => r.name),
    // 자원 예산: 값은 출처가 있을 때만. 없으면 '측정 필요'
    resources: list(raw.resources).slice(0, 40).map((r) => {
      const v = text(r && r.value, 60);
      const src = text(r && r.source, 120);
      return { component: text(r && r.component, 60), kind: RESOURCE_KINDS.includes(r && r.kind) ? r.kind : "other", value: v && src ? v : "", source: v && src ? src : "", status: v && src ? "given" : "measurement_needed" };
    }),
    rationale: text(raw.rationale, 1500),
    rules_applied: strs(raw.rules_applied, 40, 40),
    pros: strs(raw.pros, 400), cons: strs(raw.cons, 400), risks: strs(raw.risks, 400), unknowns: strs(raw.unknowns, 400),
    effort: text(raw.effort, 400),
  };
}

function normalizeEvaluation(raw, candidateIds, driverIds) {
  const out = {};
  for (const id of candidateIds) {
    const e = raw && raw[id] && typeof raw[id] === "object" ? raw[id] : {};
    out[id] = {
      hard: list(e.hard).filter((h) => h && driverIds.has(h.driver)).map((h) => ({ driver: h.driver, result: HARD_RESULTS.includes(h.result) ? h.result : "EVIDENCE_PENDING", evidence: text(h.evidence, 800), by: h.by === "human" ? "human" : "ai" })),
      preferences: list(e.preferences).filter((p) => p && driverIds.has(p.driver)).map((p) => ({ driver: p.driver, rating: RATINGS.includes(p.rating) ? p.rating : "unknown", rationale: text(p.rationale, 800), by: p.by === "human" ? "human" : "ai" })),
      summary: text(e.summary, 1000),
      // 평가한 후보의 해시. 후보를 고치면 맞지 않게 되어 '재평가 필요'가 된다.
      candidate_hash: text(e.candidate_hash, 80),
    };
    // 근거 없는 등급은 미확인
    for (const p of out[id].preferences) if (p.rating !== "unknown" && !p.rationale) p.rating = "unknown";
    for (const h of out[id].hard) if (h.result === "SATISFIED" && !h.evidence) h.result = "EVIDENCE_PENDING";
  }
  return out;
}

function normalizeWork(raw) {
  const w = raw && typeof raw === "object" ? raw : {};
  const drivers = list(w.drivers).slice(0, 60).map(normalizeDriver).filter(Boolean);
  const seen = new Set();
  for (const d of drivers) { while (seen.has(d.id)) d.id = `DRV-${String(seen.size + 1).padStart(2, "0")}`; seen.add(d.id); }
  const candidates = list(w.candidates).slice(0, 5).map(normalizeCandidate).filter(Boolean);
  const functions = list(w.functions).slice(0, 80).map(normalizeFunction).filter(Boolean);
  const readiness = READINESS_ITEMS.map((item) => {
    const r = list(w.readiness).find((x) => x && x.item === item) || {};
    return { item, status: READY.includes(r.status) ? r.status : "unknown", note: text(r.note, 600), by: r.by === "human" ? "human" : r.by === "fixed" ? "fixed" : "ai" };
  });
  const asr = list(w.asr).slice(0, 200).map((a) => ({ requirement: text(a && a.requirement, 80).replace(/@v\d+$/, ""), significant: Boolean(a && a.significant), affects: strs(a && a.affects, 20).filter((x) => ASR_AFFECTS.includes(x)), reason: text(a && a.reason, 500) })).filter((a) => a.requirement);
  const changeRequests = list(w.change_requests).slice(0, 100).map((c, i) => ({
    id: /^CR-\d{2,}$/.test(String(c && c.id || "")) ? c.id : `CR-${String(i + 1).padStart(2, "0")}`,
    kind: CR_KINDS.includes(c && c.kind) ? c.kind : "requirement",
    statement: text(c && c.statement, 800), reason: text(c && c.reason, 800),
    related: strs(c && c.related, 80), source: text(c && c.source, 40) || "architecture-agent",
    status: CR_STATUS.includes(c && c.status) ? c.status : "proposed", decided_by: text(c && c.decided_by, 80), note: text(c && c.note, 500),
    // AI 추천 수정안(요구사항마다 고친 전체 문장·수용 기준). 정할 수 없는 값은 '[정할 값: …]' 으로 남기고 open 에 적는다 — 사람이 적용·수정
    suggestions: normalizeSuggestions(c && c.suggestions),
    // 처음 제안된 시각(요구사항 검토가 이 뒤에 같은 빈칸을 다시 봤는지 판단) — 없으면 저장하지 않음
    created_at: text(c && c.created_at, 40),
  })).map((c) => { if (!c.suggestions.length) delete c.suggestions; if (!c.created_at) delete c.created_at; return c; }).filter((c) => c.statement);
  { const used = new Set(); let top = Math.max(0, ...changeRequests.map((c) => Number(c.id.replace(/\D/g, "")) || 0));
    for (const c of changeRequests) { if (used.has(c.id)) c.id = `CR-${String(++top).padStart(2, "0")}`; used.add(c.id); } }
  const bl = w.requirements_baseline && typeof w.requirements_baseline === "object" ? { id: text(w.requirements_baseline.id, 60), hash: text(w.requirements_baseline.hash, 120) } : null;
  const findings = list(w.findings).slice(0, 80).map(normalizeFinding).filter(Boolean);
  const cache = w.analysis_cache && typeof w.analysis_cache === "object" && w.analysis_cache.input_hash ? { input_hash: text(w.analysis_cache.input_hash, 100), next_hash: text(w.analysis_cache.next_hash, 100), at: text(w.analysis_cache.at, 40), raw: w.analysis_cache.raw && typeof w.analysis_cache.raw === "object" ? w.analysis_cache.raw : null } : null;
  return {
    // 구조 설계의 확인 사항(분류·근거·답) — 차단 질문만 사람에게 먼저 보인다
    findings,
    ...(cache ? { analysis_cache: cache } : {}),
    schema: WORK_SCHEMA,
    requirements_baseline: bl,
    drivers,
    readiness,
    asr,
    change_requests: changeRequests,
    functions,
    candidates,
    single_candidate_reason: text(w.single_candidate_reason, 800),
    evaluation: normalizeEvaluation(w.evaluation, candidates.map((c) => c.id), new Set(drivers.map((d) => d.id))),
    // 설계 기준 확정(후보 만들기 전) 시각·확정자, 확정 뒤·비교 뒤의 기준 변경 기록(결정 기록에 보인다)
    criteria_confirmed: w.criteria_confirmed && typeof w.criteria_confirmed === "object" && w.criteria_confirmed.at ? { at: text(w.criteria_confirmed.at, 40), by: text(w.criteria_confirmed.by, 80) } : null,
    // 기능 구조 확정(후보 만들기 전): 확정 시각·확정자와 그때의 기능 구조 해시. 기능을 고치면 해시가 달라져 다시 확정해야 한다.
    functions_confirmed: w.functions_confirmed && typeof w.functions_confirmed === "object" && w.functions_confirmed.at ? { at: text(w.functions_confirmed.at, 40), by: text(w.functions_confirmed.by, 80), hash: text(w.functions_confirmed.hash, 100) } : null,
    // 지금 후보를 만들 때 쓴 기능 구조(해시)·설계 기준 확정 시각 — 그 뒤 바뀌면 후보는 이전 기준
    candidates_basis: w.candidates_basis && typeof w.candidates_basis === "object" ? { functions_hash: text(w.candidates_basis.functions_hash, 100), criteria_at: text(w.candidates_basis.criteria_at, 40) } : null,
    criteria_log: list(w.criteria_log).slice(-200).map((x) => ({
      at: text(x && x.at, 40), by: text(x && x.by, 80), driver: text(x && x.driver, 20), field: text(x && x.field, 20),
      from: text(x && x.from, 120), to: text(x && x.to, 120), after_evaluation: Boolean(x && x.after_evaluation), note: text(x && x.note, 300),
    })).filter((x) => x.driver && x.at),
  };
}

// ───────────────────────── 결정적 검사·지표·순위 ─────────────────────────

function leafIds(baseline) {
  const reqs = list(baseline && baseline.requirements);
  const parents = new Set(reqs.map((r) => r.parent).filter(Boolean));
  return reqs.map((r) => r.requirement_id).filter((id) => !parents.has(id));
}

const candidateHash = (c) => sha(canonical(c));
// 기능 구조의 해시(확정한 기능 구조와 지금 기능 구조가 같은지, 후보가 어느 기능 구조로 만들어졌는지)
const functionsHash = (fns) => sha(canonical(list(fns).map((f, i) => normalizeFunction(f, i)).filter(Boolean)));

// 후보 하나의 구조 검사와 지표(AI 를 쓰지 않는다). functions: 기능 분해 결과(있으면 기능 배치도 본다)
function metrics(candidate, baseline, functions) {
  const leaves = leafIds(baseline);
  const allocated = new Set(candidate.components.flatMap((c) => c.requirements));
  const ids = new Set(candidate.components.map((c) => c.id));
  const problems = [];
  for (const c of candidate.components) {
    if (!designModel.COMPONENT_RE.test(c.id)) problems.push(`${candidate.id}/${c.id}: 구성요소 ID 는 CMP- 로 시작`);
    if (!c.responsibility) problems.push(`${candidate.id}/${c.id}: 책임이 비어 있음`);
    if (c.parent && !ids.has(c.parent)) problems.push(`${candidate.id}/${c.id}: 상위 구성요소 ${c.parent} 가 없음`);
  }
  if (ids.size !== candidate.components.length) problems.push(`${candidate.id}: 구성요소 ID 중복`);
  const unallocated = leaves.filter((r) => !allocated.has(r));
  for (const r of unallocated) problems.push(`${candidate.id}: ${r} 가 어느 구성요소에도 할당되지 않음`);
  const known = new Set(list(baseline && baseline.requirements).map((r) => r.requirement_id));
  for (const c of candidate.components) for (const r of c.requirements) if (!known.has(r)) problems.push(`${candidate.id}/${c.id}: ${r} 는 요구사항 고정본에 없음`);
  for (const con of candidate.connections) for (const a of con.accesses) if (!designModel.isExternal(a.by) && !ids.has(a.by)) problems.push(`${candidate.id}: 연결 ${con.signal} 의 ${a.by} 는 후보에 없는 구성요소`);
  for (const f of candidate.control_flow) for (const end of [f.from, f.to]) if (!designModel.isExternal(end) && !ids.has(end)) problems.push(`${candidate.id}: 제어 흐름의 ${end} 는 후보에 없는 구성요소`);
  const fns = list(functions);
  const placed = new Map();
  for (const c of candidate.components) for (const f of c.functions) {
    if (!fns.some((x) => x.id === f)) problems.push(`${candidate.id}/${c.id}: 기능 ${f} 는 기능 분해에 없음`);
    else if (placed.has(f)) problems.push(`${candidate.id}: 기능 ${f} 가 ${placed.get(f)} 와 ${c.id} 두 곳에 있음`);
    else placed.set(f, c.id);
  }
  const unplacedFunctions = fns.length ? fns.filter((f) => !placed.has(f.id)).map((f) => f.id) : [];
  for (const f of unplacedFunctions) problems.push(`${candidate.id}: 기능 ${f} 가 어느 구성요소에도 없음`);
  // 순환 의존(제어 흐름 호출 기준)
  const graph = new Map(candidate.components.map((c) => [c.id, []]));
  for (const f of candidate.control_flow) if (f.kind === "call" && graph.has(f.from) && graph.has(f.to)) graph.get(f.from).push(f.to);
  const cycles = [];
  const seen = new Set(); const stack = new Set();
  const dfs = (n, pathv) => { if (stack.has(n)) { cycles.push([...pathv.slice(pathv.indexOf(n)), n].join(" → ")); return; } if (seen.has(n)) return; seen.add(n); stack.add(n); for (const m of graph.get(n) || []) dfs(m, [...pathv, n]); stack.delete(n); };
  for (const n of graph.keys()) dfs(n, []);
  // 구성요소 사이에 걸친 기능 의존(분할로 생긴 인터페이스)
  const crossDeps = fns.flatMap((f) => f.depends.filter((d) => placed.get(d.on) && placed.get(f.id) && placed.get(d.on) !== placed.get(f.id)).map((d) => `${f.id}→${d.on}(${d.kind})`));
  const crossing = candidate.connections.filter((c) => new Set(c.accesses.map((a) => a.by)).size > 1).length;
  return {
    problems,
    components: candidate.components.length,
    connections: candidate.connections.length,
    cross_component_signals: crossing,
    control_edges: candidate.control_flow.length,
    call_cycles: cycles,
    cross_component_dependencies: crossDeps,
    unplaced_functions: unplacedFunctions,
    shared_resources: candidate.shared_resources.length,
    unallocated,
    execution_unknown: candidate.components.filter((c) => c.execution.trigger === "unknown").map((c) => c.id),
    resources_measurement_needed: candidate.resources.filter((r) => r.status === "measurement_needed").length,
  };
}

// 두 후보의 구성요소 분할이 같은가(요구사항 묶음이 같으면 사실상 같은 구조)
function partitionKey(c) { return c.components.map((x) => [...x.requirements].sort().join(",")).filter(Boolean).sort().join("|"); }
function similarPairs(candidates) {
  const out = [];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    if (partitionKey(candidates[i]) === partitionKey(candidates[j]) && candidates[i].components.length === candidates[j].components.length) out.push([candidates[i].id, candidates[j].id]);
  }
  return out;
}

// 필수 제약 → 선호 조건 가중 비교 → 민감도. 숫자는 설명용 비교 값이다(성능·안전 평가가 아님).
function rank(work, baseline) {
  const w = normalizeWork(work);
  const hardDrivers = w.drivers.filter((d) => d.class === "hard");
  const prefs = w.drivers.filter((d) => d.class === "preference" && d.weight > 0);
  const totalW = prefs.reduce((s, d) => s + d.weight, 0);
  const rows = w.candidates.map((c) => {
    const ev = w.evaluation[c.id] || { hard: [], preferences: [] };
    const m = metrics(c, baseline, w.functions);
    const stale = Boolean(ev.candidate_hash) && ev.candidate_hash !== candidateHash(c);
    const evaluated = Boolean(ev.candidate_hash) && !stale;
    const hard = hardDrivers.map((d) => ev.hard.find((h) => h.driver === d.id) || { driver: d.id, result: "EVIDENCE_PENDING", evidence: "평가하지 않음", by: "ai" });
    // 구조 검사 문제(할당 누락 등)는 기능 필수 제약 위반으로 본다
    const structural = m.problems.length ? "VIOLATED" : null;
    const status = structural || (!evaluated ? "NOT_EVALUATED" : hard.some((h) => h.result === "VIOLATED") ? "VIOLATED" : hard.some((h) => h.result === "EVIDENCE_PENDING") ? "EVIDENCE_PENDING" : "SATISFIED");
    const ratingOf = (d) => { const p = ev.preferences.find((x) => x.driver === d.id); return p ? p.rating : "unknown"; };
    const unknownPrefs = prefs.filter((d) => ratingOf(d) === "unknown").map((d) => d.id);
    const score = (weights) => {
      const known = prefs.filter((d) => RATING_VALUE[ratingOf(d)]);
      const ws = known.reduce((s, d) => s + (weights[d.id] || 0), 0);
      return ws ? known.reduce((s, d) => s + (weights[d.id] || 0) * RATING_VALUE[ratingOf(d)], 0) / ws : null;
    };
    return { id: c.id, title: c.title, status, stale, hard, metrics: m, unknown_preferences: unknownPrefs, score, ratingOf };
  });
  const base = Object.fromEntries(prefs.map((d) => [d.id, d.weight]));
  const order = (weights) => rows.filter((r) => r.status !== "VIOLATED" && r.status !== "NOT_EVALUATED").map((r) => ({ id: r.id, s: r.score(weights) })).filter((x) => x.s !== null).sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));
  const top = order(base);
  // 민감도: 선호 조건 하나의 가중치를 ±10%p(전체 대비) 바꿨을 때 1위가 바뀌는가
  const flips = [];
  if (top.length >= 2 && totalW) {
    for (const d of prefs) for (const delta of [-0.1, 0.1]) {
      const weights = Object.assign({}, base, { [d.id]: Math.max(0, base[d.id] + delta * totalW) });
      const t = order(weights);
      if (t[0] && t[0].id !== top[0].id) flips.push({ driver: d.id, change: delta > 0 ? "+10%p" : "-10%p", new_top: t[0].id });
    }
  }
  return {
    candidates: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, stale: r.stale, hard: r.hard, metrics: r.metrics, unknown_preferences: r.unknown_preferences, relative: r.status === "VIOLATED" ? null : (r.score(base) === null ? null : Math.round(r.score(base) * 100) / 100) })),
    recommended: top.length ? top[0].id : null,
    recommendation_basis: top.length ? "필수 제약을 어기지 않은 후보 가운데 선호 조건 등급(낮음 1·보통 2·높음 3)을 가중치로 평균한 값이 가장 큰 후보 — 설명용 비교이며 성능·안전 평가가 아니다" : "추천할 후보가 없음(필수 제약 위반이거나 선호 조건 등급이 없음)",
    sensitive: flips.length > 0,
    sensitivity: flips,
    similar: similarPairs(w.candidates),
    note: totalW ? null : "선호 조건의 가중치가 없어 비교하지 않음",
  };
}

// ───────────────────────── 작업본 ─────────────────────────

function loadWork(root) {
  try {
    const o = JSON.parse(fs.readFileSync(full(root, WORK_FILE), "utf8"));
    if (o && o.schema === WORK_SCHEMA) return Object.assign({ exists: true }, normalizeWork(o), { updated_at: o.updated_at || null });
  } catch (_) { /* 없음 */ }
  return Object.assign({ exists: false }, normalizeWork({}), { updated_at: null });
}

function saveWork(root, work, now) {
  const w = normalizeWork(work);
  const f = full(root, WORK_FILE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(Object.assign({}, w, { updated_at: (now || new Date()).toISOString() }), null, 1) + "\n");
  return w;
}

// ───────────────────────── 승인본(ABL)·ADR ─────────────────────────

function hashOf(b) {
  return sha(canonical({ schema: SCHEMA, architecture_baseline_id: b.architecture_baseline_id, requirements_baseline: b.requirements_baseline, previous: b.previous_architecture_baseline || null, architecture: b.architecture, functions: b.functions, adr: b.adr, rule_profile_hash: b.rule_profile_hash || null }));
}

function loadBaselines(root) {
  const dir = full(root, BASELINE_DIR);
  const out = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : []) {
    const rel = `${BASELINE_DIR}/${name}`;
    let b;
    try { b = JSON.parse(fs.readFileSync(full(root, rel), "utf8")); } catch (_) { throw new ArchError(`${rel} 를 읽을 수 없습니다(JSON 이 깨졌습니다).`, 409); }
    const m = ID_RE.exec((b && b.architecture_baseline_id) || "");
    if (!m) throw new ArchError(`${rel} 의 architecture_baseline_id 가 올바르지 않습니다.`, 409);
    out.push({ n: parseInt(m[1], 10), file: rel, baseline: b });
  }
  return out.sort((a, b) => a.n - b.n);
}

function verify(b) {
  const errors = [];
  if (!b || b.schema !== SCHEMA) return { ok: false, errors: [`지원하지 않는 형식: ${b && b.schema}`] };
  if (!b.requirements_baseline || !b.requirements_baseline.id) errors.push("근거 요구사항 Baseline 이 없음");
  if (!b.architecture || !Array.isArray(b.architecture.components)) errors.push("아키텍처 구조가 없음");
  if (!errors.length && hashOf(b) !== b.architecture_hash) errors.push("architecture_hash 가 내용과 맞지 않음");
  return { ok: !errors.length, errors };
}

const DEFAULT_EVIDENCE_PLAN = "구현·시험 뒤 검증 계획에서 증거 확보(실측 시간·자원, 안전 분석) — 증거가 나오면 구조를 다시 확인(기본 계획)";
// 선택한 후보를 승인한다. input: { candidate_id, approver, reason, accepted_cons, pending_plan, project, now, baseline(요구사항 BL), rule_profile_hash }
function approve(root, input) {
  const o = input || {};
  // 이름·후보 ID 는 글자만 받는다(객체·배열을 보내면 "[object Object]" 나 "x" 가 승인자로 남을 수 있었다)
  if (o.approver != null && typeof o.approver !== "string") throw new ArchError("승인자 이름은 글자여야 합니다.");
  if (o.candidate_id != null && typeof o.candidate_id !== "string") throw new ArchError("후보 ID 는 글자여야 합니다(예: ARC-A).");
  for (const k of ["reason", "pending_plan", "title"]) if (o[k] != null && typeof o[k] !== "string") throw new ArchError(`${k} 는 글자여야 합니다.`);
  const who = text(o.approver, 80);
  if (!who) throw new ArchError("승인자 이름이 필요합니다.");
  const bl = o.baseline;
  if (!bl) throw new ArchError("요구사항 고정본(BL)이 없습니다.", 409);
  const work = loadWork(root);
  if (!work.exists) throw new ArchError("아키텍처 작업본이 없습니다(결정 요인·후보를 먼저 만드세요).", 409);
  const ref = work.requirements_baseline;
  if (!ref || ref.id !== bl.baseline_id || ref.hash !== bl.baseline_hash) throw new ArchError(`아키텍처 작업본이 최신 요구사항 고정본 ${bl.baseline_id} 를 근거로 하지 않습니다. 결정 요인과 후보를 다시 검토하세요.`, 409);
  const cand = work.candidates.find((c) => c.id === o.candidate_id);
  if (!cand) throw new ArchError(`후보 ${o.candidate_id || "(없음)"} 가 작업본에 없습니다.`);
  const undecided = work.drivers.filter((d) => d.class === "undecided");
  const unconfirmed = work.drivers.filter((d) => !d.confirmed);
  const r = rank(work, bl);
  const row = r.candidates.find((c) => c.id === cand.id);
  const problems = [];
  if (!work.drivers.length) problems.push("설계 결정 요인이 없습니다");
  if (undecided.length) problems.push(`필수인지 선호인지 정하지 않은 결정 요인: ${undecided.map((d) => d.id).join(", ")}`);
  const openQ = work.findings.filter(isBlockingNow);
  if (openQ.length) problems.push(`답하지 않은 구조 설계 질문: ${openQ.map((f) => `${f.id}(${f.statement.slice(0, 40)})`).join(", ")}`);
  if (work.candidates.length < 2 && !work.single_candidate_reason) problems.push("후보가 하나뿐인 사유가 없습니다");
  if (row.status === "NOT_EVALUATED") problems.push(`${cand.id} 는 ${row.stale ? "평가 뒤에 바뀌어 다시 평가해야" : "아직 평가하지 않아 평가해야"} 합니다`);
  if (!work.functions.length) problems.push("기능 분해(기능과 관계)가 없습니다 — 구성요소를 정하기 전에 기능을 먼저 정리하세요");
  const openCr = work.change_requests.filter((c) => c.kind === "requirement" && c.status !== "rejected");
  if (openCr.length) problems.push(`요구사항 변경 요청 ${openCr.map((c) => `${c.id}(${c.status === "accepted" ? "수락 — 요구사항에 반영해 새 고정본을 만든 뒤 아키텍처를 다시 평가" : "결정 대기"})`).join(", ")} 이 남아 있습니다`);
  if (row.status === "VIOLATED") problems.push(`${cand.id} 는 필수 제약을 어깁니다 — 승인할 수 없습니다: ${[...row.metrics.problems, ...row.hard.filter((h) => h.result === "VIOLATED").map((h) => `${h.driver}: ${h.evidence}`)].join("; ")}`);
  const pending = row.hard.filter((h) => h.result === "EVIDENCE_PENDING");
  // 조건부 승인(구조만으로는 필수 제약의 증거가 없음): 계획을 적지 않았으면 기본 계획으로 승인하고 결정 기록에 그대로 남긴다
  // (예전에는 빈칸이면 승인을 거부해 사용자가 막혔다 — 사용자 QA 2026-11-26). 증거는 검증 계획·시험에서 확보한다
  const plan = text(o.pending_plan, 800) || (row.status === "EVIDENCE_PENDING" ? DEFAULT_EVIDENCE_PLAN : "");
  const differs = r.recommended && r.recommended !== cand.id;
  if (differs && !text(o.reason, 800)) problems.push(`추천(${r.recommended})과 다른 후보를 고르려면 사유가 필요합니다`);
  if (problems.length) throw new ArchError(`아키텍처를 승인할 수 없습니다(${problems.length}건).`, 400, problems);

  const list0 = loadBaselines(root);
  const latest = list0[list0.length - 1] || null;
  if (latest && !verify(latest.baseline).ok) throw new ArchError(`직전 아키텍처 승인본 ${latest.baseline.architecture_baseline_id} 가 손상되었습니다.`, 409);
  const n = latest ? latest.n + 1 : 1;
  const id = `ABL-${String(n).padStart(3, "0")}`;
  const adrId = `ADR-${String(n).padStart(3, "0")}`;
  const at = (o.now || new Date()).toISOString();
  // 구조 승인 = 이 후보와 함께 적용한 설계 기준·기능 구조를 검토하고 승인한 것. 따로 확정하지 않았으면 여기서 승인자 이름으로 기록한다.
  const fh = functionsHash(work.functions);
  const confirmLog = [];
  if (unconfirmed.length || !work.criteria_confirmed) {
    for (const d of work.drivers) d.confirmed = true;
    work.criteria_confirmed = { at, by: who };
    confirmLog.push({ at, by: who, driver: "ALL", field: "confirmed", from: "", to: "구조 승인", after_evaluation: true, note: `구조 승인과 함께 확정${unconfirmed.length ? `(확인 전 조건 ${unconfirmed.length}건 포함)` : ""}` });
  }
  if (!work.functions_confirmed || work.functions_confirmed.hash !== fh) {
    work.functions_confirmed = { at, by: who, hash: fh };
    confirmLog.push({ at, by: who, driver: "FUNCTIONS", field: "functions_confirmed", from: "", to: `기능 ${work.functions.length}개`, after_evaluation: true, note: "구조 승인과 함께 확정" });
  }
  if (confirmLog.length) {
    work.criteria_log = (work.criteria_log || []).concat(confirmLog);
    if (work.candidates_basis) work.candidates_basis = Object.assign({}, work.candidates_basis, { criteria_at: work.criteria_confirmed.at, functions_hash: fh });
    saveWork(root, work, o.now);
  }
  const adr = {
    adr_id: adrId,
    title: text(o.title, 200) || `${cand.title || cand.id} 선정`,
    created_at: at, approver: who,
    requirements_baseline: { id: bl.baseline_id, hash: bl.baseline_hash },
    drivers: work.drivers,
    functions: work.functions,
    // 후보를 만들기 전에 확정한 설계 기준·기능 구조와 그 확정·변경 기록(결정 기록에 보인다)
    criteria_confirmed: work.criteria_confirmed || null,
    functions_confirmed: work.functions_confirmed || null,
    criteria_log: work.criteria_log || [],
    candidates: work.candidates.map((c) => ({ id: c.id, title: c.title, summary: c.summary, patterns: c.patterns, pros: c.pros, cons: c.cons, risks: c.risks, unknowns: c.unknowns })),
    single_candidate_reason: work.single_candidate_reason || null,
    evaluation: work.evaluation,
    ranking: { recommended: r.recommended, basis: r.recommendation_basis, sensitive: r.sensitive, sensitivity: r.sensitivity, candidates: r.candidates.map((c) => ({ id: c.id, status: c.status, relative: c.relative })) },
    selected: cand.id,
    selection_reason: text(o.reason, 800) || (differs ? "" : "추천 후보 선택"),
    differs_from_recommendation: Boolean(differs),
    accepted_cons: strs(o.accepted_cons, 400).length ? strs(o.accepted_cons, 400) : cand.cons,
    readiness: work.readiness, asr: work.asr, change_requests: work.change_requests,
    // 미확정 사항(상세설계·검증으로 넘긴 것, 설계 결정 제안, 답한 질문) — 상세설계가 이어받는다
    open_items: openItems(work),
    unknowns: [...work.readiness.filter((r) => r.status === "insufficient" || r.status === "unknown").map((r) => `설계 입력 ${READINESS_LABELS[r.item]}: ${r.status === "insufficient" ? "부족" : "미확인"}${r.note ? ` — ${r.note}` : ""}`), ...cand.unknowns, ...(row.metrics.resources_measurement_needed ? [`자원 예산 ${row.metrics.resources_measurement_needed}건 측정 필요`] : []), ...row.metrics.execution_unknown.map((c) => `${c} 실행 구조 미정`)],
    approval: row.status === "EVIDENCE_PENDING" ? "conditional" : "full",
    pending_evidence: row.status === "EVIDENCE_PENDING" ? { drivers: pending.map((h) => h.driver), plan, plan_default: !text(o.pending_plan, 800) } : null,
    note: "ADD·ATAM·NASA Decision Analysis·ASPICE SWE.2 의 원리를 참고한 VeriXera 절차의 기록이다. 그 방법론을 수행했다는 주장이 아니며, 등급은 AI·사람의 정성 판단이다.",
  };
  const b = {
    schema: SCHEMA, architecture_baseline_id: id, project: String(o.project || path.basename(root)).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60),
    created_at: at, approver: who,
    requirements_baseline: { id: bl.baseline_id, hash: bl.baseline_hash },
    previous_architecture_baseline: latest ? { id: latest.baseline.architecture_baseline_id, hash: latest.baseline.architecture_hash } : null,
    architecture: cand,
    functions: work.functions,
    adr,
    rule_profile_hash: o.rule_profile_hash || null,
  };
  b.architecture_hash = hashOf(b);
  const rel = `${BASELINE_DIR}/${id}_${b.project}.json`;
  fs.mkdirSync(full(root, BASELINE_DIR), { recursive: true });
  try { fs.writeFileSync(full(root, rel), JSON.stringify(b, null, 2) + "\n", { flag: "wx" }); }
  catch (e) { if (e.code === "EEXIST") throw new ArchError(`${rel} 가 이미 있습니다.`, 409); throw e; }
  fs.mkdirSync(full(root, ADR_DIR), { recursive: true });
  fs.writeFileSync(full(root, `${ADR_DIR}/${adrId}.json`), JSON.stringify(Object.assign({ architecture_baseline: { id, hash: b.architecture_hash } }, adr), null, 2) + "\n", { flag: "wx" });
  return { saved: true, architecture_baseline_id: id, adr_id: adrId, file: rel, approval: adr.approval, architecture_hash: b.architecture_hash };
}

// 상세설계 작업본의 출발점: ABL 의 구성요소를 그대로 두고, 구성요소마다 유닛 하나(사람·상세설계 에이전트가 나눈다)
function designSeed(abl, baseline) {
  const a = abl.architecture;
  return {
    requirements_baseline: { id: baseline.baseline_id, hash: baseline.baseline_hash },
    architecture_baseline: { id: abl.architecture_baseline_id, hash: abl.architecture_hash },
    components: a.components.map((c) => ({ id: c.id, name: c.name, description: c.responsibility })),
    units: a.components.map((c, i) => ({ id: `U-${String(i + 1).padStart(2, "0")}`, name: c.name, component: c.id, responsibility: c.responsibility, requirements: c.requirements, design_items: [], functions: [], acceptance: [] })),
    signals: [],
    connections: [],
  };
}

// 구조를 다시 승인할 때 지금 상세설계 작업본을 살린다: 구성요소가 그대로(같은 ID·같은 요구사항)인 곳은 유닛·함수·연결을 옮기고,
// 바뀐 구성요소만 새로 시작한다(구성요소마다 유닛 하나, 함수·연결 비움). 설계 신호·신호 사전 값은 모두 남긴다.
// 반환: { design, kept:[CMP], reset:[CMP], added:[CMP], removed:[CMP], dropped_connections:[신호] }
function designMerge(abl, baseline, current) {
  const seed = designSeed(abl, baseline);
  const cur = current && typeof current === "object" ? current : null;
  if (!cur) return { design: seed, kept: [], reset: seed.components.map((c) => c.id), added: seed.components.map((c) => c.id), removed: [], dropped_connections: [] };
  const units = list(cur.units);
  const reqsOf = (cmpId) => [...new Set(units.filter((u) => u.component === cmpId).flatMap((u) => list(u.requirements)))].sort().join(",");
  const curIds = new Set(list(cur.components).map((c) => c.id));
  const kept = [], reset = [], added = [];
  for (const c of abl.architecture.components) {
    const same = curIds.has(c.id) && units.some((u) => u.component === c.id) && reqsOf(c.id) === [...new Set(list(c.requirements))].sort().join(",");
    (same ? kept : curIds.has(c.id) ? reset : added).push(c.id);
  }
  const removed = list(cur.components).map((c) => c.id).filter((id) => !abl.architecture.components.some((c) => c.id === id));
  const keptUnits = units.filter((u) => kept.includes(u.component));
  const used = new Set(keptUnits.map((u) => u.id));
  let n = 0;
  const nextId = () => { let id; do { id = `U-${String(++n).padStart(2, "0")}`; } while (used.has(id)); used.add(id); return id; };
  const newUnits = seed.units.filter((u) => !kept.includes(u.component)).map((u) => Object.assign({}, u, { id: nextId() }));
  const keptSet = new Set(keptUnits.map((u) => u.id));
  const isExt = (by) => /^EXT/.test(String(by || ""));
  const conns = list(cur.connections).filter((c) => list(c.accesses).every((a) => isExt(a.by) || keptSet.has(a.by)) && (isExt(c.owner) || keptSet.has(c.owner) || !c.owner));
  const dropped = list(cur.connections).filter((c) => !conns.includes(c)).map((c) => c.signal);
  const order = new Map(abl.architecture.components.map((c, i) => [c.id, i]));
  const design = Object.assign({}, cur, {
    requirements_baseline: seed.requirements_baseline,
    architecture_baseline: seed.architecture_baseline,
    components: seed.components,
    units: [...keptUnits, ...newUnits].sort((a, b) => (order.get(a.component) - order.get(b.component)) || (a.id < b.id ? -1 : 1)),
    signals: list(cur.signals),
    connections: conns,
  });
  return { design, kept, reset, added, removed, dropped_connections: dropped };
}

// 상세설계(DBL 또는 작업본)가 ABL 의 구조를 지키는가. 반환: 문제 문구 목록
function designMatches(design, abl) {
  const out = [];
  const a = abl.architecture;
  const want = new Map(a.components.map((c) => [c.id, c]));
  const got = new Set(design.components.map((c) => c.id));
  for (const id of want.keys()) if (!got.has(id)) out.push(`구성요소 ${id} 가 상세설계에 없음(아키텍처 승인본 ${abl.architecture_baseline_id} 의 구성요소)`);
  for (const id of got) if (!want.has(id)) out.push(`구성요소 ${id} 는 아키텍처 승인본 ${abl.architecture_baseline_id} 에 없음 — 구조를 바꾸려면 아키텍처를 다시 승인하세요`);
  for (const u of design.units) {
    const c = want.get(u.component);
    if (!c) continue;
    for (const r of u.requirements) if (!c.requirements.includes(r)) out.push(`${u.id}: ${r} 는 아키텍처에서 ${u.component} 에 할당되지 않음`);
  }
  return out;
}

// 상세설계가 근거로 삼은 ABL 이 유효한가. design: 정규화된 설계, bl: 지금 요구사항 BL, policy: 작업 모드.
// 반환: [{ level, message }]
function linkProblems(root, design, bl, policy) {
  const out = [];
  const strict = policy === "engineering" || policy === "safety";
  let list0 = [];
  try { list0 = loadBaselines(root); } catch (e) { return [{ level: "error", message: e.message }]; }
  const latest = list0[list0.length - 1] || null;
  const ref = design && design.architecture_baseline;
  if (!ref) {
    if (latest) out.push({ level: strict ? "error" : "warning", message: `아키텍처 승인본 ${latest.baseline.architecture_baseline_id} 가 있는데 상세설계가 그것을 근거로 하지 않음 — '아키텍처'에서 상세설계로 넘기세요` });
    // engineering·safety: 승인된 구조 없이 정식 상세설계·후속 개발을 하지 않는다(ui-simplification 요청). prototype·legacy 는 주의만.
    else if (strict) out.push({ level: "error", message: "승인된 아키텍처(ABL)가 없음 — '설계 → ① 구조 결정'에서 구조를 고르고 승인한 뒤 상세설계를 승인하세요" });
    else if (policy === "prototype") out.push({ level: "warning", message: "아키텍처 결정 기록(ABL·ADR) 없이 상세설계됨 — 구조를 고른 근거가 남지 않습니다" });
    return out;
  }
  const hit = list0.find((x) => x.baseline.architecture_baseline_id === ref.id);
  if (!hit) { out.push({ level: "error", message: `상세설계의 근거 아키텍처 승인본 ${ref.id} 가 없음(지워졌거나 다른 프로젝트의 것)` }); return out; }
  const v = verify(hit.baseline);
  if (!v.ok) { out.push({ level: "error", message: `아키텍처 승인본 ${ref.id} 가 손상됨: ${v.errors.join("; ")}` }); return out; }
  if (hit.baseline.architecture_hash !== ref.hash) out.push({ level: "error", message: `상세설계가 가리키는 ${ref.id} 의 해시가 승인본과 다름` });
  if (latest && latest.baseline.architecture_baseline_id !== ref.id) out.push({ level: strict ? "error" : "warning", message: `더 최신 아키텍처 승인본 ${latest.baseline.architecture_baseline_id} 가 있음 — 상세설계를 새 구조에 맞춰 다시 승인하세요` });
  const rb = hit.baseline.requirements_baseline || {};
  if (bl && (rb.id !== bl.baseline_id || rb.hash !== bl.baseline_hash)) out.push({ level: strict ? "error" : "warning", message: `${ref.id} 는 ${rb.id || "?"} 기준 — 요구사항 고정본 ${bl.baseline_id} 에 맞춰 아키텍처 선정 근거를 다시 검토하세요` });
  for (const m of designMatches(design, hit.baseline)) out.push({ level: "error", message: m });
  if (hit.baseline.adr && hit.baseline.adr.approval === "conditional") out.push({ level: "warning", message: `${ref.id} 는 조건부 승인 — 증거가 필요한 필수 제약 ${(hit.baseline.adr.pending_evidence && hit.baseline.adr.pending_evidence.drivers || []).join(", ")}` });
  return out;
}
function latestBaseline(root) { const l = loadBaselines(root); return l.length ? l[l.length - 1].baseline : null; }

// 결정적으로 판단할 수 있는 준비성 항목(AI 를 쓰지 않음): 외부 인터페이스(신호 표), 설계 우선순위(가중치 있는 선호 조건)
function fixedReadiness(work, baseline) {
  const w = normalizeWork(work);
  const sig = list(baseline && baseline.signals).length;
  // 선호 조건의 비중은 프로젝트 기본값에서 시작하므로, 사람이 확인(설계 기준 확정)한 것만 우선순위가 정해진 것으로 센다
  const weighted = w.drivers.filter((d) => d.class === "preference" && d.weight > 0);
  const prefs = weighted.filter((d) => d.confirmed).length;
  return w.readiness.map((r) => {
    if (r.item === "interfaces" && r.by !== "human") return Object.assign({}, r, { status: sig ? "sufficient" : "insufficient", note: sig ? `요구사항 신호 표 ${sig}개` : "요구사항 신호 표가 비어 있음 — 외부 입출력을 요구사항 단계에서 정하세요", by: "fixed" });
    if (r.item === "priorities" && r.by !== "human") return Object.assign({}, r, { status: prefs ? "sufficient" : "insufficient", note: prefs ? `확정한 선호 조건 ${prefs}개` : weighted.length ? "선호 조건의 비중(프로젝트 기본값)을 아직 확인하지 않음 — 설계 기준을 확정하세요" : "가중치를 준 선호 조건이 없어 후보를 비교할 기준이 없음", by: "fixed" });
    return r;
  });
}

// 글의 비슷한 정도(글자 2개씩 묶은 조각의 Dice 계수, 0~1). 한국어 문장에도 낱말 나누기 없이 쓸 수 있다.
function similarity(a, b) {
  const grams = (s) => { const t = String(s || "").replace(/[\s\p{P}\p{S}]+/gu, ""); const o = new Set(); for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2)); return o; };
  const A = grams(a); const B = grams(b);
  let n = 0;
  for (const g of A) if (B.has(g)) n++;
  return A.size + B.size ? (2 * n) / (A.size + B.size) : 0;
}
const SAME_CR = 0.4;
// 변경 요청 합치기: 새 요청이 이미 있는 것(결정된 것 포함)과 같은 내용이면 새로 만들지 않고 근거·관련 요구사항만 더한다.
// 추천 수정안 모양: [{ requirement, text, acceptance_criteria[], open[] }] — 정할 값 표시 '[정할 값: …]'
const OPEN_RE = /\[정할 값:[^\]]*\]/g;
function normalizeSuggestions(raw) {
  return list(raw).slice(0, 10).map((x) => {
    const requirement = text(x && x.requirement, 80).replace(/@v\d+$/, "");
    const t = text(x && x.text, 2000);
    const acs = [...new Set(strs(x && x.acceptance_criteria, 500))].slice(0, 20);
    // 정할 값 이름: 문장 안의 '[정할 값: 이름]' 과 open 을 이름 하나로(같은 값이 두 번 세지지 않게)
    const nameOf = (v) => String(v).replace(/^\[정할 값:\s*/, "").replace(/\]$/, "").trim();
    const marks = ([t, ...acs].join("\n").match(OPEN_RE) || []).map(nameOf);
    const open = [...new Set([...marks, ...strs(x && x.open, 300).slice(0, 20).map(nameOf)])].filter(Boolean);
    const out = { requirement, text: t, acceptance_criteria: acs, open };
    // EARS 유형(스킬의 다섯 패턴 + Complex)과 결정적 품질 검사 결과(INCOSE R 규칙 — 서버가 붙임)
    const et = text(x && x.ears_type, 40);
    if (et) out.ears_type = et;
    if (x && x.quality && typeof x.quality === "object") {
      const f = (arr) => list(arr).slice(0, 30).map((q) => ({ rule: text(q && q.rule, 20), level: q && q.level === "violation" ? "violation" : "review", message: text(q && q.message, 300) })).filter((q) => q.rule);
      out.quality = { violations: f(x.quality.violations), review: f(x.quality.review), checked: text(x.quality.checked, 40) };
    }
    return out;
  }).filter((x) => x.requirement && x.text);
}
function mergeChangeRequests(existing, incoming) {
  const out = list(existing).map((c) => Object.assign({}, c, { related: [...list(c.related)] }));
  let added = 0;
  for (const c of list(incoming)) {
    if (!c || !c.statement) continue;
    const hit = out.find((x) => x.kind === (c.kind || "requirement") && similarity(x.statement, c.statement) >= SAME_CR);
    if (hit) {
      for (const r of list(c.related)) if (!hit.related.includes(r)) hit.related.push(r);
      if (c.reason && !String(hit.reason || "").includes(c.reason)) hit.reason = `${hit.reason ? hit.reason + " / " : ""}${c.reason}`.slice(0, 800);
      // 추천 수정안: 없던 요구사항의 것만 더한다(이미 있는 추천은 두고)
      const add = normalizeSuggestions(c.suggestions).filter((x) => !list(hit.suggestions).some((y) => y.requirement === x.requirement));
      if (add.length) hit.suggestions = [...list(hit.suggestions), ...add];
      continue;
    }
    const next = Math.max(0, ...out.map((x) => Number(String(x.id || "").replace(/\D/g, "")) || 0)) + 1;
    out.push(Object.assign({}, c, { status: "proposed", id: `CR-${String(next).padStart(2, "0")}`, created_at: c.created_at || new Date().toISOString() }));
    added++;
  }
  return { change_requests: out, added };
}

module.exports = { QUESTION_TOPICS, NON_QUESTION, openItems, RESOLUTIONS, RESOLUTION_LABELS, TOPICS, TOPIC_LABELS, STAGES, STAGE_LABELS, SAFETY_OPTIONS, normalizeFinding, classifyFindings, isBlockingNow, deferredFor, normalizeSuggestions, similarity, mergeChangeRequests, fixedReadiness, READINESS_ITEMS, READINESS_LABELS, ASR_AFFECTS, linkProblems, latestBaseline,
  WORK_FILE, BASELINE_DIR, ADR_DIR, SCHEMA, DRIVER_KINDS, DRIVER_KIND_LABELS, DRIVER_CLASSES, HARD_RESULTS, RATINGS, ArchError,
  candidateHash, functionsHash, DEP_KINDS, loadPatterns, patternsFor, normalizeWork, normalizeCandidate, metrics, rank, similarPairs, loadWork, saveWork, loadBaselines, verify, hashOf, approve, designSeed, designMerge, designMatches, leafIds,
};
