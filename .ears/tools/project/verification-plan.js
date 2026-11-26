/* 검증 계획 작업본과 승인본(VPL) — docs/requirements/verification-design.md 3.1.
 *
 * 작업본   verification/plan/work.json                    사람이 고치는 계획(승인 전). 덮어쓸 수 있다.
 * 승인본   verification/plan/baseline/VPL-NNN_<이름>.json   한 번 쓰면 덮어쓰지 않는다(wx). 해시로 변조를 잡는다.
 *
 * VPL 은 설계 승인본(DBL)에 종속된다: 근거 DBL(과 그 BL, 있으면 최신 ABL)의 ID·해시와 검증 규칙 프로파일 스냅샷을 품는다.
 * 승인할 때 근거 DBL 이 최신이어야 한다. 직전 VPL 의 해시를 이어받는다(previous).
 * DBL·검증 규칙이 바뀌면 최신 VPL 은 '이전 기준(stale)'이 된다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const model = require("../../webapp/verification-model.js");
const baselineApi = require("../../webapp/baseline.js");
const designStore = require("./design-store.js");
const rules = require("./verification-rules.js");
const projectConfig = require("./config.js");

const WORK_FILE = "verification/plan/work.json";
const BASELINE_DIR = "verification/plan/baseline";
const WORK_SCHEMA = "ears-verification-plan-working/v1";
const SCHEMA = "ears-verification-plan-baseline/v1";
const ID_RE = /^VPL-(\d{3,})$/;
const HASH_SCOPE = "plan_hash = sha256(정규화 JSON{schema, plan_baseline_id, design_baseline, requirements_baseline, architecture_baseline|null, previous_plan_baseline|null, plan, rule_profile})";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_APPROVER = 80;
const MAX_REASON = 500;

class PlanError extends Error {
  constructor(message, status, details) { super(message); this.status = status || 400; if (details) this.details = details; }
}

const full = (root, rel) => path.join(root, ...rel.split("/"));
const sha = (text) => "sha256:" + require("node:crypto").createHash("sha256").update(text, "utf8").digest("hex");

function planHash(b) {
  return sha(baselineApi.canonicalize({
    schema: SCHEMA, plan_baseline_id: b.plan_baseline_id,
    design_baseline: b.design_baseline, requirements_baseline: b.requirements_baseline,
    architecture_baseline: b.architecture_baseline || null, previous_plan_baseline: b.previous_plan_baseline || null,
    plan: b.plan, rule_profile: b.rule_profile,
  }));
}

function configOf(root) {
  const l = projectConfig.load(root);
  return l && !l.invalid ? l.config : null;
}

// ───────────────────────── 작업본 ─────────────────────────

function loadWorking(root) {
  try {
    const o = JSON.parse(fs.readFileSync(full(root, WORK_FILE), "utf8"));
    if (o && o.schema === WORK_SCHEMA && o.plan && typeof o.plan === "object") {
      return { exists: true, plan: model.normalize(o.plan), updated_at: o.updated_at || null, updated_by: o.updated_by || null };
    }
  } catch (_) { /* 없거나 깨짐 */ }
  return { exists: false, plan: null, updated_at: null, updated_by: null };
}

