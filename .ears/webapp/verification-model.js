/* 검증 계획(VPL) 데이터 모델 — docs/requirements/verification-design.md 3.1.
 * 화면과 서버가 같이 쓴다(정규화·검증·기본 초안). 저장·승인은 tools/project/verification-plan.js.
 *
 * plan = {
 *   design_baseline: { id, hash } | null,       근거 설계 승인본(DBL)
 *   targets: [{ id, level, scope:{units,components}, title, objective, methods[], techniques[],
 *               coverage:[{metric, target}], environment, harness, entry, exit, execution_order[] }],
 *   unsupported: [{ activity, reason }],         Host 에서 확인할 수 없는 활동(통과로 치지 않음)
 *   notes
 * }
 * 대상 ID: 단위는 유닛 ID(U-…), 통합은 INT-NN, SW 는 SW — 시험 주석 @target 과 같은 이름이다.
 */
(() => {
  "use strict";

  const LEVELS = ["unit", "integration", "software"];
  const LEVEL_LABELS = { unit: "단위", integration: "통합", software: "SW" };
  const METHODS = [
    { id: "requirements_based", label: "요구사항 기반 시험" },
    { id: "interface_test", label: "인터페이스 시험" },
    { id: "fault_injection", label: "고장 주입 시험" },
    { id: "back_to_back", label: "Back-to-Back 비교" },
  ];
  const TECHNIQUES = [
    { id: "requirements_analysis", label: "요구사항 분석" },
    { id: "equivalence_classes", label: "동등 분할" },
    { id: "boundary_values", label: "경계값 분석" },
    { id: "error_guessing", label: "오류 추정" },
  ];
  // standard: 구조 커버리지(도구가 측정), verixera: VeriXera 관리 지표(분모·충족 조건을 VeriXera 가 정의)
  const METRICS = [
    { id: "statement", label: "구문", kind: "standard" },
    { id: "branch", label: "분기", kind: "standard" },
    { id: "mcdc", label: "MC/DC", kind: "standard" },
    { id: "function", label: "함수", kind: "standard" },
    { id: "call", label: "호출", kind: "standard" },
    { id: "requirement", label: "요구사항", kind: "verixera" },
    { id: "interface", label: "인터페이스", kind: "verixera" },
    { id: "scenario", label: "시나리오", kind: "verixera" },
  ];
  const UNSUPPORTED = [
    { id: "resource_usage", label: "자원 사용(CPU 부하·스택·메모리)" },
    { id: "target_timing", label: "타깃 실행 시간·주기 준수" },
  ];
  const ENVIRONMENTS = [{ id: "host-c", label: "Host C (PC 빌드·실행)" }];
  const ids = (list) => list.map((x) => x.id);
  const ID_RE = { unit: /^U-[A-Za-z0-9_-]+$/, integration: /^INT-\d{2,}$/, software: /^SW$/ };

  const TEXT_LIMIT = 2000;
  const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max || TEXT_LIMIT);
  const strList = (v, allowed) => {
    const out = [];
    for (const x of Array.isArray(v) ? v : []) { const s = str(x, 120); if (s && !out.includes(s) && (!allowed || allowed.includes(s))) out.push(s); }
    return out;
  };

  function normalizeTarget(raw) {
    const t = raw && typeof raw === "object" ? raw : {};
    const level = LEVELS.includes(t.level) ? t.level : "unit";
    const scope = t.scope && typeof t.scope === "object" ? t.scope : {};
    const cov = [];
    for (const c of Array.isArray(t.coverage) ? t.coverage : []) {
      if (!c || !ids(METRICS).includes(c.metric) || cov.some((x) => x.metric === c.metric)) continue;
      const n = Number(c.target);
      cov.push({ metric: c.metric, target: Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 10 : null });
    }
    const out = {
      id: str(t.id, 40),
      level,
      scope: { units: strList(scope.units), components: strList(scope.components) },
      title: str(t.title, 200),
      objective: str(t.objective),
      methods: strList(t.methods, ids(METHODS)),
      techniques: strList(t.techniques, ids(TECHNIQUES)),
      coverage: cov,
      environment: ids(ENVIRONMENTS).includes(t.environment) ? t.environment : "host-c",
      harness: level,
      entry: str(t.entry),
      exit: str(t.exit),
      execution_order: strList(t.execution_order),
    };
    // 판정할 출력(역추적·신호 역할의 기준, verification-boundary.js). 값이 있을 때만 둔다 — 없던 승인본의 모양·해시 유지
    const focus = str(t.focus_output, 120);
    if (focus) out.focus_output = focus;
    return out;
  }

  const LEVEL_ORDER = { unit: 0, integration: 1, software: 2 };
  function normalize(raw) {
    const p = raw && typeof raw === "object" ? raw : {};
    const db = p.design_baseline && typeof p.design_baseline === "object" && p.design_baseline.id ? { id: str(p.design_baseline.id, 40), hash: str(p.design_baseline.hash, 100) } : null;
    const targets = (Array.isArray(p.targets) ? p.targets : []).map(normalizeTarget)
      .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const unsupported = [];
    for (const u of Array.isArray(p.unsupported) ? p.unsupported : []) {
      if (!u || !ids(UNSUPPORTED).includes(u.activity) || unsupported.some((x) => x.activity === u.activity)) continue;
      unsupported.push({ activity: u.activity, reason: str(u.reason, 500) });
    }
    unsupported.sort((a, b) => (a.activity < b.activity ? -1 : 1));
    return { design_baseline: db, targets, unsupported, notes: str(p.notes) };
  }

  // 계획의 형식 문제. design 을 주면 유닛·구성요소가 설계에 있는지도 본다. 반환: [{ level: error|warning, target, message }]
  function validate(plan, design) {
    const p = normalize(plan);
    const out = [];
    const add = (level, target, message) => out.push({ level, target: target || null, message });
    const units = new Set(((design && design.units) || []).map((u) => u.id));
    const comps = new Set(((design && design.components) || []).map((c) => c.id));
    const seen = new Set();
    if (!p.design_baseline) add("warning", null, "근거 설계 승인본(DBL)이 정해지지 않았습니다");
    for (const t of p.targets) {
      const at = t.id || "(ID 없음)";
      if (!t.id) add("error", null, `${LEVEL_LABELS[t.level]} 검증 대상의 ID 가 없습니다`);
      else if (!ID_RE[t.level].test(t.id)) add("error", at, `${at}: ${LEVEL_LABELS[t.level]} 대상의 ID 형식이 아닙니다(${t.level === "unit" ? "유닛 ID U-…" : t.level === "integration" ? "INT-01" : "SW"})`);
      if (t.id && seen.has(t.id)) add("error", at, `${at}: 같은 ID 의 검증 대상이 두 개 있습니다`);
      seen.add(t.id);
      if (design) {
        if (t.level === "unit") {
          if (t.id && !units.has(t.id)) add("error", at, `${at}: 설계에 없는 유닛입니다`);
        }
        for (const u of t.scope.units) if (!units.has(u)) add("error", at, `${at}: 범위의 ${u} 는 설계에 없는 유닛입니다`);
        for (const c of t.scope.components) if (!comps.has(c)) add("error", at, `${at}: 범위의 ${c} 는 설계에 없는 구성요소입니다`);
      }
      if (t.level === "integration") {
        if (t.scope.units.length + t.scope.components.length < 2) add("error", at, `${at}: 통합 범위는 유닛이나 구성요소가 둘 이상이어야 합니다`);
        // 범위의 유닛 = 적은 유닛 + 범위 구성요소에 속한 유닛(구성요소 단위 범위도 실행 순서를 가질 수 있게)
        const inScope = new Set([...t.scope.units, ...((design && design.units) || []).filter((u) => t.scope.components.includes(u.component)).map((u) => u.id)]);
        for (const u of t.execution_order) if (!inScope.has(u)) add("error", at, `${at}: 실행 순서의 ${u} 가 범위에 없습니다`);
        if (!t.execution_order.length) add("warning", at, `${at}: 실행 순서가 정해지지 않았습니다(여러 단계 시나리오를 실행하려면 필요)`);
      }
      for (const c of t.coverage) if (c.target == null) add("warning", at, `${at}: ${metricLabel(c.metric)} 커버리지의 목표값이 없습니다`);
    }
    return out;
  }

  const metricLabel = (id) => (METRICS.find((m) => m.id === id) || { label: id }).label;
  const on = (lv) => lv === "required" || lv === "recommended";

  // 설계·설정·규칙 프로파일로 만드는 기본 계획(결정적 — 같은 입력이면 같은 결과). 통합 범위는 V1 에서 연결 그래프로 후보를 계산한다.
  // config: project.json(coverage, test_design), profileRules: 적용 규칙(coverage·unsupported_activity 를 본다), dbl: { id, hash }
  function draft(design, config, profileRules, dbl) {
    const d = design || { units: [], components: [] };
    const cfg = config || {};
    const rules = Array.isArray(profileRules) ? profileRules : [];
    const unitCov = [];
    for (const m of ["statement", "branch", "mcdc"]) {
      const g = cfg.coverage && cfg.coverage[m];
      if (g && on(g.level)) unitCov.push({ metric: m, target: typeof g.min === "number" ? g.min : 100 });
    }
    // 프로젝트 설정에 커버리지가 없으면(설정 파일 없음) 구문·분기 100% 를 기본으로 — 계획에서 사람이 바꿀 수 있다
    if (!cfg.coverage) unitCov.push({ metric: "statement", target: 100 }, { metric: "branch", target: 100 });
    for (const r of rules) if (r.fixed_check === "unit-mcdc" && !unitCov.some((c) => c.metric === "mcdc")) unitCov.push({ metric: "mcdc", target: 100 });
    const td = cfg.test_design || {};
    const techniques = ids(TECHNIQUES).filter((k) => on(td[k]));
    const unitMethods = ["requirements_based"].concat(on(td.interface_test) ? ["interface_test"] : []);
    const targets = (d.units || []).map((u) => ({
      id: u.id, level: "unit", scope: { units: [u.id], components: [] },
      title: `${u.id} ${u.name || ""}`.trim(),
      objective: u.responsibility ? `유닛 책임 확인: ${u.responsibility}` : "",
      methods: unitMethods, techniques, coverage: unitCov,
      entry: "유닛 코드가 빌드되고 승인 설계(DBL)의 인터페이스와 맞을 때",
      exit: "할당 요구사항의 시험이 모두 통과하고 커버리지 목표를 채우거나 미달 항목이 정당화될 때",
    }));
    targets.push({
      id: "SW", level: "software", scope: { units: [], components: (d.components || []).map((c) => c.id) },
      title: "SW 전체", objective: "외부 경계 입력·출력만으로 SW 요구사항 충족 확인",
      methods: ["requirements_based"], techniques: techniques.filter((k) => k !== "error_guessing"), coverage: [{ metric: "requirement", target: 100 }],
      entry: "단위·통합 검증의 종료 기준을 채웠을 때", exit: "모든 SW 요구사항의 시험이 통과할 때",
    });
    const unsupported = [];
    for (const r of rules) if (r.unsupported_activity && !unsupported.some((x) => x.activity === r.unsupported_activity)) {
      unsupported.push({ activity: r.unsupported_activity, reason: `${r.rule_id}: Host C 환경에서 확인할 수 없음 — 추가 검증 필요` });
    }
    return normalize({ design_baseline: dbl || null, targets, unsupported, notes: "" });
  }

  // 통합 대상에 쓸 기본 커버리지(규칙 프로파일에서). 화면이 통합 대상을 더할 때 쓴다.
  function integrationCoverage(profileRules) {
    const out = [];
    for (const r of Array.isArray(profileRules) ? profileRules : []) if (r.level === "INTEGRATION") for (const c of r.coverage || []) if (!out.some((x) => x.metric === c.metric)) out.push({ metric: c.metric, target: c.target });
    if (!out.some((x) => x.metric === "interface")) out.push({ metric: "interface", target: 100 });
    return out;
  }

  // 대상별 측정값(V3): 가장 최근 검증 기록의 그 수준 실행 결과에서, 대상 범위 유닛의 함수만 모아 센다.
  // measured: verification-plan.js measured() 의 결과. 반환: null | { run, unmeasured } | { run, values: {metric → {covered,total,percent,scope}}, missing:[함수] }
  // scope: "target"(대상 함수만) | "level"(그 수준 전체 — 호출 커버리지는 호출 위치별이라 대상으로 나누지 않음)
  function measuredFor(target, design, measured) {
    if (!measured || !target) return null;
    const lv = measured.by_level ? measured.by_level[target.level] : null;
    const run = measured.run;
    if (measured.by_level && !lv) return { run, unmeasured: `${LEVEL_LABELS[target.level]} 수준 시험이 이 기록에 없음` };
    if (lv && !lv.measured) return { run, unmeasured: lv.reason || "측정하지 못함" };
    const fns = lv ? lv.functions : target.level === "unit" ? measured.functions : null;
    if (!fns) return { run, unmeasured: `${LEVEL_LABELS[target.level]} 수준을 따로 실행한 기록이 없음` };
    const d = design || { units: [] };
    const sc = target.scope || {};
    const unitIds = target.level === "unit" ? [target.id] : target.level === "software" ? d.units.map((u) => u.id)
      : (sc.units || []).length ? sc.units : d.units.filter((u) => (sc.components || []).includes(u.component)).map((u) => u.id);
    const names = new Set(d.units.filter((u) => unitIds.includes(u.id)).flatMap((u) => u.functions || []));
    const hit = fns.filter((f) => names.has(f.name));
    const pct = (c, t) => (t ? Math.floor((c / t) * 1000) / 10 : 100);
    const sum = (k) => { let c = 0, t = 0, any = false; for (const f of hit) { const v = f[k]; if (v && typeof v.total === "number") { c += v.covered; t += v.total; any = true; } } return any ? { covered: c, total: t, percent: pct(c, t), scope: "target" } : null; };
    const values = {};
    if (names.size) { const fc = hit.filter((f) => f.executed > 0).length; values.function = { covered: fc, total: names.size, percent: pct(fc, names.size), scope: "target" }; }
    for (const k of ["statement", "branch", "mcdc"]) { const v = sum(k); if (v) values[k] = v; }
    const call = lv ? lv.call : measured.overall && measured.overall.call;
    if (call) values.call = Object.assign({}, call, { scope: "level" });
    return { run, values, missing: [...names].filter((n) => !hit.some((f) => f.name === n)).sort() };
  }

  const api = Object.freeze({ LEVELS, LEVEL_LABELS, METHODS, TECHNIQUES, METRICS, UNSUPPORTED, ENVIRONMENTS, TEXT_LIMIT, normalize, normalizeTarget, validate, draft, integrationCoverage, metricLabel, measuredFor });
  if (typeof window !== "undefined") window.VxVerificationModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
