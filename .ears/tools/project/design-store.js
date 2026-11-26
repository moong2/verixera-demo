/* 설계 작업본과 설계 Baseline(DBL) — docs/requirements/sw-design-boundary.md 3단계, 결정 D-010.
 *
 * 작업본   design/architecture.json                 사람이 고치는 설계(아직 승인 전). 덮어쓸 수 있다.
 * 승인본   design/baseline/DBL-NNN_<이름>.design.json  승인한 설계. 한 번 쓰면 덮어쓰지 않는다(wx). 해시로 변조를 잡는다.
 *
 * DBL 은 요구사항 Baseline(BL)에 종속된다: 근거 BL 의 ID·해시를 품고, 승인할 때 그 BL 이 이 프로젝트의 최신 BL 이어야 한다.
 * 설계만 바뀌면 BL 은 그대로 두고 새 DBL 을 만든다. 직전 DBL 의 해시를 이어받아(previous) 중간이 빠지면 거절한다.
 *
 * 편집기(tools/trace/view.js 의 WRITABLE)와 AI 에이전트(code-gen 의 writable)는 design/ 에 쓰지 못한다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const designModel = require("../../webapp/design-model.js");
const baselineApi = require("../../webapp/baseline.js");
const impact = require("../trace/impact.js");
const recStore = require("./design-recs-store.js");
const projectConfig = require("./config.js");

const WORK_FILE = "design/architecture.json";
const BASELINE_DIR = "design/baseline";
const WORK_SCHEMA = "ears-design-working/v1";
const SCHEMA = "ears-design-baseline/v1";
const ID_RE = /^DBL-(\d{3,})$/;
const HASH_PREFIX = "sha256:";
const HASH_SCOPE = "design_hash = sha256(정규화 JSON{schema, design_baseline_id, requirements_baseline{id, hash}, previous_design_baseline{id, hash}|null, design, design_documents(있으면), confirmed_recommendations(있으면), rule_profile(있으면)})";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_APPROVER = 80;
const MAX_REASON = 500;

class DesignError extends Error {
  constructor(message, status, details) { super(message); this.status = status || 400; if (details) this.details = details; }
}

const full = (root, rel) => path.join(root, ...rel.split("/"));
const sha = (text) => HASH_PREFIX + crypto.createHash("sha256").update(text, "utf8").digest("hex");

// 서술형 상세설계도 승인 시점의 내용으로 고정한다. 경로 순서와 줄바꿈은 운영체제에 관계없이 같다.
function designDocuments(root) {
  const documents = [];
  function visit(rel) {
    const dir = full(root, rel);
    if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = rel + "/" + entry.name;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        documents.push({ path: file, content: fs.readFileSync(full(root, file), "utf8").replace(/\r\n?/g, "\n") });
      }
    }
  }
  visit("docs/design");
  return documents.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// 승인본의 해시. design 은 normalize 한 모양이라 키 순서·공백·별칭(RW 등)에 영향받지 않는다.
function designHash(b) {
  return sha(baselineApi.canonicalize({
    schema: SCHEMA,
    design_baseline_id: b.design_baseline_id,
    requirements_baseline: b.requirements_baseline,
    previous_design_baseline: b.previous_design_baseline || null,
    design: b.design,
    design_documents: b.design_documents,
    confirmed_recommendations: b.confirmed_recommendations,
    // 규칙 프로파일 스냅샷과 규칙별 판정(D-012). 이 기록이 생기기 전의 승인본은 이 키가 없어 해시가 예전과 같다.
    rule_profile: b.rule_profile,
  }));
}

// ───────────────────────── 작업본 ─────────────────────────

function loadWorking(root) {
  try {
    const o = JSON.parse(fs.readFileSync(full(root, WORK_FILE), "utf8"));
    if (o && o.schema === WORK_SCHEMA && o.design && typeof o.design === "object") {
      const design = designModel.normalize(o.design);
      return { exists: true, design, revision: sha(JSON.stringify(design)), updated_at: o.updated_at || null, updated_by: o.updated_by || null };
    }
  } catch (_) { /* 없거나 깨짐 */ }
  return { exists: false, design: null, revision: null, updated_at: null, updated_by: null };
}