function saveWorking(root, input) {
  const { plan, by, now } = input || {};
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new PlanError("저장할 검증 계획(plan)이 없습니다.");
  for (const target of Array.isArray(plan.targets) ? plan.targets : []) checkTextLength(target);
  const p = model.normalize(plan);
  const before = loadWorking(root);
  if (input.expected_plan !== undefined && !same(before.plan, input.expected_plan) && !same(before.plan, p)) {
    throw new PlanError("검증 계획이 다른 창에서 바뀌었습니다. 다시 읽은 뒤 기본 계획을 만드세요.", 409);
  }
  if (before.exists && JSON.stringify(before.plan) === JSON.stringify(p)) return { saved: false, file: WORK_FILE, changed: false };
  const body = JSON.stringify({
    schema: WORK_SCHEMA,
    note: "작업 중인 검증 계획(승인 전). 승인한 계획은 verification/plan/baseline/VPL-*.json 이다",
    updated_at: (now || new Date()).toISOString(),
    updated_by: by ? String(by).slice(0, MAX_APPROVER) : null,
    plan: p,
  }, null, 1) + "\n";
  if (Buffer.byteLength(body) > MAX_BYTES) throw new PlanError("검증 계획이 너무 큽니다.", 413);
  const f = full(root, WORK_FILE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return { saved: true, file: WORK_FILE, changed: true };
}

function checkTextLength(target) {
  for (const [key, label] of [["objective", "검증 목적"], ["exit", "종료 기준"]]) {
    if (target && String(target[key] || "").length > model.TEXT_LIMIT) throw new PlanError(`${label}은 ${model.TEXT_LIMIT}자까지 저장할 수 있습니다.`);
  }
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// 한 대상의 실제로 바뀐 필드만, 요청을 처리하는 시점의 작업본에 반영한다.
function editTarget(root, edit, by) {
  const plan = loadWorking(root).plan;
  if (!plan || !edit || !same(plan.design_baseline, edit.design_baseline)) throw new PlanError("검증 계획의 설계 근거가 바뀌었습니다. 저장본을 다시 읽으세요.", 409);
  const { before, after } = edit;
  const valid = (t) => t === null || (t && typeof t.id === "string" && t.id.trim());
  if (!valid(before) || !valid(after) || (!before && !after) || (before && after && before.id !== after.id)) throw new PlanError("검증 대상 변경 정보가 올바르지 않습니다.");
  checkTextLength(after);
  const prev = before && model.normalizeTarget(before);
  const next = after && model.normalizeTarget(after);
  const id = (next || prev).id;
  const index = plan.targets.findIndex((target) => target.id === id);
  const current = plan.targets[index] || null;
  if (!same(current, next)) {
    const conflict = () => new PlanError(`${id}의 같은 항목이 다른 창에서 바뀌었습니다. 입력한 내용과 저장본을 확인하세요.`, 409);
    if (prev && next && current) {
      for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (same(prev[key], next[key]) || same(current[key], next[key])) continue;
        if (!same(current[key], prev[key])) throw conflict();
        if (next[key] === undefined) delete current[key];
        else current[key] = next[key];
      }
    } else {
      if (!same(current, prev)) throw conflict();
      if (next) plan.targets.push(next);
      else plan.targets.splice(index, 1);
    }
  }
  return saveWorking(root, { plan, by });
}

// ───────────────────────── 근거 ─────────────────────────

// 최신 설계 승인본(검증한 것). 없거나 손상이면 이유와 함께 null.
function latestDesign(root) {
  let list;
  try { list = designStore.loadBaselines(root); } catch (e) { return { dbl: null, reason: e.message }; }
  const last = list[list.length - 1];
  if (!last) return { dbl: null, reason: "설계 승인본(DBL)이 없습니다. 설계를 먼저 승인하세요." };
  const v = designStore.verify(last.baseline);
  if (!v.ok) return { dbl: null, reason: `최신 설계 승인본 ${last.baseline.design_baseline_id} 가 손상되었습니다: ${v.errors.join("; ")}` };
  return { dbl: last.baseline, ref: { id: last.baseline.design_baseline_id, hash: last.baseline.design_hash } };
}

function latestArchitectureRef(root) {
  try {
    const abl = require("./architecture.js").latestBaseline(root);
    return abl ? { id: abl.architecture_baseline_id, hash: abl.architecture_hash } : null;
  } catch (_) { return null; }
}

// 화면의 경계 계산에 쓰는 근거: 최신 DBL 의 설계와 그 근거 BL 의 신호 표. 없으면 null.
function context(root) {
  const d = latestDesign(root);
  if (!d.dbl) return null;
  let signals = [];
  try {
    const ref = d.dbl.requirements_baseline || {};
    const hit = require("../trace/impact.js").loadBaselines(root).find((x) => x.baseline.baseline_id === ref.id);
    signals = hit && Array.isArray(hit.baseline.signals) ? hit.baseline.signals : [];
  } catch (_) { /* 신호 표 없음 */ }
  return { design: d.dbl.design, signals };
}

// 화면에 보이는 측정값: 가장 최근 검증 기록의 커버리지(전체·수준별). 측정값만 보낸다(목표와 섞지 않음). 없으면 null.
function measured(root) {
  let list = [];
  try { list = require("../ci/verlog.js").list(root); } catch (_) { return null; }
  const last = [...list].reverse().find((x) => x.record.coverage && x.record.coverage.statement);
  if (!last) return null;
  const c = last.record.coverage;
  const overall = {};
  for (const k of ["statement", "branch", "mcdc", "function", "call"]) if (c[k]) overall[k] = c[k];
  return {
    run: last.file, started_at: last.record.started_at, source: last.record.source, commit: last.record.commit || null,
    overall, call_unmeasured: c.call_unmeasured || null, by_level: c.by_level || null, by_level_note: c.by_level_note || null,
    // 수준별 실행이 없던 기록(단위 시험만 있음): 전체 파일의 함수별 값을 단위 수준 값으로 쓴다
    functions: c.by_level ? null : (c.files || []).flatMap((f) => (f.functions || []).map((fn) => ({ file: f.file, name: fn.name, executed: fn.executed, statement: fn.statement, branch: fn.branch, mcdc: fn.mcdc }))),
  };
}

// 기본 계획(결정적): 최신 DBL 의 유닛마다 단위 대상, SW 대상, 환경의 미지원 활동. 저장하지 않고 돌려준다.
function draft(root) {
  const d = latestDesign(root);
  if (!d.dbl) throw new PlanError(d.reason, 409);
  const config = configOf(root);
  const profile = rules.profileFor(config || { domain: "general" });
  return model.draft(d.dbl.design, config || {}, profile.rules, d.ref);
}

// 설계 승인 직후: 검증 계획 작업본이 없으면 기본 초안을 저장한다(결정적, AI 없음). 있으면 건드리지 않는다 —
// 사람이 고친 계획을 덮어쓰지 않고, 근거 설계가 바뀐 것은 상태(status)가 알린다. 검증 계획 → 시험 생성 순서의 시작점.
function ensureDraft(root, input) {
  const { by, now } = input || {};
  const w = loadWorking(root);
  if (w.exists) {
    const d = latestDesign(root);
    return { created: false, reason: "existing", stale: Boolean(d.ref && !sameRef(w.plan.design_baseline, d.ref)) };
  }
  let plan;
  try { plan = draft(root); } catch (e) { return { created: false, reason: e.message }; }
  saveWorking(root, { plan, by: by || "설계 승인 시 자동 초안", now });
  return { created: true, file: WORK_FILE, design_baseline: plan.design_baseline || null };
}

// ───────────────────────── 승인본 ─────────────────────────

function loadBaselines(root) {
  const dir = full(root, BASELINE_DIR);
  const list = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (!name.endsWith(".json")) continue;
    const rel = `${BASELINE_DIR}/${name}`;
    let b;
    try { b = JSON.parse(fs.readFileSync(full(root, rel), "utf8")); }
    catch (_) { throw new PlanError(`${rel} 를 읽을 수 없습니다(JSON 이 깨졌습니다).`, 409); }
    const m = ID_RE.exec((b && b.plan_baseline_id) || "");
    if (!m) throw new PlanError(`${rel} 의 plan_baseline_id 가 올바르지 않습니다.`, 409);
    list.push({ n: parseInt(m[1], 10), file: rel, baseline: b });
  }
  return list.sort((a, b) => a.n - b.n);
}

