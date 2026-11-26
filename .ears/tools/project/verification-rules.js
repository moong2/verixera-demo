/* 검증 규칙 프로파일 — docs/requirements/verification-design.md 3.2.
 *
 * 규칙 파일: docs/verification-rules/<층>/*.json (schema verification-rules/v1). 층은 설계 규칙과 같다
 * (common → domain → assurance → environment → organization). 같은 rule_id 가 두 파일에 있으면 충돌(승인을 막는다).
 * 원문을 대조하지 않은 규칙은 표준 유형이 될 수 없다(설계 규칙과 같은 규칙 — design-rules.js).
 *
 * 하는 일: 규칙 파일 읽기·검증, 설정으로 프로파일 결정(스냅샷·해시), 고정 검사(계획·설계로 확인되는 규칙), 승인 판정.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const model = require("../../webapp/verification-model.js");
const { canonical } = require("./design-rules.js");

const RULES_DIR = path.join(__dirname, "..", "..", "docs", "verification-rules");
const SCHEMA = "verification-rules/v1";
const LAYERS = ["common", "domain", "assurance", "environment", "organization"];
const LEVELS = ["UNIT", "INTEGRATION", "SOFTWARE", "ALL"];
const CATEGORIES = ["PLAN", "METHOD", "TECHNIQUE", "COVERAGE", "ENVIRONMENT"];
const RULE_TYPES = ["STANDARD_REQUIREMENT", "STANDARD_RECOMMENDATION", "DESIGN_POLICY"];
const ENFORCEMENTS = ["BLOCKING", "REVIEW_REQUIRED", "ADVISORY"];
const METHODS = ["FIXED", "AI_REVIEW", "HUMAN_REVIEW"];
const DECISIONS = ["SATISFIED", "NOT_APPLICABLE", "DEVIATION"];
const FIXED_CHECKS = ["unit-targets-complete", "software-target", "objective-and-exit", "coverage-defined", "unit-mcdc", "unsupported-declared"];
const ENVIRONMENTS = [{ id: "host-c", label: "Host C", supported: true }];

const sha = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function ruleProblems(r, file) {
  const p = [];
  if (!r || typeof r !== "object") return [`${file}: 규칙이 객체가 아님`];
  const at = `${file}:${r.rule_id || "?"}`;
  const need = (k, list) => { if (!list.includes(r[k])) p.push(`${at}: ${k} 는 ${list.join("|")} 중 하나여야 함 (지금 ${r[k]})`); };
  if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(String(r.rule_id || ""))) p.push(`${at}: rule_id 형식(대문자-숫자, 예 VC-01)`);
  if (!/^\d+\.\d+$/.test(String(r.rule_version || ""))) p.push(`${at}: rule_version 형식(예 1.0)`);
  if (!r.name) p.push(`${at}: name 이 없음`);
  if (!r.text) p.push(`${at}: text(규칙 설명)가 없음`);
  need("level", LEVELS);
  need("category", CATEGORIES);
  need("rule_type", RULE_TYPES);
  need("enforcement", ENFORCEMENTS);
  need("check_method", METHODS);
  const src = r.source || {};
  if (!["NOT_CHECKED", "SOURCE_CHECKED"].includes(src.review_status)) p.push(`${at}: source.review_status 는 NOT_CHECKED|SOURCE_CHECKED`);
  if (!["PENDING", "REVIEWED"].includes(r.interpretation_status)) p.push(`${at}: interpretation_status 는 PENDING|REVIEWED`);
  if (r.rule_type !== "DESIGN_POLICY") {
    if (src.review_status !== "SOURCE_CHECKED" || !src.standard || !src.clause) p.push(`${at}: 표준 유형(${r.rule_type})은 원문을 대조한 표준·조항이 있어야 함`);
    if (r.interpretation_status !== "REVIEWED") p.push(`${at}: 표준 유형(${r.rule_type})은 의미·적용성 검토(REVIEWED)가 끝나야 함`);
  }
  if (r.check_method === "FIXED" && !FIXED_CHECKS.includes(r.fixed_check)) p.push(`${at}: FIXED 검사는 fixed_check 가 ${FIXED_CHECKS.join("|")} 중 하나여야 함`);
  if (r.fixed_check === "unsupported-declared" && !model.UNSUPPORTED.some((u) => u.id === r.unsupported_activity)) p.push(`${at}: unsupported_activity 는 ${model.UNSUPPORTED.map((u) => u.id).join("|")} 중 하나여야 함`);
  for (const c of arr(r.coverage)) if (!c || !model.METRICS.some((m) => m.id === c.metric) || !(c.target >= 0 && c.target <= 100)) p.push(`${at}: coverage 항목은 { metric(${model.METRICS.map((m) => m.id).join("|")}), target(0~100) }`);
  if (typeof r.deviation_allowed !== "boolean") p.push(`${at}: deviation_allowed(true/false)가 없음`);
  if (r.rule_type === "STANDARD_REQUIREMENT" && r.deviation_allowed) p.push(`${at}: 표준 요구는 편차 승인으로 충족시킬 수 없음`);
  return p;
}

// EARS_VERIFICATION_RULES_DIR: 시험에서 규칙 폴더를 바꿔 끼울 때.
function loadAll(dir) {
  const base = dir || process.env.EARS_VERIFICATION_RULES_DIR || RULES_DIR;
  const out = { files: [], rules: [], problems: [] };
  if (!fs.existsSync(base)) { out.problems.push(`검증 규칙 폴더가 없음: ${path.basename(base)}`); return out; }
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
      out.files.push({ file: rel, id: o.id, version: o.version });
      for (const r of arr(o.rules)) {
        out.problems.push(...ruleProblems(r, rel));
        out.rules.push(Object.assign({}, r, { file: rel, layer, file_applies: o.applies || {} }));
      }
    }
  }
  return out;
}

// 설정(project.json)을 정해진 모양으로. 검증 환경은 verification_profile.environment(1차는 host-c 만).
function settingsOf(config) {
  const c = config || {};
  const vp = c.verification_profile && typeof c.verification_profile === "object" ? c.verification_profile : {};
  const dp = c.design_profile && typeof c.design_profile === "object" ? c.design_profile : {};
  const level = c.level != null ? String(c.level) : c.asil != null ? String(c.asil) : null;
  return {
    domain: c.domain || "general",
    level,
    level_status: dp.level_status === "unassigned" ? "unassigned" : "assigned",
    environment: ENVIRONMENTS.some((e) => e.id === vp.environment) ? vp.environment : "host-c",
    policy: c.design_policy || "legacy",
  };
}

function applies(rule, s) {
  const a = Object.assign({}, rule.file_applies || {}, rule.applicability || {});
  if (a.domains && !a.domains.includes(s.domain)) return false;
  if (a.environments && !a.environments.includes(s.environment)) return false;
  return true;
}

function snapshotOf(r) {
  return {
    rule_id: r.rule_id, rule_version: r.rule_version, name: r.name, layer: r.layer, level: r.level, category: r.category,
    rule_type: r.rule_type, enforcement: r.enforcement, check_method: r.check_method, fixed_check: r.fixed_check || null,
    unsupported_activity: r.unsupported_activity || null, coverage: arr(r.coverage), deviation_allowed: r.deviation_allowed,
    source: r.source || null, interpretation_status: r.interpretation_status, text: r.text, file: r.file,
  };
}

// 반환: { settings, rules, held, conflicts, problems, snapshot, snapshot_hash }
function profileFor(config, dir) {
  const s = settingsOf(config);
  const all = loadAll(dir);
  const byId = new Map();
  const rules = [];
  const held = [];
  const conflicts = [];
  for (const r of all.rules) {
    if (!applies(r, s)) continue;
    const lv = r.applicability && r.applicability.levels;
    if (lv) {
      if (s.level_status === "unassigned") { held.push({ rule_id: r.rule_id, reason: "안전등급 미정 — 등급이 정해질 때까지 보류" }); continue; }
      if (!lv.map(String).includes(String(s.level))) continue;
    }
    if (byId.has(r.rule_id)) { conflicts.push({ rule_id: r.rule_id, files: [byId.get(r.rule_id).file, r.file], reason: `같은 규칙 ID ${r.rule_id} 가 두 파일에 있음 — 덮어쓰지 않고 충돌로 둠` }); continue; }
    byId.set(r.rule_id, r);
    rules.push(r);
  }
  const { policy, ...snapSettings } = s;
  const snapshot = { settings: snapSettings, rules: rules.map(snapshotOf), held, conflicts, files: all.files };
  return { settings: s, rules, held, conflicts, problems: all.problems, snapshot, snapshot_hash: sha(canonical(snapshot)) };
}

// 고정 검사. 반환: Map(fixed_check → { result: PASS|FAIL, details:[] }) — unsupported-declared 는 규칙마다 다르므로 키에 활동을 붙인다.
function fixedChecks(plan, design, profile) {
  const p = model.normalize(plan);
  const d = design || { units: [] };
  const out = new Map();
  const put = (k, details) => out.set(k, { result: details.length ? "FAIL" : "PASS", details });
  const unitTargets = new Set(p.targets.filter((t) => t.level === "unit").map((t) => t.id));
  put("unit-targets-complete", (d.units || []).filter((u) => !unitTargets.has(u.id)).map((u) => `${u.id}: 단위 검증 대상이 계획에 없음`));
  put("software-target", p.targets.some((t) => t.level === "software") ? [] : ["SW 수준 검증 대상이 없음"]);
  const oe = [];
  for (const t of p.targets) {
    if (!t.objective) oe.push(`${t.id || "(ID 없음)"}: 검증 목적이 없음`);
    if (!t.exit) oe.push(`${t.id || "(ID 없음)"}: 종료 기준이 없음`);
  }
  put("objective-and-exit", oe);
  put("coverage-defined", p.targets.filter((t) => !t.coverage.length || t.coverage.some((c) => c.target == null)).map((t) => `${t.id}: 커버리지 항목·목표값이 정해지지 않음`));
  put("unit-mcdc", p.targets.filter((t) => t.level === "unit" && !t.coverage.some((c) => c.metric === "mcdc")).map((t) => `${t.id}: MC/DC 가 커버리지 항목에 없음`));
  for (const r of (profile && profile.rules) || []) {
    if (r.fixed_check !== "unsupported-declared") continue;
    const ok = p.unsupported.some((u) => u.activity === r.unsupported_activity);
    out.set(`unsupported-declared:${r.unsupported_activity}`, { result: ok ? "PASS" : "FAIL", details: ok ? [] : [`${r.unsupported_activity}: 미지원 활동으로 계획에 적혀 있지 않음`] });
  }
  return out;
}

const fixedKey = (r) => (r.fixed_check === "unsupported-declared" ? `unsupported-declared:${r.unsupported_activity}` : r.fixed_check);

// 승인 판정. decisions: [{ rule_id, decision(SATISFIED|NOT_APPLICABLE|DEVIATION), reason, by }]
// 반환: { ok, blocking:[], warnings:[], rules:[스냅샷 + 판정] }
function evaluate({ profile, plan, design, decisions, policy }) {
  const fixed = fixedChecks(plan, design, profile);
  const dec = new Map(arr(decisions).filter((x) => x && x.rule_id).map((x) => [x.rule_id, x]));
  const blocking = [];
  const warnings = [];
  const rows = [];
  for (const p of profile.problems) blocking.push(`검증 규칙 파일 문제: ${p}`);
  for (const c of profile.conflicts) blocking.push(`규칙 충돌: ${c.reason}`);
  if (policy === "safety" && profile.settings.level_status === "unassigned") blocking.push("안전등급이 미정이라 safety 모드의 검증 계획을 승인할 수 없음");
  for (const r of profile.rules) {
    const fx = r.check_method === "FIXED" ? fixed.get(fixedKey(r)) : null;
    const d = dec.get(r.rule_id);
    let status = "NOT_ASSESSED";
    let reason = "";
    if (fx && fx.result === "PASS") status = "SATISFIED";
    if (fx && fx.result === "FAIL") { status = "VIOLATED"; reason = fx.details.join("; "); }
    if (d) {
      if (!DECISIONS.includes(d.decision)) blocking.push(`${r.rule_id}: 알 수 없는 결정 ${d.decision}`);
      else if (d.decision === "SATISFIED") {
        if (fx && fx.result === "FAIL") blocking.push(`${r.rule_id}: 고정 검사가 실패했는데 '충족'으로 표시할 수 없음 — ${reason}`);
        else { status = "SATISFIED"; reason = d.reason || reason; }
      } else if (!d.reason) blocking.push(`${r.rule_id}: ${d.decision === "DEVIATION" ? "편차 승인" : "적용 제외"}에는 근거가 필요함`);
      else if (d.decision === "DEVIATION" && !r.deviation_allowed) blocking.push(`${r.rule_id}: 편차 승인을 허용하지 않는 규칙`);
      else { status = d.decision; reason = d.reason; }
    }
    if (!["SATISFIED", "NOT_APPLICABLE", "DEVIATION"].includes(status)) {
      const what = status === "VIOLATED" ? `위반 — ${reason}` : "미평가";
      if (r.enforcement === "ADVISORY") warnings.push(`${r.rule_id} ${r.name}: ${what} (ADVISORY)`);
      else blocking.push(`${r.rule_id} ${r.name}: ${what} (${r.enforcement})`);
    }
    rows.push(Object.assign(snapshotOf(r), { status, reason, fixed_result: fx ? fx.result : null, decided_by: d ? d.by || null : null }));
  }
  return { ok: blocking.length === 0, blocking, warnings, rules: rows };
}

module.exports = { RULES_DIR, SCHEMA, LAYERS, LEVELS, CATEGORIES, METHODS, DECISIONS, FIXED_CHECKS, ENVIRONMENTS, loadAll, ruleProblems, settingsOf, profileFor, fixedChecks, evaluate };