function checkRevision(working, expected) {
  if (expected !== undefined && working.revision !== expected) {
    throw new DesignError("다른 창에서 상세설계가 변경되었습니다. 최신 작업본을 다시 읽고 변경 내용을 검토하세요.", 409);
  }
}

// 작업본 저장. 검증 문제는 막지 않고 돌려준다(작업 중에는 틀린 상태가 있을 수 있다. 승인할 때 막는다).
function saveWorking(root, input) {
  const { design, by, now } = input || {};
  if (!design || typeof design !== "object" || Array.isArray(design)) throw new DesignError("저장할 설계(design)가 없습니다.");
  const d = designModel.normalize(design);
  const before = loadWorking(root);
  if (before.exists && JSON.stringify(before.design) === JSON.stringify(d)) return { saved: false, file: WORK_FILE, changed: false };
  checkRevision(before, input.expected_revision);
  const body = JSON.stringify({
    schema: WORK_SCHEMA,
    note: "작업 중인 설계(승인 전). 승인한 설계는 design/baseline/DBL-*.design.json 이다",
    updated_at: (now || new Date()).toISOString(),
    updated_by: by ? String(by).slice(0, MAX_APPROVER) : null,
    design: d,
  }, null, 1) + "\n";
  if (Buffer.byteLength(body) > MAX_BYTES) throw new DesignError(`설계가 너무 큽니다(${Math.round(Buffer.byteLength(body) / 1024)} KB).`, 413);
  const f = full(root, WORK_FILE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return { saved: true, file: WORK_FILE, changed: true };
}

// ───────────────────────── 승인본 ─────────────────────────

// 승인본 목록(번호 순). 깨진 파일은 건너뛰지 않고 알린다 — 승인본이 조용히 빠지면 게이트 판정이 달라진다.
function loadBaselines(root) {
  const dir = full(root, BASELINE_DIR);
  const list = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (!name.endsWith(".design.json")) continue;
    const rel = `${BASELINE_DIR}/${name}`;
    let b;
    try { b = JSON.parse(fs.readFileSync(full(root, rel), "utf8")); }
    catch (_) { throw new DesignError(`${rel} 를 읽을 수 없습니다(JSON 이 깨졌습니다).`, 409); }
    const m = ID_RE.exec((b && b.design_baseline_id) || "");
    if (!m) throw new DesignError(`${rel} 의 design_baseline_id 가 올바르지 않습니다.`, 409);
    list.push({ n: parseInt(m[1], 10), file: rel, baseline: b });
  }
  return list.sort((a, b) => a.n - b.n);
}

// 승인본이 만든 뒤 바뀌지 않았는지 확인한다.
function verify(b) {
  const errors = [];
  if (!b || b.schema !== SCHEMA) return { ok: false, errors: [`지원하지 않는 형식입니다: ${b && b.schema}`] };
  if (!ID_RE.test(b.design_baseline_id || "")) errors.push("design_baseline_id 가 올바르지 않습니다");
  if (!b.requirements_baseline || !b.requirements_baseline.id || !b.requirements_baseline.hash) errors.push("근거 요구사항 Baseline(ID·해시)이 없습니다");
  if (!b.design || typeof b.design !== "object") errors.push("설계 내용(design)이 없습니다");
  else if (JSON.stringify(designModel.normalize(b.design)) !== JSON.stringify(b.design)) errors.push("설계 내용이 정규화된 모양이 아닙니다(손으로 고친 것으로 보입니다)");
  if (!errors.length && designHash(b) !== b.design_hash) errors.push("design_hash 가 내용과 맞지 않습니다");
  return { ok: errors.length === 0, errors };
}