function verify(b) {
  const errors = [];
  if (!b || b.schema !== SCHEMA) return { ok: false, errors: [`지원하지 않는 형식입니다: ${b && b.schema}`] };
  if (!ID_RE.test(b.plan_baseline_id || "")) errors.push("plan_baseline_id 가 올바르지 않습니다");
  if (!b.design_baseline || !b.design_baseline.id || !b.design_baseline.hash) errors.push("근거 설계 승인본(ID·해시)이 없습니다");
  if (!b.plan || typeof b.plan !== "object") errors.push("계획 내용(plan)이 없습니다");
  else if (JSON.stringify(model.normalize(b.plan)) !== JSON.stringify(b.plan)) errors.push("계획 내용이 정규화된 모양이 아닙니다(손으로 고친 것으로 보입니다)");
  if (!errors.length && planHash(b) !== b.plan_hash) errors.push("plan_hash 가 내용과 맞지 않습니다");
  return { ok: errors.length === 0, errors };
}

const sameRef = (a, b) => Boolean(a && b && a.id === b.id && a.hash === b.hash);

// 지금 상태: 작업본(형식 문제·규칙 판정), 최신 VPL(무결성·이전 기준 여부), 최신 DBL.
function status(root) {
  const working = loadWorking(root);
  const d = latestDesign(root);
  const config = configOf(root);
  const policy = projectConfig.policyOf(config);
  const profile = rules.profileFor(config || { domain: "general" });
  let list = [];
  let loadError = null;
  try { list = loadBaselines(root); } catch (e) { loadError = e.message; }
  const last = list[list.length - 1] || null;
  let latest = null;
  if (last) {
    const b = last.baseline;
    const v = verify(b);
    const why = [];
    if (!d.ref) why.push("설계 승인본을 확인할 수 없음");
    else if (!sameRef(b.design_baseline, d.ref)) why.push(`근거 설계 ${b.design_baseline.id} 이후 ${d.ref.id} 가 승인됨`);
    if (b.rule_profile && b.rule_profile.snapshot_hash !== profile.snapshot_hash) why.push("승인 뒤 검증 규칙 프로파일이 바뀜");
    latest = {
      id: b.plan_baseline_id, file: last.file, hash: b.plan_hash, created_at: b.created_at, approver: b.approver,
      design_baseline: b.design_baseline, ok: v.ok, errors: v.errors, stale: why.length > 0, stale_reasons: why,
      approval: b.rule_profile ? b.rule_profile.approval : null,
      same_plan: Boolean(working.exists && JSON.stringify(working.plan) === JSON.stringify(b.plan)),
    };
  }
  let problems = [];
  let verdict = null;
  if (working.exists) {
    problems = model.validate(working.plan, d.dbl ? d.dbl.design : null);
    if (d.ref && !sameRef(working.plan.design_baseline, d.ref)) problems.push({ level: "error", target: null, message: `계획이 최신 설계 승인본 ${d.ref.id} 를 근거로 하지 않습니다(계획의 근거: ${working.plan.design_baseline ? working.plan.design_baseline.id : "없음"})` });
    verdict = rules.evaluate({ profile, plan: working.plan, design: d.dbl ? d.dbl.design : null, decisions: [], policy });
  }
  return {
    design_baseline: d.ref || null, design_reason: d.dbl ? null : d.reason, policy,
    working: { exists: working.exists, updated_at: working.updated_at, updated_by: working.updated_by,
      errors: problems.filter((p) => p.level === "error").length, warnings: problems.filter((p) => p.level === "warning").length, problems },
    rules: { settings: profile.settings, held: profile.held, conflicts: profile.conflicts, problems: profile.problems, snapshot_hash: profile.snapshot_hash,
      rules: verdict ? verdict.rules : profile.rules.map((r) => ({ rule_id: r.rule_id, name: r.name, level: r.level, category: r.category, enforcement: r.enforcement, check_method: r.check_method, text: r.text, status: "NOT_ASSESSED" })),
      blocking: verdict ? verdict.blocking : [], warnings: verdict ? verdict.warnings : [] },
    latest, count: list.length, load_error: loadError,
  };
}

