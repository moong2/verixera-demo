/* 설계 분할 규칙 프로파일 — docs/requirements/design-rule-profiles.md 0절, 결정 D-012.
 *
 * 규칙 파일: docs/design-rules/<층>/*.json (schema design-rules/v1). 층은 common → domain → assurance → environment → organization 순으로 겹친다.
 * 규칙마다 출처 유형(rule_type)과 강제성(enforcement)이 따로 있다. 원문을 대조하지 않은 규칙은 표준 유형이 될 수 없다.
 * 같은 rule_id 가 두 파일에 있으면 하나를 고르거나 덮어쓰지 않고 '충돌'로 둔다(승인을 막는다).
 *
 * 이 파일이 하는 일: 규칙 파일 읽기·검증, 설정으로 프로파일 결정(스냅샷·해시), 고정 검사(설계 모델로 확인되는 규칙),
 * 승인 판정(강제성별 차단·조건부 승인·경고).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const designModel = require("../../webapp/design-model.js");

const RULES_DIR = path.join(__dirname, "..", "..", "docs", "design-rules");
const SCHEMA = "design-rules/v1";
const LAYERS = ["common", "domain", "assurance", "environment", "organization"];
const PURPOSES = ["DECOMPOSITION", "REVIEW"];
const RULE_TYPES = ["STANDARD_REQUIREMENT", "STANDARD_RECOMMENDATION", "DESIGN_POLICY"];
const ENFORCEMENTS = ["BLOCKING", "REVIEW_REQUIRED", "ADVISORY"];
const SOURCE_STATUS = ["NOT_CHECKED", "SOURCE_CHECKED"];
const INTERP_STATUS = ["PENDING", "REVIEWED"];
const STAGES = ["ARCHITECTURE", "DETAILED", "INTERFACE"];
const METHODS = ["FIXED", "AI_REVIEW", "HUMAN_REVIEW"];
const DECISIONS = ["SATISFIED", "NOT_APPLICABLE", "DEVIATION", "CONDITIONAL"];
// 규칙이 쓰이는 설계 활동(D-013): 기능 분해 / 아키텍처(구성요소·구조) / 상세설계(유닛·인터페이스). 없으면 단계로 정한다.
const ACTIVITIES = ["FUNCTIONAL_DECOMPOSITION", "ARCHITECTURE", "DETAILED_DESIGN"];
const activityOf = (r) => (ACTIVITIES.includes(r && r.activity) ? r.activity : r && r.design_stage === "ARCHITECTURE" ? "ARCHITECTURE" : "DETAILED_DESIGN");

// 세부 프로파일: 도메인마다 고를 수 있는 것과 기본 적용 표준. supported 는 규칙 파일이 있는 것(1차: automotive).
const SUBDOMAINS = {
  automotive: [{ id: "automotive", label: "자동차", standards: ["ISO 26262:2018", "Automotive SPICE 4.0"], supported: true }],
  aerospace: [{ id: "aviation", label: "항공", standards: ["DO-178C"], supported: false }, { id: "space", label: "우주", standards: ["ECSS-E-ST-40C Rev.1"], supported: false }],
  railway: [{ id: "railway", label: "철도", standards: ["EN 50716:2023"], supported: false }],
  medical: [{ id: "medical-device", label: "의료기기", standards: ["IEC 62304:2006+A1:2015", "ISO 14971"], supported: false }],
  industrial: [{ id: "industrial-control", label: "산업제어", standards: ["IEC 61508-3:2010"], supported: false }, { id: "robotics", label: "로봇", standards: ["ISO 10218", "ISO 13849", "IEC 62061"], supported: false }],
  general: [{ id: "general-software", label: "일반 소프트웨어", standards: [], supported: true }],
};
const ENVIRONMENTS = [
  { id: "embedded-c", label: "Embedded C", supported: true },
  { id: "autosar-classic", label: "AUTOSAR Classic", supported: false },
  { id: "simulink", label: "Simulink", supported: false },
  { id: "plc", label: "PLC (IEC 61131-3)", supported: false },
  { id: "ros2", label: "ROS 2", supported: false },
];
const FIXED_CHECKS = ["allocation-complete", "interface-defined", "state-owner", "unit-testable", "responsibility-defined", "unit-has-function"];

class RuleError extends Error { constructor(message, details) { super(message); this.status = 500; if (details) this.details = details; } }

const sha = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// ───────────────────────── 규칙 파일 ─────────────────────────

// 규칙 하나의 문제(오류 메시지 목록)
function ruleProblems(r, file) {
  const p = [];
  const at = `${file}:${r && r.rule_id ? r.rule_id : "?"}`;
  const need = (k, list) => { if (!list.includes(r[k])) p.push(`${at}: ${k} 는 ${list.join("|")} 중 하나여야 함 (지금 ${r[k]})`); };
  if (!r || typeof r !== "object") return [`${file}: 규칙이 객체가 아님`];
  if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(String(r.rule_id || ""))) p.push(`${at}: rule_id 형식(대문자-숫자, 예 AUTO-05)`);
  if (!/^\d+\.\d+$/.test(String(r.rule_version || ""))) p.push(`${at}: rule_version 형식(예 1.0)`);
  if (!r.name) p.push(`${at}: name 이 없음`);
  if (!r.text) p.push(`${at}: text(규칙 설명)가 없음`);
  need("purpose", PURPOSES);
  need("rule_type", RULE_TYPES);
  need("enforcement", ENFORCEMENTS);
  need("design_stage", STAGES);
  need("check_method", METHODS);
  const src = r.source || {};
  if (!SOURCE_STATUS.includes(src.review_status)) p.push(`${at}: source.review_status 는 ${SOURCE_STATUS.join("|")}`);
  if (!INTERP_STATUS.includes(r.interpretation_status)) p.push(`${at}: interpretation_status 는 ${INTERP_STATUS.join("|")}`);
  // 원문을 대조하지 않은 규칙은 표준 요구·권고가 될 수 없다. 원문 확인만으로도 안 되고, 자체 규칙의 의미·적용성 검토(REVIEWED)까지 끝나야 한다.
  if (r.rule_type !== "DESIGN_POLICY") {
    if (src.review_status !== "SOURCE_CHECKED" || !src.standard || !src.clause) p.push(`${at}: 표준 유형(${r.rule_type})은 원문을 대조한(source.review_status=SOURCE_CHECKED) 표준·조항이 있어야 함`);
    if (r.interpretation_status !== "REVIEWED") p.push(`${at}: 표준 유형(${r.rule_type})은 자체 규칙의 의미·적용성 검토(interpretation_status=REVIEWED)가 끝나야 함`);
  }
  if (r.check_method === "FIXED" && !FIXED_CHECKS.includes(r.fixed_check)) p.push(`${at}: FIXED 검사는 fixed_check 가 ${FIXED_CHECKS.join("|")} 중 하나여야 함`);
  if (r.purpose === "DECOMPOSITION" && r.check_method === "FIXED") p.push(`${at}: 분할 규칙(DECOMPOSITION)은 설계 에이전트의 판단 근거라 고정 검사가 아님`);
  if (r.activity !== undefined && !ACTIVITIES.includes(r.activity)) p.push(`${at}: activity 는 ${ACTIVITIES.join("|")} 중 하나여야 함`);
  if (typeof r.deviation_allowed !== "boolean") p.push(`${at}: deviation_allowed(true/false)가 없음`);
  if (r.rule_type === "STANDARD_REQUIREMENT" && r.deviation_allowed) p.push(`${at}: 표준 요구는 편차 승인으로 충족시킬 수 없음(deviation_allowed=false)`);
  return p;
}

// 규칙 파일 전부를 읽는다. dir 를 주면 그 폴더(시험용). 반환: { files:[{file, layer, id, version}], rules:[{...rule, file, layer}], problems:[] }
function loadAll(dir) {
  // EARS_DESIGN_RULES_DIR: 시험에서 규칙 폴더를 바꿔 끼울 때(파일 삭제·충돌 시나리오). 보통은 앱의 docs/design-rules.
  const base = dir || process.env.EARS_DESIGN_RULES_DIR || RULES_DIR;
  const out = { files: [], rules: [], problems: [], base };
  if (!fs.existsSync(base)) { out.problems.push(`설계 규칙 폴더가 없음: ${path.basename(base)}`); return out; }
  for (const layer of LAYERS) {
    const d = path.join(base, layer);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d).filter((n) => n.endsWith(".json")).sort()) {
      const rel = `${layer}/${name}`;
      let o;
      try { o = JSON.parse(fs.readFileSync(path.join(d, name), "utf8")); }
      catch (e) { out.problems.push(`${rel}: JSON 을 읽을 수 없음 (${e.message})`); continue; }
      if (!o || o.schema !== SCHEMA) { out.problems.push(`${rel}: schema 가 ${SCHEMA} 가 아님`); continue; }
      if (o.layer !== layer) out.problems.push(`${rel}: layer(${o.layer})가 폴더(${layer})와 다름`);
      out.files.push({ file: rel, layer, id: o.id, version: o.version, applies: o.applies || {} });
      for (const r of arr(o.rules)) {
        out.problems.push(...ruleProblems(r, rel));
        out.rules.push(Object.assign({}, r, { file: rel, layer, file_applies: o.applies || {} }));
      }
    }
  }
  return out;
}

// ───────────────────────── 프로파일 ─────────────────────────

const subdomainsOf = (domain) => SUBDOMAINS[domain] || SUBDOMAINS.general;

// 설정(project.json 의 design_profile)을 정해진 모양으로. 없으면 도메인의 첫 세부 프로파일·Embedded C·등급 지정됨.
function settingsOf(config) {
  const c = config || {};
  const dp = c.design_profile && typeof c.design_profile === "object" ? c.design_profile : {};
  const subs = subdomainsOf(c.domain);
  const sub = subs.find((x) => x.id === dp.subdomain) || subs[0];
  return {
    domain: c.domain || "general",
    subdomain: sub.id,
    standards: Array.isArray(dp.standards) && dp.standards.length ? dp.standards.map(String) : sub.standards.slice(),
    environment: ENVIRONMENTS.some((e) => e.id === dp.environment) ? dp.environment : "embedded-c",
    level: c.level == null ? null : String(c.level),
    level_status: dp.level_status === "unassigned" ? "unassigned" : "assigned",
    allow_conditional: dp.allow_conditional === undefined ? c.design_policy !== "safety" : Boolean(dp.allow_conditional),
    policy: c.design_policy || "legacy",
  };
}

function applies(rule, s) {
  const a = Object.assign({}, rule.file_applies || {}, rule.applicability || {});
  if (a.domains && !a.domains.includes(s.domain)) return false;
  if (a.subdomains && !a.subdomains.includes(s.subdomain)) return false;
  if (a.environments && !a.environments.includes(s.environment)) return false;
  if (a.standards && !a.standards.some((x) => s.standards.some((y) => y.startsWith(x)))) return false;
  return true;
}
const needsLevel = (rule) => Boolean((rule.applicability && rule.applicability.levels) || (rule.file_applies && rule.file_applies.levels));
const levelOk = (rule, s) => { const lv = (rule.applicability && rule.applicability.levels) || (rule.file_applies && rule.file_applies.levels); return !lv || lv.map(String).includes(String(s.level)); };

// 설정으로 적용 규칙을 정한다. 반환: { settings, rules, held, conflicts, unsupported, problems, snapshot_hash }
function profileFor(config, dir) {
  const s = settingsOf(config);
  const all = loadAll(dir);
  const sub = subdomainsOf(s.domain).find((x) => x.id === s.subdomain);
  const env = ENVIRONMENTS.find((e) => e.id === s.environment);
  const unsupported = [];
  if (!sub || !sub.supported) unsupported.push(`세부 프로파일 ${s.subdomain} 의 규칙은 아직 없음(공통 규칙만 적용)`);
  if (!env || !env.supported) unsupported.push(`개발 환경 ${s.environment} 의 규칙은 아직 없음`);
  const byId = new Map();
  const conflicts = [];
  const rules = [];
  const held = [];
  for (const r of all.rules) {
    if (!applies(r, s)) continue;
    if (needsLevel(r)) {
      if (s.level_status === "unassigned") { held.push({ rule_id: r.rule_id, reason: "안전등급 미정 — 등급이 정해질 때까지 보류" }); continue; }
      if (!levelOk(r, s)) continue;
    }
    if (byId.has(r.rule_id)) { conflicts.push({ rule_id: r.rule_id, files: [byId.get(r.rule_id).file, r.file], reason: "같은 규칙 ID 가 두 파일에 있음 — 덮어쓰지 않고 충돌로 둠" }); continue; }
    byId.set(r.rule_id, r);
    rules.push(r);
  }
  for (const r of rules) for (const other of arr(r.conflicts_with)) if (byId.has(other)) conflicts.push({ rule_id: r.rule_id, with: other, reason: `${r.rule_id} 와 ${other} 가 함께 적용되어 충돌 — 어느 쪽을 따를지 정해야 함` });
  // 작업 모드(design_policy)는 스냅샷에 넣지 않는다 — 모드는 게이트 T13 이 따로 본다. 조건부 승인 허용 여부는 넣는다(검증 정책).
  const { policy, ...profileSettings } = s;
  const snapshot = { settings: profileSettings, rules: rules.map(snapshotOf), held, conflicts, unsupported, files: all.files.map((f) => ({ file: f.file, id: f.id, version: f.version })) };
  return { settings: s, rules, held, conflicts, unsupported, problems: all.problems, snapshot, snapshot_hash: sha(canonical(snapshot)) };
}

function snapshotOf(r) {
  return {
    rule_id: r.rule_id, rule_version: r.rule_version, name: r.name, layer: r.layer, purpose: r.purpose, activity: activityOf(r), rule_type: r.rule_type, enforcement: r.enforcement,
    design_stage: r.design_stage, check_method: r.check_method, fixed_check: r.fixed_check || null, deviation_allowed: r.deviation_allowed,
    required_for: arr(r.required_for), source: r.source || null, interpretation_status: r.interpretation_status, text: r.text, file: r.file,
  };
}

// ───────────────────────── 고정 검사 ─────────────────────────

// 설계와 근거 BL 로 고정 검사를 돌린다. 반환: Map(fixed_check → { result: PASS|FAIL|NOT_EVALUABLE, details:[] })
function fixedChecks(design, baseline) {
  const d = designModel.normalize(design);
  const bl = baseline || { requirements: [], signals: [] };
  const out = new Map();
  const put = (k, details, evaluable) => out.set(k, { result: evaluable === false ? "NOT_EVALUABLE" : details.length ? "FAIL" : "PASS", details });
  const parents = new Set(bl.requirements.map((r) => r.parent).filter(Boolean));
  const leaves = bl.requirements.map((r) => r.requirement_id).filter((id) => !parents.has(id));
  put("allocation-complete", designModel.allocation(d, leaves).unallocated.map((r) => `${r}: 어느 유닛에도 할당되지 않음`));
  const dict = designModel.dictionary(d, bl.signals || []);
  const iface = [];
  for (const c of d.connections) {
    const e = dict.get(c.signal);
    if (!e || e.category !== "interface") continue;
    const units = new Set(c.accesses.map((a) => a.by));
    if (units.size < 2) continue; // 경계를 넘지 않음
    // 참·거짓 신호(bool)에는 물리 단위가 없다 — 단위를 요구하지 않는다
    const isBool = /^(bool|_Bool|boolean)$/i.test(String(e.type || "").trim());
    const miss = [!e.type && "자료형", !e.unit && !isBool && "단위"].filter(Boolean);
    if (miss.length) iface.push(`${c.signal}: ${miss.join("·")}이(가) 정의되지 않음`);
  }
  put("interface-defined", iface);
  const st = [];
  for (const c of d.connections) {
    const e = dict.get(c.signal);
    if (!e || e.category !== "state") continue;
    if (!c.owner || designModel.isExternal(c.owner)) st.push(`${c.signal}: 상태 변수의 소유 유닛이 없음`);
    const otherWriters = c.accesses.filter((a) => a.by !== c.owner && (a.mode === "WRITE" || a.mode === "READ_WRITE"));
    if (otherWriters.length) st.push(`${c.signal}: 소유 유닛(${c.owner}) 밖에서 씀 — ${otherWriters.map((a) => a.by).join(", ")}`);
    if (!e.initial) st.push(`${c.signal}: 상태 변수의 초기값이 없음`);
  }
  put("state-owner", st);
  const tst = [];
  for (const u of d.units) {
    const io = designModel.ioList(d, bl.signals || [], { kind: "unit", id: u.id });
    if (!io.output.length && !io.inout.length) tst.push(`${u.id}: 유닛 경계의 출력이 없어 결과를 관측할 수 없음(신호 연결에 이 유닛이 WRITE 하는 신호가 필요)`);
  }
  put("unit-testable", tst, d.connections.length ? true : false);
  put("responsibility-defined", d.units.filter((u) => !u.responsibility).map((u) => `${u.id}: 책임이 비어 있음`));
  put("unit-has-function", d.units.filter((u) => !u.functions.length).map((u) => `${u.id}: 구현 함수가 정해지지 않음`));
  return out;
}

// ───────────────────────── 승인 판정 ─────────────────────────

// profile: profileFor 결과, design, baseline, decisions: [{rule_id, decision, reason, plan, limits, by}], aiResults: Map(rule_id → {result, evidence})
// 반환: { ok, conditional, blocking:[문구], warnings:[], rules:[스냅샷 + 판정] }
function evaluate({ profile, design, baseline, decisions, aiResults, policy }) {
  const fixed = fixedChecks(design, baseline);
  const dec = new Map(arr(decisions).filter((x) => x && x.rule_id).map((x) => [x.rule_id, x]));
  const blocking = [];
  const warnings = [];
  let conditional = false;
  const rows = [];
  if (profile.problems.length) blocking.push(...profile.problems.map((p) => `규칙 파일 문제: ${p}`));
  for (const c of profile.conflicts) blocking.push(`규칙 충돌: ${c.reason}`);
  if ((policy === "safety") && profile.settings.level_status === "unassigned") blocking.push("안전등급이 미정이라 safety 모드의 정식 설계 승인을 할 수 없음(등급은 사람이 안전 분석으로 정한다)");
  for (const r of profile.rules) {
    if (r.purpose !== "REVIEW") { rows.push(Object.assign(snapshotOf(r), { status: "GUIDANCE" })); continue; } // 분할 규칙은 설계 에이전트의 근거 — 판정 대상 아님
    const d = dec.get(r.rule_id);
    const fx = r.check_method === "FIXED" ? fixed.get(r.fixed_check) : null;
    const ai = aiResults && aiResults.get ? aiResults.get(r.rule_id) || null : null;
    let status = "NOT_ASSESSED";
    let reason = "";
    if (fx && fx.result === "PASS") status = "SATISFIED";
    if (fx && fx.result === "FAIL") { status = "VIOLATED"; reason = fx.details.join("; "); }
    if (d) {
      if (!DECISIONS.includes(d.decision)) { blocking.push(`${r.rule_id}: 알 수 없는 결정 ${d.decision}`); }
      else if (d.decision === "SATISFIED") {
        if (fx && fx.result === "FAIL") blocking.push(`${r.rule_id}: 고정 검사가 실패했는데 '충족'으로 표시할 수 없음 — ${reason}`);
        else { status = "SATISFIED"; reason = d.reason || reason; }
      } else if (d.decision === "NOT_APPLICABLE") {
        if (!d.reason) blocking.push(`${r.rule_id}: 적용 제외에는 근거가 필요함`);
        else { status = "NOT_APPLICABLE"; reason = d.reason; }
      } else if (d.decision === "DEVIATION") {
        if (!r.deviation_allowed) blocking.push(`${r.rule_id}: 편차 승인을 허용하지 않는 규칙${r.rule_type === "STANDARD_REQUIREMENT" ? "(표준 요구 — 편차로 충족시킬 수 없음)" : ""}`);
        else if (!d.reason) blocking.push(`${r.rule_id}: 편차 승인에는 사유가 필요함`);
        else { status = "DEVIATION"; reason = d.reason; }
      } else if (d.decision === "CONDITIONAL") {
        if (r.enforcement !== "REVIEW_REQUIRED") blocking.push(`${r.rule_id}: 조건부 승인은 REVIEW_REQUIRED 규칙에만 쓸 수 있음`);
        else if (!profile.settings.allow_conditional) blocking.push(`${r.rule_id}: 이 프로젝트 정책은 조건부 승인을 허용하지 않음`);
        else if (!d.reason || !d.plan) blocking.push(`${r.rule_id}: 조건부 승인에는 사유와 해결 계획이 필요함`);
        else { status = "CONDITIONAL"; reason = d.reason; conditional = true; }
      }
    }
    const resolved = ["SATISFIED", "NOT_APPLICABLE", "DEVIATION", "CONDITIONAL"].includes(status);
    if (!resolved) {
      const what = status === "VIOLATED" ? `위반 — ${reason}` : "미평가";
      if (r.enforcement === "BLOCKING") blocking.push(`${r.rule_id} ${r.name}: ${what} (BLOCKING)`);
      else if (r.enforcement === "REVIEW_REQUIRED") blocking.push(`${r.rule_id} ${r.name}: ${what} — 검토해 결정하거나${profile.settings.allow_conditional ? " 조건부 승인(사유·계획)으로" : ""} 처리해야 함 (REVIEW_REQUIRED)`);
      else warnings.push(`${r.rule_id} ${r.name}: ${what} (ADVISORY)`);
    }
    rows.push(Object.assign(snapshotOf(r), {
      status, reason,
      fixed_result: fx ? fx.result : null,
      ai_result: ai ? { result: ai.result, evidence: ai.evidence || "" } : null, // AI 판정은 참고. 상태는 고정 검사와 사람이 정한다
      decided_by: d ? d.by || null : null,
      // 사람이 AI 의견·근거를 확인했는지, AI 판단 후보와 다르게 판정했는지(화면의 검토 카드에서 온 결정만 이 값이 있다)
      acknowledged: d && d.acknowledged === true ? true : undefined,
      changed_from_ai: d && typeof d.changed_from_ai === "boolean" ? d.changed_from_ai : undefined,
      plan: d && d.decision === "CONDITIONAL" ? d.plan : undefined,
      limits: d && d.decision === "CONDITIONAL" ? d.limits || "" : undefined,
    }));
  }
  return { ok: blocking.length === 0, conditional, blocking, warnings, rules: rows };
}

// 승인본(DBL)의 규칙 기록이 지금 프로파일·정책으로 쓸 수 있는지. 게이트 T13 과 코드·시험 생성이 같이 쓴다.
// 반환: [{ level: "error"|"warning", message }]
function baselineProblems(dbl, config, role) {
  const out = [];
  const policy = config && config.design_policy ? config.design_policy : "legacy";
  const strict = policy === "engineering" || policy === "safety";
  const rp = dbl && dbl.rule_profile;
  const profile = profileFor(config || { domain: "general" });
  for (const p of profile.problems) out.push({ level: "error", message: `설계 규칙 파일 문제: ${p}` });
  if (policy === "safety" && profile.settings.level_status === "unassigned") out.push({ level: "error", message: "안전등급이 미정 — safety 모드의 정식 승인·릴리스를 할 수 없음(등급은 사람이 안전 분석으로 정한다)" });
  if (!rp) { out.push({ level: "warning", message: `${dbl.design_baseline_id}: 설계 규칙 판정 기록이 없는 이전 형식의 승인본 — 규칙을 판정해 다시 승인하세요` }); return out; }
  if (rp.approval === "not_enforced") out.push({ level: strict ? "error" : "warning", message: `${dbl.design_baseline_id}: 설계 규칙을 강제하지 않은 상태(legacy·prototype)에서 승인됨 — 막는 규칙 ${(rp.blocking || []).length}건. 지금 모드(${policy})에서 다시 승인하세요` });
  if (rp.snapshot_hash !== profile.snapshot_hash) out.push({ level: strict ? "error" : "warning", message: `${dbl.design_baseline_id}: 승인 뒤 설계 규칙 프로파일이 바뀜(규칙 파일·적용 표준·안전등급·개발 환경·조건부 승인 정책) — 바뀐 규칙으로 설계를 다시 검토·승인하세요` });
  if (!role && rp.approval === "conditional") {
    const open = (rp.rules || []).filter((r) => r.status === "CONDITIONAL");
    out.push({ level: "warning", message: `${dbl.design_baseline_id}: 조건부 승인 — 미결 규칙 ${open.map((r) => `${r.rule_id}(계획: ${r.plan || "-"})`).join(", ")}` });
  }
  if (role && rp.approval === "conditional") {
    for (const r of rp.rules || []) if (r.status === "CONDITIONAL" && (r.required_for || []).includes(role)) {
      out.push({ level: "error", message: `${r.rule_id} ${r.name}: 조건부 승인으로 남은 규칙이 ${role === "code" ? "코드" : "시험"} 생성에 필요한 설계 기준 — 해결해 다시 승인한 뒤 생성하세요` });
    }
  }
  return out;
}

module.exports = { baselineProblems,
  ACTIVITIES, activityOf, RULES_DIR, SCHEMA, LAYERS, PURPOSES, RULE_TYPES, ENFORCEMENTS, METHODS, DECISIONS, SUBDOMAINS, ENVIRONMENTS, FIXED_CHECKS, RuleError,
  loadAll, ruleProblems, settingsOf, profileFor, fixedChecks, evaluate, canonical,
};