// 최신 요구사항 Baseline(검증한 것). 없거나 깨졌으면 이유와 함께 null.
async function latestRequirementsBaseline(root) {
  const latest = impact.loadBaselines(root).pop();
  if (!latest) return { baseline: null, reason: "요구사항 고정본(BL)이 없습니다. 요구사항을 먼저 고정하세요." };
  const v = await baselineApi.verifyBaseline(latest.baseline);
  if (!v.ok) return { baseline: null, reason: `최신 요구사항 고정본 ${latest.baseline.baseline_id} 가 손상되었습니다: ${v.errors.join("; ")}` };
  return { baseline: latest.baseline, file: latest.file };
}

function approvalConfigIssue(loaded, hasApproval) {
  if (!loaded) return hasApproval
    ? "기존 설계 승인본의 작업 모드를 확인할 수 없습니다. 프로젝트의 원래 project.json을 복원한 뒤 다시 시도하세요."
    : "작업 모드를 확인할 project.json이 없습니다. 프로젝트 설정에서 도메인·등급·작업 모드를 확인하고 저장한 뒤 상세설계를 승인하세요.";
  return loaded.invalid ? `project.json을 읽을 수 없습니다. 프로젝트 설정을 복구한 뒤 다시 시도하세요. ${loaded.errors.join("; ")}` : null;
}

// 지금 상태: 작업본, 최신 승인본(무결성, 근거 BL 이 최신인지), 최신 BL.
async function status(root) {
  const working = loadWorking(root);
  const req = await latestRequirementsBaseline(root);
  let list = [];
  let loadError = null;
  try { list = loadBaselines(root); } catch (e) { loadError = e.message; }
  const latest = list[list.length - 1] || null;
  const blRef = req.baseline ? { id: req.baseline.baseline_id, hash: req.baseline.baseline_hash } : null;
  const sameBl = (ref) => Boolean(ref && blRef && ref.id === blRef.id && ref.hash === blRef.hash);
  let latestInfo = null;
  if (latest) {
    const v = verify(latest.baseline);
    const recommendationsWarning = recStore.legacyApprovalWarning(root, latest.baseline);
    const loaded = projectConfig.load(root);
    const configIssue = approvalConfigIssue(loaded, true);
    latestInfo = {
      id: latest.baseline.design_baseline_id, file: latest.file, hash: latest.baseline.design_hash,
      created_at: latest.baseline.created_at, approver: latest.baseline.approver,
      requirements_baseline: latest.baseline.requirements_baseline,
      ok: v.ok, errors: v.errors,
      stale: !sameBl(latest.baseline.requirements_baseline),
      // 지금 프로젝트 설정(작업 모드·등급·규칙)으로 이 승인본을 정식 생성의 기준으로 쓸 수 없는 이유(승인 뒤 설정이 바뀜 등) — 화면이 '다시 승인'으로 안내
      rule_problems: configIssue ? [configIssue] : require("./design-rules.js").baselineProblems(latest.baseline, loaded.config).filter((x) => x.level === "error").map((x) => x.message),
      ...(recommendationsWarning ? { recommendations_warning: recommendationsWarning } : {}),
      // 지금 작업본이 이 승인본의 설계와 같은지(승인 뒤 고치지 않았는지). 화면이 '승인 완료' 상태를 보일 때 쓴다.
      same_design: Boolean(working.exists && JSON.stringify(working.design) === JSON.stringify(latest.baseline.design)
        && !recommendationsWarning && JSON.stringify(recStore.confirmedValues(recStore.view(root, req.baseline, working.design).items)) === JSON.stringify(latest.baseline.confirmed_recommendations || [])
        && JSON.stringify(designDocuments(root)) === JSON.stringify(latest.baseline.design_documents || [])),
      // 이 승인본에서 사람이 내린 규칙 결정(다시 승인할 때 화면이 '직전 결정'으로 미리 채운다. 승인은 사람이 다시 한다)
      decisions: ((latest.baseline.rule_profile && latest.baseline.rule_profile.rules) || [])
        .filter((r) => r.purpose === "REVIEW" && r.check_method !== "FIXED" && ["SATISFIED", "NOT_APPLICABLE", "CONDITIONAL"].includes(r.status) && r.reason)
        .map((r) => ({ rule_id: r.rule_id, decision: r.status, reason: r.reason, plan: r.plan || "" })),
    };
  }
  let problems = [];
  if (working.exists) {
    problems = designModel.validate(working.design, req.baseline ? {
      requirementIds: req.baseline.requirements.map((r) => r.requirement_id),
      signals: req.baseline.signals || [],
    } : {});
  }
  return {
    requirements_baseline: blRef, requirements_reason: req.baseline ? null : req.reason,
    working: { exists: working.exists, updated_at: working.updated_at, updated_by: working.updated_by,
      requirements_baseline: working.design ? working.design.requirements_baseline : null,
      based_on_latest: working.design ? sameBl(working.design.requirements_baseline) : false,
      errors: problems.filter((p) => p.level === "error").length, warnings: problems.filter((p) => p.level === "warning").length, problems },
    latest: latestInfo, count: list.length, load_error: loadError,
  };
}