// 작업본을 승인해 새 VPL 로 고정한다.
function approve(root, input) {
  const { approver, change_reason, project, now, rule_decisions } = input || {};
  const who = typeof approver === "string" ? approver.trim() : "";
  if (!who) throw new PlanError("승인자 이름이 필요합니다.");
  if (who.length > MAX_APPROVER) throw new PlanError(`승인자 이름은 ${MAX_APPROVER}자 이하로 적습니다.`);
  if (change_reason != null && (typeof change_reason !== "string" || change_reason.length > MAX_REASON)) throw new PlanError(`변경 이유는 ${MAX_REASON}자 이하의 글이어야 합니다.`);
  const name = String(project || path.basename(root)).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || "project";

  const working = loadWorking(root);
  if (!working.exists) throw new PlanError(`승인할 검증 계획 작업본이 없습니다(${WORK_FILE}).`, 409);
  if (input.expected_plan !== undefined && !same(working.plan, input.expected_plan)) {
    throw new PlanError("다른 창에서 검증 계획이 변경되었습니다. 최신 작업본을 다시 읽고 검토한 뒤 승인하세요.", 409);
  }
  const d = latestDesign(root);
  if (!d.dbl) throw new PlanError(d.reason, 409);
  const p = working.plan;
  if (!sameRef(p.design_baseline, d.ref)) {
    throw new PlanError(`계획이 최신 설계 승인본 ${d.ref.id} 를 근거로 하지 않습니다(계획의 근거: ${p.design_baseline ? p.design_baseline.id : "없음"}). 바뀐 설계를 반영하고 근거를 ${d.ref.id} 로 바꾼 뒤 승인하세요.`, 409);
  }
  const problems = model.validate(p, d.dbl.design);
  const errors = problems.filter((x) => x.level === "error");
  // 구조 설계에서 검증 계획으로 미룬 확인 사항(막는 것)을 처리했는지 본다
  { const A = require("./architecture.js"); const due = A.deferredFor(A.loadWork(root), ["verification_plan"]).filter((f) => f.defer.blocking);
    if (due.length) throw new PlanError(`구조 설계에서 검증 계획으로 미룬 확인 사항 ${due.length}건을 처리해야 승인할 수 있습니다.`, 400, due.map((f) => `${f.id} ${f.statement}${f.defer.element ? ` (영향: ${f.defer.element})` : ""}`)); }
  if (errors.length) throw new PlanError(`검증 계획에 오류가 ${errors.length}개 있어 승인할 수 없습니다.`, 400, errors.map((x) => x.message));

  const config = configOf(root);
  const policy = projectConfig.policyOf(config);
  const profile = rules.profileFor(config || { domain: "general" });
  const decisions = (Array.isArray(rule_decisions) ? rule_decisions : []).map((x) => Object.assign({}, x, { by: who }));
  const verdict = rules.evaluate({ profile, plan: p, design: d.dbl.design, decisions, policy });
  const enforce = policy === "engineering" || policy === "safety";
  if (enforce && !verdict.ok) throw new PlanError(`검증 규칙에서 막는 것이 ${verdict.blocking.length}건 있어 승인할 수 없습니다.`, 400, verdict.blocking);
  const ruleProfile = {
    snapshot: profile.snapshot, snapshot_hash: profile.snapshot_hash,
    approval: enforce ? "full" : "not_enforced",
    blocking: verdict.blocking, warnings: verdict.warnings, rules: verdict.rules,
    note: "규칙 유형이 DESIGN_POLICY 인 규칙의 충족은 VeriXera·조직의 자체 정책 충족이며 표준 적합 주장이 아니다.",
  };

  const list = loadBaselines(root);
  const last = list[list.length - 1] || null;
  if (last) {
    const v = verify(last.baseline);
    if (!v.ok) throw new PlanError(`직전 검증 계획 승인본 ${last.baseline.plan_baseline_id} 가 손상되었습니다: ${v.errors.join("; ")}`, 409);
    const lb = last.baseline;
    const sameRules = lb.rule_profile && lb.rule_profile.snapshot_hash === ruleProfile.snapshot_hash
      && JSON.stringify(lb.rule_profile.rules.map((r) => [r.rule_id, r.status, r.reason])) === JSON.stringify(ruleProfile.rules.map((r) => [r.rule_id, r.status, r.reason]));
    if (JSON.stringify(lb.plan) === JSON.stringify(p) && sameRef(lb.design_baseline, d.ref) && sameRules) {
      return { saved: false, unchanged: true, plan_baseline_id: lb.plan_baseline_id, file: last.file };
    }
  }
  const n = last ? last.n + 1 : 1;
  const id = `VPL-${String(n).padStart(3, "0")}`;
  const b = {
    schema: SCHEMA,
    plan_baseline_id: id,
    project: name,
    created_at: (now || new Date()).toISOString(),
    approver: who,
    change_reason: change_reason ? change_reason.trim() : null,
    previous_plan_baseline: last ? { id: last.baseline.plan_baseline_id, hash: last.baseline.plan_hash } : null,
    design_baseline: d.ref,
    requirements_baseline: d.dbl.requirements_baseline,
    architecture_baseline: latestArchitectureRef(root),
    hash_algorithm: "sha256",
    hash_scope: HASH_SCOPE,
    summary: Object.fromEntries(model.LEVELS.map((lv) => [lv, p.targets.filter((t) => t.level === lv).length])),
    open_items: { unsupported: p.unsupported.map((u) => u.activity), warnings: problems.filter((x) => x.level === "warning").map((x) => x.message) },
    plan: p,
    rule_profile: ruleProfile,
  };
  b.plan_hash = planHash(b);
  const rel = `${BASELINE_DIR}/${id}_${name}.json`;
  const f = full(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try { fs.writeFileSync(f, JSON.stringify(b, null, 2) + "\n", { flag: "wx" }); }
  catch (e) { if (e.code === "EEXIST") throw new PlanError(`${rel} 파일이 이미 있습니다.`, 409); throw e; }
  return { saved: true, plan_baseline_id: id, file: rel, plan_hash: b.plan_hash, summary: b.summary, open_items: b.open_items, rule_approval: ruleProfile.approval, rule_warnings: ruleProfile.warnings };
}

module.exports = { WORK_FILE, BASELINE_DIR, SCHEMA, WORK_SCHEMA, PlanError, loadWorking, saveWorking, editTarget, latestDesign, context, measured, draft, ensureDraft, loadBaselines, verify, planHash, status, approve };
