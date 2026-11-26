/* 설계 경계 게이트 T13 ~ T17 과 T9 확장 — docs/requirements/sw-design-boundary.md 4단계, 결정 D-009 · D-010.
 *
 * 어떤 규칙을 적용할지는 설계 파일이 있는지가 아니라 프로젝트의 작업 모드(project.json 의 design_policy)로 정한다.
 * 그래야 승인 설계 파일을 지우는 것만으로 게이트를 피하지 못한다.
 *
 *  legacy       T13~T17 을 적용하지 않는다(예전 방식). 단, 설계 승인본이 있는데 project.json 이 없으면 T13 오류
 *               (설정 파일을 지워 legacy 로 내려간 것과 구별할 수 없으므로)
 *  prototype    규칙은 같게 돌리되 T13 이 늘 오류를 낸다(초안 — 정식 검증·릴리스 불가)
 *  engineering  승인 설계(DBL)가 있어야 하고, 최신 요구사항 고정본을 근거로 해야 한다
 *  safety       engineering 과 같다(도메인 추가 조건은 차후). 시험의 검증 수준 표기가 없으면 경고가 아니라 오류
 *
 * T13 설계 Baseline 무결성 · 근거 BL 일치 · 사슬
 * T14 요구사항 할당(잎 요구사항 → 유닛), 유닛의 설계 항목이 설계 문서에 있는지
 * T15 유닛–함수 매핑(@unit 태그와 설계의 함수 목록), 함수가 다른 유닛의 설계 항목을 구현하는지
 * T16 신호 연결·인터페이스(현재 BL 의 신호 표 기준으로 설계 다시 검증)
 * T17 시험의 검증 수준·대상(@level · @target)과 설계의 일치
 * T9  시험 결과가 다른 설계 승인본으로 만들어졌는지
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const designModel = require("../../webapp/design-model.js");
const designStore = require("../project/design-store.js");
const project = require("../project/config.js");
const { checkInterfaces } = require("./c-interface.js");

const LEVELS = ["unit", "integration", "software"];

function leafIds(baseline) {
  return designStore.leafIds(baseline);
}

// root: 대상 폴더, baseline: 판정에 쓰는 요구사항 고정본, model: trace-check 의 collect 결과, results: 시험 결과(없으면 null)
// 반환: { policy, design_baseline: {id, hash}|null, errors: [], warnings: [], notRun: [] } — 항목 모양은 trace-check 와 같다({rule, message, where})
function check(root, baseline, model, results) {
  const errors = [];
  const warnings = [];
  const notRun = [];
  const err = (rule, message, where) => errors.push({ rule, message, where: where || "" });
  const warn = (rule, message, where) => warnings.push({ rule, message, where: where || "" });

  const loaded = project.load(root);
  const config = loaded && !loaded.invalid ? loaded.config : null;
  const policy = project.policyOf(config);
  const out = { policy, design_baseline: null, errors, warnings, notRun };

  let list = [];
  let loadError = null;
  try { list = designStore.loadBaselines(root); } catch (e) { loadError = e.message; }

  if (policy === "legacy") {
    if (!fs.existsSync(path.join(root, project.FILE)) && (list.length || loadError)) {
      err("T13", "설계 승인본(design/baseline)이 있는데 project.json 이 없어 작업 모드를 알 수 없음 — 설정 파일을 되돌리세요(legacy 로 내려가 설계 게이트를 피할 수 없게 막음)");
    } else if (loaded && loaded.invalid) {
      notRun.push("project.json 이 올바르지 않아 작업 모드를 legacy 로 보고 설계 경계 규칙(T13~T17)을 확인하지 않음");
    }
    // 정상적인 legacy 는 알릴 것이 없다(예전 프로젝트의 결과를 바꾸지 않는다). 모드는 report.result.design.policy 에 남는다.
    return out;
  }

  if (policy === "prototype") err("T13", "작업 모드 prototype — 초안 작업이라 정식 검증·릴리스로 인정하지 않음(engineering 으로 바꾸고 설계를 승인하세요)");

  // ── T13: 승인본 ──
  if (loadError) { err("T13", `설계 승인본을 읽을 수 없음: ${loadError}`); return skipRest(out); }
  if (!list.length) {
    if (policy !== "prototype") err("T13", "승인된 설계(design/baseline/DBL-*)가 없음 — 설계를 승인해야 정식 코드·시험의 기준이 생김");
    else notRun.push("prototype: 승인된 설계가 없어 T14~T17 을 확인하지 않음");
    return skipRest(out);
  }
  let broken = false;
  for (let i = 0; i < list.length; i++) {
    const b = list[i].baseline;
    const v = designStore.verify(b);
    if (!v.ok) { err("T13", `${b.design_baseline_id}: 설계 승인본이 손상되었거나 수정됨 — ${v.errors.join("; ")}`, list[i].file); broken = true; }
    const prev = i ? list[i - 1].baseline : null;
    const want = prev ? { id: prev.design_baseline_id, hash: prev.design_hash } : null;
    const got = b.previous_design_baseline || null;
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      err("T13", `${b.design_baseline_id}: 직전 승인본 연결이 맞지 않음(중간 승인본이 빠졌거나 바뀜) — 기대 ${want ? want.id : "없음"}, 기록 ${got ? got.id : "없음"}`, list[i].file);
      broken = true;
    }
  }
  const latest = list[list.length - 1];
  const dbl = latest.baseline;
  out.design_baseline = { id: dbl.design_baseline_id, hash: dbl.design_hash };
  if (broken) return skipRest(out);
  const ref = dbl.requirements_baseline || {};
  if (ref.id !== baseline.baseline_id || ref.hash !== baseline.baseline_hash) {
    err("T13", `${dbl.design_baseline_id} 는 ${ref.id || "?"} 를 근거로 승인됨 — 현재 요구사항 고정본 ${baseline.baseline_id} 에 맞춰 설계를 검토하고 다시 승인하세요`, latest.file);
  }
  const d = dbl.design;
  // 아키텍처 승인본(D-013): 상세설계가 근거로 삼은 ABL 이 있고 무결하며 구조를 지키는가
  for (const p of require("../project/architecture.js").linkProblems(root, dbl.design, baseline, policy)) (p.level === "error" ? err : warn)("T13", p.message, latest.file);
  // 설계 규칙 프로파일(D-012): 승인 때의 규칙 판정이 지금 프로파일·모드로 유효한가
  for (const p of require("../project/design-rules.js").baselineProblems(dbl, config, null)) (p.level === "error" ? err : warn)("T13", p.message, latest.file);

  // ── T14: 요구사항 할당 ──
  const alloc = designModel.allocation(d, leafIds(baseline));
  for (const r of alloc.unallocated) err("T14", `${r}: 어느 유닛에도 할당되지 않음 (${dbl.design_baseline_id})`);
  for (const x of alloc.unknown) err("T14", `${x.unit}: 할당한 ${x.requirement} 가 현재 고정본의 잎 요구사항이 아님`);
  const unitOfItem = new Map();
  for (const u of d.units) for (const it of u.design_items) unitOfItem.set(it, u.id);
  for (const u of d.units) {
    for (const it of u.design_items) if (!model.designs.has(it)) err("T14", `${u.id}: 설계 항목 ${it} 가 설계 문서(docs/design)에 없음`);
    if (u.requirements.length && !u.design_items.length) warn("T14", `${u.id}: 할당된 요구사항이 있지만 설계 항목(SWD)이 없음`);
  }
  for (const [id, item] of model.designs) {
    const owner = unitOfItem.get(id);
    if (!owner) { err("T14", `${id}: 설계 문서의 항목인데 승인 설계의 어느 유닛에도 속하지 않음`, `${item.file}:${item.line}`); continue; }
    const unit = d.units.find((u) => u.id === owner);
    for (const link of item.links) if (!unit.requirements.includes(link.id)) warn("T14", `${id}: ${link.id} 를 만족한다고 했지만 ${owner} 에 할당된 요구사항이 아님`, `${item.file}:${item.line}`);
  }

  // ── T15: 유닛–함수 매핑 ──
  const funcs = [...model.units, ...model.untraced, ...model.exempt].filter((f) => f.func);
  const where = new Map(funcs.map((f) => [f.func, `${f.file}:${f.line}`]));
  const m = designModel.mapFunctions(d, funcs.map((f) => ({ name: f.func, unit: f.unit || "" })));
  for (const f of m.unmapped) err("T15", `${f}(): 속한 유닛이 없음 — 함수에 @unit U-… 를 붙이거나 설계의 유닛 함수 목록에 넣으세요`, where.get(f));
  for (const c of m.conflicts) err("T15", `${c.function}(): @unit ${c.tag} 이지만 승인 설계에서는 ${c.design} 의 함수`, where.get(c.function));
  for (const c of m.unknownUnits) err("T15", `${c.function}(): @unit ${c.unit} 는 승인 설계에 없는 유닛`, where.get(c.function));
  for (const x of m.missingFunctions) err("T15", `${x.unit}: 설계의 함수 ${x.function}() 가 코드에 없음`);
  for (const u of m.unitsWithoutCode) err("T15", `${u}: 구현한 함수가 없음`);
  const unitOfFunc = new Map(m.mapped.map((x) => [x.function, x.unit]));
  for (const f of model.units) {
    if (!f.func) continue;
    const mine = unitOfFunc.get(f.func);
    for (const raw of f.implements) {
      const id = raw.replace(/@v\d+$/, "");
      const owner = unitOfItem.get(id);
      if (mine && owner && owner !== mine) err("T15", `${f.func}(): ${mine} 의 함수가 ${owner} 의 설계 항목 ${id} 를 구현함`, `${f.file}:${f.line}`);
    }
  }

  // ── T16: 신호 연결·인터페이스 ──
  for (const p of designModel.validate(d, { requirementIds: baseline.requirements.map((r) => r.requirement_id), signals: baseline.signals || [] })) {
    if (p.level === "error") err("T16", p.message);
  }
  const interfaces = checkInterfaces(model.codeFiles || [], unitOfFunc, d, require("../project/design-recs-store.js").approvedContract(dbl, baseline.signals).dictionary);
  for (const p of interfaces.errors) err("T16", p.message, p.where);
  if (interfaces.unverified.length) notRun.push("T16: C 인수·반환과의 대응 또는 자료형을 확정할 수 없는 신호 접근: " + interfaces.unverified.join(", "));

  // ── T17: 시험의 검증 수준·대상 ──
  const units = new Map(d.units.map((u) => [u.id, u]));
  const comps = new Set(d.components.map((c) => c.id));
  const signals = new Set(d.connections.map((c) => c.signal));
  let intCache = null;
  const planInts = () => {
    if (intCache) return intCache;
    intCache = new Set();
    try {
      const list = require("../project/verification-plan.js").loadBaselines(root);
      const last = list[list.length - 1];
      if (last) for (const t of last.baseline.plan.targets || []) if (t.level === "integration") intCache.add(t.id);
    } catch (_) { /* 계획을 읽지 못하면 INT 대상은 모두 없는 것으로 본다 */ }
    return intCache;
  };
  for (const [id, t] of model.tests) {
    const at = `${t.file}:${t.line}`;
    const level = t.level ? t.level.value.toLowerCase() : "";
    const target = t.target ? t.target.value : "";
    if (!level) { (policy === "safety" ? err : warn)("T17", `${id}: 검증 수준(@level unit|integration|software)이 없음`, at); continue; }
    if (!LEVELS.includes(level)) { err("T17", `${id}: 검증 수준 ${level} 은 unit·integration·software 중 하나가 아님`, at); continue; }
    if (!target) { err("T17", `${id}: 검증 대상(@target)이 없음`, at); continue; }
    if (level === "unit") {
      const u = units.get(target);
      if (!u) { err("T17", `${id}: 단위 시험의 대상 ${target} 는 승인 설계의 유닛이 아님`, at); continue; }
      for (const link of t.links) {
        const ok = link.id.startsWith("SWD-") ? unitOfItem.get(link.id) === target : u.requirements.includes(link.id);
        if (!ok) err("T17", `${id}: 단위 시험이 ${target} 에 할당되지 않은 ${link.id} 를 검증함`, at);
      }
    } else if (level === "integration") {
      const con = /^CON-(.+)$/.exec(target);
      // 검증 계획(VPL)의 통합 대상 INT-NN 도 대상이 된다 — 최신 승인본에 그 대상이 있어야 한다
      if (/^INT-\d{2,}$/.test(target)) { if (!planInts().has(target)) err("T17", `${id}: 통합 시험의 대상 ${target} 는 최신 검증 계획 승인본(VPL)의 통합 대상이 아님`, at); }
      else if (!(con && signals.has(con[1])) && !comps.has(target)) err("T17", `${id}: 통합 시험의 대상 ${target} 는 승인 설계의 연결(CON-<신호>)·구성요소(CMP-…)나 검증 계획의 통합 대상(INT-NN)이 아님`, at);
    } else if (target !== "SW") err("T17", `${id}: SW 시험의 대상은 SW 여야 함(지금 ${target})`, at);
  }
  if (model.tests.size) notRun.push("T17: 통합·SW 수준 시험의 하네스와 실행 환경 구분은 아직 확인하지 않음(차후)");

  // ── T9 확장: 결과가 같은 설계 승인본으로 만들어졌는가 ──
  if (results) {
    const rd = results.design_baseline || null;
    if (!rd) err("T9", `시험 결과에 설계 승인본 정보가 없음 — 현재 ${dbl.design_baseline_id} 로 다시 시험하세요`);
    else if (rd.hash !== dbl.design_hash) err("T9", `시험이 다른 설계 승인본으로 실행됨 — 결과: ${rd.id || "?"}, 현재: ${dbl.design_baseline_id}`);
  }
  return out;
}

function skipRest(out) {
  out.notRun.push("승인된 설계를 쓸 수 없어 T14~T17 을 확인하지 않음");
  return out;
}

// 게이트가 결과 파일에 남길 지금의 설계 승인본(없거나 읽을 수 없으면 null).
function currentDesignBaseline(root) {
  try {
    const list = designStore.loadBaselines(root);
    const b = list.length ? list[list.length - 1].baseline : null;
    return b ? { id: b.design_baseline_id, hash: b.design_hash } : null;
  } catch (_) { return null; }
}

module.exports = { check, currentDesignBaseline, LEVELS };