const summaryOf = (d) => ({
  components: d.components.length,
  units: d.units.length,
  functions: d.units.reduce((k, u) => k + u.functions.length, 0),
  design_signals: d.signals.length,
  connections: d.connections.length,
});

// 작업본을 승인해 새 DBL 로 고정한다.
async function approve(root, input) {
  const { approver, change_reason, project, now, rule_decisions } = input || {};
  const who = typeof approver === "string" ? approver.trim() : "";
  if (!who) throw new DesignError("승인자 이름이 필요합니다.");
  if (who.length > MAX_APPROVER) throw new DesignError(`승인자 이름은 ${MAX_APPROVER}자 이하로 적습니다.`);
  if (change_reason != null && (typeof change_reason !== "string" || change_reason.length > MAX_REASON)) throw new DesignError(`변경 이유는 ${MAX_REASON}자 이하의 글이어야 합니다.`);
  const name = String(project || path.basename(root)).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || "project";

  const req = await latestRequirementsBaseline(root);
  const working = loadWorking(root);
  if (!working.exists) throw new DesignError("승인할 설계 작업본이 없습니다(design/architecture.json).", 409);
  checkRevision(working, input.expected_revision);
  if (!req.baseline) throw new DesignError(req.reason, 409);
  const d = working.design;
  const blRef = { id: req.baseline.baseline_id, hash: req.baseline.baseline_hash };
  const ref = d.requirements_baseline;
  if (!ref || ref.id !== blRef.id || ref.hash !== blRef.hash) {
    throw new DesignError(`설계가 최신 요구사항 고정본 ${blRef.id} 를 근거로 하지 않습니다(설계의 근거: ${ref && ref.id ? ref.id : "없음"}). 바뀐 요구사항이 설계에 주는 영향을 검토하고 근거를 ${blRef.id} 로 바꾼 뒤 승인하세요.`, 409);
  }
  const problems = designModel.validate(d, { requirementIds: req.baseline.requirements.map((r) => r.requirement_id), signals: req.baseline.signals || [] });
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length) throw new DesignError(`설계에 오류가 ${errors.length}개 있어 승인할 수 없습니다.`, 400, errors.map((p) => p.message));

  // 아키텍처 승인본(ABL, D-013) 연결: 근거로 삼았으면 구조를 지켜야 하고, ABL 이 있는데 무시하면 막는다.
  const list = loadBaselines(root);
  const cfgLoaded = projectConfig.load(root);
  const issue = approvalConfigIssue(cfgLoaded, list.length > 0);
  if (issue) throw new DesignError(issue, 409);
  const config = cfgLoaded.config;
  const policy = projectConfig.policyOf(config);
  const archLinks = require("./architecture.js").linkProblems(root, d, req.baseline, policy);
  const archErrors = archLinks.filter((p) => p.level === "error");
  if (archErrors.length) throw new DesignError(`아키텍처 승인본과 맞지 않아 승인할 수 없습니다(${archErrors.length}건).`, 400, archErrors.map((p) => p.message));
  // 꼭 개별 확인할 추천값(안전 상태·안전 책임·외부 인터페이스 계약)을 검토하지 않았으면 승인하지 않는다
  { const RS = require("./design-recs-store.js"); const v = RS.view(root, req.baseline, d);
    if (v.summary.pending_required.length) throw new DesignError(`꼭 확인할 AI 추천값 ${v.summary.pending_required.length}건을 검토해야 승인할 수 있습니다(반영·고쳐서 반영·미반영).`, 400, v.items.filter((x) => v.summary.pending_required.includes(x.key)).map((x) => `${x.target} ${x.label}: 추천 ${x.value}${x.unit ? " " + x.unit : ""} — ${x.basis}`)); }
  // 구조 설계에서 이 단계로 미룬 확인 사항을 승인 전에 다시 본다 — 막는 것(blocking)을 처리하지 않았으면 승인하지 않는다
  { const A = require("./architecture.js"); const due = A.deferredFor(A.loadWork(root), ["detail_design", "interface"]).filter((f) => f.defer.blocking);
    if (due.length) throw new DesignError(`구조 설계에서 상세설계로 미룬 확인 사항 ${due.length}건을 처리해야 승인할 수 있습니다.`, 400, due.map((f) => `${f.id} ${f.statement}${f.defer.element ? ` (영향: ${f.defer.element})` : ""}`)); }
  // 설계 규칙 프로파일(D-012): 강제성별 판정. engineering·safety 는 막는 것이 있으면 승인하지 않는다.
  const rules = require("./design-rules.js");
  const profile = rules.profileFor(config);
  const aiResults = latestRuleReview(root, d);
  const by = who;
  const decisions = (Array.isArray(rule_decisions) ? rule_decisions : []).map((x) => Object.assign({}, x, { by }));
  const verdict = rules.evaluate({ profile, design: d, baseline: req.baseline, decisions, aiResults, policy });
  const enforce = policy === "engineering" || policy === "safety";
  if (enforce && !verdict.ok) throw new DesignError(`설계 규칙에서 막는 것이 ${verdict.blocking.length}건 있어 승인할 수 없습니다.`, 400, verdict.blocking);
  const ruleProfile = {
    snapshot: profile.snapshot,
    snapshot_hash: profile.snapshot_hash,
    approval: !enforce ? "not_enforced" : verdict.conditional ? "conditional" : "full",
    blocking: verdict.blocking,
    warnings: verdict.warnings,
    rules: verdict.rules,
    note: "규칙 유형(rule_type)이 DESIGN_POLICY 인 규칙의 충족은 VeriXera·조직의 자체 정책 충족이며 표준 적합 주장이 아니다.",
  };

  const documents = designDocuments(root);
  const recommendationsView = recStore.view(root, req.baseline, d);
  const confirmed = recStore.confirmedValues(recommendationsView.items);
  const latest = list[list.length - 1] || null;
  if (latest) {
    const v = verify(latest.baseline);
    if (!v.ok) throw new DesignError(`직전 설계 승인본 ${latest.baseline.design_baseline_id} 가 손상되었습니다: ${v.errors.join("; ")}`, 409);
    const lb = latest.baseline;
    const sameRules = JSON.stringify(lb.rule_profile ? lb.rule_profile.rules.map((r) => [r.rule_id, r.status, r.reason]) : null) === JSON.stringify(ruleProfile.rules.map((r) => [r.rule_id, r.status, r.reason])) && lb.rule_profile && lb.rule_profile.snapshot_hash === ruleProfile.snapshot_hash;
    const sameDocuments = JSON.stringify(documents) === JSON.stringify(lb.design_documents || []);
    const sameRecommendations = !recStore.legacyApprovalWarning(root, lb) && JSON.stringify(confirmed) === JSON.stringify(lb.confirmed_recommendations || []);
    if (sameDocuments && sameRecommendations && JSON.stringify(lb.design) === JSON.stringify(d) && lb.requirements_baseline.id === blRef.id && lb.requirements_baseline.hash === blRef.hash && sameRules) {
      return { saved: false, unchanged: true, design_baseline_id: lb.design_baseline_id, file: latest.file };
    }
  }
  const n = latest ? latest.n + 1 : 1;
  const id = `DBL-${String(n).padStart(3, "0")}`;
  const leaves = leafIds(req.baseline);
  const alloc = designModel.allocation(d, leaves);
  const b = {
    schema: SCHEMA,
    design_baseline_id: id,
    project: name,
    created_at: (now || new Date()).toISOString(),
    approver: who,
    change_reason: change_reason ? change_reason.trim() : null,
    previous_design_baseline: latest ? { id: latest.baseline.design_baseline_id, hash: latest.baseline.design_hash } : null,
    requirements_baseline: blRef,
    hash_algorithm: "sha256",
    hash_scope: HASH_SCOPE,
    summary: summaryOf(d),
    open_items: {
      unallocated_requirements: alloc.unallocated,
      warnings: problems.filter((p) => p.level === "warning").map((p) => p.message),
    },
    design: d,
    design_documents: documents,
    confirmed_recommendations: confirmed,
    rule_profile: ruleProfile,
  };
  b.design_hash = designHash(b);
  const rel = `${BASELINE_DIR}/${id}_${name}.design.json`;
  const f = full(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try { fs.writeFileSync(f, JSON.stringify(b, null, 2) + "\n", { flag: "wx" }); }
  catch (e) { if (e.code === "EEXIST") throw new DesignError(`${rel} 파일이 이미 있습니다.`, 409); throw e; }
  // 승인 때의 추천값 목록(명세값·계산값·추천값·사용자 확정값·미정, 결정과 미반영 사유)을 승인본 옆에 남긴다
  let recommendations = null;
  try { recommendations = recStore.snapshot(root, rel, req.baseline, d, id, recommendationsView); } catch (_) { recommendations = null; }
  return { saved: true, design_baseline_id: id, file: rel, design_hash: b.design_hash, summary: b.summary, open_items: b.open_items, rule_approval: ruleProfile.approval, rule_warnings: ruleProfile.warnings, recommendations };
}

// 가장 최근 설계 검토(review-log/DREVIEW-*)가 지금 작업본을 본 것이면 그 규칙별 AI 판정. 참고용(상태는 사람이 정한다).
function latestRuleReview(root, design) {
  const dir = full(root, "review-log");
  if (!fs.existsSync(dir)) return new Map();
  const names = fs.readdirSync(dir).filter((n) => /^DREVIEW-.*\.json$/.test(n)).sort();
  if (!names.length) return new Map();
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, names[names.length - 1]), "utf8"));
    const hash = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(design), "utf8").digest("hex");
    if (rec.design_sha256 !== hash) return new Map();
    return new Map((rec.rule_results || []).map((x) => [x.rule_id, x]));
  } catch (_) { return new Map(); }
}

// 잎(하위가 없는) 요구사항 — 유닛에 할당돼야 하는 것.
function leafIds(bl) {
  const reqs = Array.isArray(bl && bl.requirements) ? bl.requirements : [];
  const parents = new Set(reqs.map((r) => r.parent).filter(Boolean));
  return reqs.map((r) => r.requirement_id).filter((id) => !parents.has(id));
}

module.exports = { latestRuleReview, WORK_FILE, BASELINE_DIR, SCHEMA, WORK_SCHEMA, DesignError, loadWorking, saveWorking, loadBaselines, verify, designHash, status, approve, leafIds };
