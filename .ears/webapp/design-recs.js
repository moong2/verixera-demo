/* 설계 추천값(Recommendation-Driven Design) — docs/requirements/design-recommendations.md (사용자 2026-11-26).
 *
 * 정보가 부족하면 묻지 않고 채운다. 값마다 어디서 왔는지 나눈다:
 *   spec         명세값 — 승인된 요구사항·수용 기준·데이터 사전(고정본)에 있는 값. 보호(바꿀 수 없음)
 *   computed     계산값 — 자료형·변환식으로 프로그램이 계산한 값(예: int16 의 표현 범위). 물리 범위와 다르다
 *   recommended  추천값 — AI 가 근거와 함께 제안한 미승인 값(설계 초안에 쓰지만 확정이 아님)
 *   confirmed    사용자 확정값 — 사람이 검토해 반영(그대로 또는 고쳐서)
 *   undetermined 미정 — 타당한 추천 근거조차 없음
 * 사람은 추천값마다 반영 / 고쳐서 반영 / 미반영만 정한다. 결정에는 AI 를 부르지 않는다(프로그램 검사만).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./design-model.js"));
  else root.EarsDesignRecs = factory(root.EarsDesignModel);
})(typeof self !== "undefined" ? self : this, function (DM) {
  "use strict";

  const SCHEMA = "design-recommendations/v1";
  const STATUS = { spec: "명세값", computed: "계산값", recommended: "추천값", confirmed: "사용자 확정값", undetermined: "미정" };
  // 신호마다 볼 속성(이름은 데이터 사전·설계 신호와 같게). numeric 이 아닌 신호(bool·enum)는 범위·변환 속성을 보지 않는다
  const ATTRS = [
    ["type", "자료형", false], ["min", "Physical Min", true], ["max", "Physical Max", true], ["raw_min", "Raw Min", true], ["raw_max", "Raw Max", true],
    ["scaling", "Scaling", true], ["offset", "Offset", true], ["resolution", "Resolution", true], ["initial", "초기값", false], ["update_period", "갱신 주기", false],
  ];
  const ATTR_LABEL = Object.fromEntries(ATTRS.map(([k, l]) => [k, l]));
  const SIGNAL_KINDS = ["external_input", "external_output", "internal_state", "data", "parameter", undefined, ""];
  const DECISIONS = ["pending", "accepted", "edited", "rejected"];
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n || 300);
  const list = (v) => (Array.isArray(v) ? v : []);
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const isBool = (s) => /^(bool|boolean)$/i.test(String((s && (s.type || s.logical_type)) || ""));
  const isEnum = (s) => /^enum$/i.test(String((s && s.logical_type) || "")) || list(s && s.allowed_values).length > 0;
  const keyOf = (target, attr) => `${target}|${attr}`;

  // 데이터 사전 신호의 속성값(이름이 조금 다른 것도 본다: scale ↔ scaling, logical_type → type 은 보지 않음)
  function specOf(sig, attr) {
    if (!sig) return "";
    if (attr === "scaling") return has(sig.scaling) ? str(sig.scaling) : has(sig.scale) ? str(sig.scale) : "";
    return has(sig[attr]) ? str(sig[attr]) : "";
  }

  // AI 추천 한 건의 모양
  function normalizeAi(raw) {
    return list(raw).slice(0, 200).map((x) => {
      if (!x || typeof x !== "object") return null;
      const target = str(x.target, 120); const attr = str(x.attr, 60);
      if (!target || !attr || !has(x.value)) return null;
      return {
        target, attr, value: str(x.value, 200), unit: str(x.unit, 40), basis: str(x.basis, 600),
        requirements: list(x.requirements).map((r) => str(r, 60).replace(/@v\d+$/, "")).filter(Boolean).slice(0, 20),
        assumption: str(x.assumption, 400), alternatives: list(x.alternatives).map((a) => str(a, 200)).filter(Boolean).slice(0, 5),
        affects: list(x.affects).map((a) => str(a, 80)).filter(Boolean).slice(0, 10),
        // '꼭 확인'은 안전 상태(초기값)와 외부 인터페이스 계약(자료형·변환·원시 범위)만 — 그 밖은 일괄 반영할 수 있는 일반 추천
        required: x.required === true && (attr === "initial" || /^signal:/.test(target) && ["type", "scaling", "offset", "raw_min", "raw_max"].includes(attr)),
      };
    }).filter(Boolean);
  }

  // 추천 목록을 만든다(결정적). signals: 고정본 데이터 사전, ai: AI 추천, designSignals: 상세설계 초안의 신호, decisions: {key: 결정}
  function build({ signals, ai, designSignals, decisions }) {
    const items = [];
    const aiList = normalizeAi(ai);
    const dec = decisions && typeof decisions === "object" ? decisions : {};
    const used = new Set();
    const designBy = new Map(list(designSignals).filter((s) => s && s.name).map((s) => [s.name, s]));
    const add = (it) => {
      const d = dec[it.key];
      // 명세값·계산값은 사람이 바꾸지 않는다(보호). 추천값의 결정은 추천이 바뀌지 않았거나 사람이 고친 경우만 이어받는다
      if (it.status === "recommended" && d && DECISIONS.includes(d.state) && d.state !== "pending" && (d.state === "edited" || d.state === "rejected" || d.for_value === it.value)) {
        it.decision = d;
        if (d.state === "accepted" || d.state === "edited") { it.status = "confirmed"; it.value_final = d.state === "edited" ? d.value : it.value; }
      } else it.decision = { state: it.status === "recommended" ? "pending" : "n/a" };
      items.push(it);
    };
    for (const s of list(signals)) {
      if (!s || !s.name || !SIGNAL_KINDS.includes(s.kind)) continue;
      const target = `signal:${s.name}`;
      const type = specOf(s, "type");
      // 파라미터(보정값·임계값)는 값 자체가 명세라 범위·변환을 묻지 않는다
      const numeric = !isBool(s) && !isEnum(s) && s.kind !== "parameter";
      const tr = DM && DM.typeRange ? DM.typeRange(type) : null;
      const out = /output/.test(String(s.kind || s.direction || "")) || s.direction === "output";
      for (const [attr, label, numOnly] of ATTRS) {
        if (numOnly && !numeric) continue;
        const key = keyOf(target, attr);
        const base = { key, target, signal: s.name, attr, label, unit: attr === "min" || attr === "max" ? str(s.unit, 40) : "", requirements: list((s.sources && s.sources[attr]) || s.requirements).slice(0, 20) };
        // 자료형·초기값은 설계가 정하는 속성이다(데이터 사전 정책) — 요구사항이 근거로 적혀 있을 때만 명세값으로 보호하고,
        // 근거 없이 표에 적힌 값은 AI 추천의 대안(또는 그대로 추천)으로 보인다
        const tableVal = specOf(s, attr);
        const designAttr = attr === "type" || attr === "initial";
        const sourced = list(s.sources && s.sources[attr]).length > 0;
        const spec = tableVal && (!designAttr || sourced) ? tableVal : "";
        if (spec) { add(Object.assign(base, { status: "spec", value: spec, basis: "승인된 데이터 사전(요구사항 고정본)" })); continue; }
        // 참·거짓 신호의 자료형은 하나뿐 — 고를 것이 없다
        if (attr === "type" && isBool(s)) { add(Object.assign(base, { status: "computed", value: "bool", basis: "참·거짓 신호(논리 자료형 boolean)" })); continue; }
        // 계산값: 자료형의 표현 범위(물리 범위가 아님 — 실제 센서의 유효 범위는 자료형만으로 알 수 없다)
        if ((attr === "raw_min" || attr === "raw_max") && tr) { add(Object.assign(base, { status: "computed", value: String(attr === "raw_min" ? tr.min : tr.max), basis: `자료형 ${type} 의 표현 범위(실제 센서의 유효 범위가 아님)` })); continue; }
        const r = aiList.find((x) => x.target === target && x.attr === attr);
        if (r) { used.add(r); add(Object.assign(base, { status: "recommended", value: r.value, unit: r.unit || base.unit, basis: r.basis, requirements: r.requirements.length ? r.requirements : base.requirements, assumption: r.assumption, alternatives: [...(tableVal && tableVal !== r.value ? [`데이터 사전에 적힌 값 ${tableVal}(요구사항 근거 없음)`] : []), ...r.alternatives], affects: r.affects, required: r.required || (out && attr === "initial") })); continue; }
        if (tableVal) { add(Object.assign(base, { status: "recommended", value: tableVal, basis: "데이터 사전에 적힌 값 — 요구사항 근거가 없어 설계에서 확정", required: out && attr === "initial" })); continue; }
        const ds = designBy.get(s.name);
        if (ds && has(ds[attr])) { add(Object.assign(base, { status: "recommended", value: str(ds[attr]), basis: "상세설계 초안에서 AI 가 쓴 값(근거 미기재 — 검토 필요)", required: out && attr === "initial" })); continue; }
        // 필요한 것만 미정으로 남긴다: 숫자 신호의 물리 범위, 출력의 초기값
        if ((numeric && (attr === "min" || attr === "max")) || (out && attr === "initial")) add(Object.assign(base, { status: "undetermined", value: "", basis: "근거가 되는 값이 없음 — 상세설계·센서 사양에서 정함", required: out && attr === "initial" }));
      }
      // 요구사항에 있는 판단 기준값(보호 — 참고로 보인다)
      for (const t of list(s.thresholds)) if (t && has(t.value)) items.push({ key: keyOf(target, `threshold:${t.value}`), target, signal: s.name, attr: "threshold", label: "요구사항의 판단 기준값", status: "spec", value: `${str(t.value)}${t.unit ? " " + str(t.unit) : s.unit ? " " + str(s.unit) : ""}`, basis: str(t.condition, 200) || "요구사항", requirements: t.requirement ? [t.requirement] : [], decision: { state: "n/a" } });
    }
    // 신호가 아닌 대상(유닛·함수·인터페이스·실행 주기 등)의 추천
    // 신호 속성에서 이미 만든 항목(명세값·계산값 포함, 예: 참·거짓 신호의 자료형 bool)과 같은 키는 다시 넣지 않는다 —
    // 같은 키가 두 줄이면 결정이 앞의 계산값에 걸려 "바꿀 수 없습니다"로 거절되고, '꼭 확인'이면 설계 승인을 영영 막는다(SBR 예시 QA 2026-11-27).
    const builtKeys = new Set(items.map((x) => x.key));
    for (const r of aiList) {
      if (used.has(r) || builtKeys.has(keyOf(r.target, r.attr)) || /^signal:/.test(r.target) && list(signals).some((s) => s && `signal:${s.name}` === r.target && specOf(s, r.attr))) continue;
      add({ key: keyOf(r.target, r.attr), target: r.target, attr: r.attr, label: ATTR_LABEL[r.attr] || r.attr, status: "recommended", value: r.value, unit: r.unit, basis: r.basis, requirements: r.requirements, assumption: r.assumption, alternatives: r.alternatives, affects: r.affects, required: r.required });
    }
    return items;
  }

  function summary(items) {
    const xs = list(items);
    const rec = xs.filter((x) => x.decision && x.decision.state !== "n/a");
    return {
      total: xs.length, spec: xs.filter((x) => x.status === "spec").length, computed: xs.filter((x) => x.status === "computed").length,
      recommended: xs.filter((x) => x.status === "recommended").length, confirmed: xs.filter((x) => x.status === "confirmed").length, undetermined: xs.filter((x) => x.status === "undetermined").length,
      reviewed: rec.filter((x) => x.decision.state !== "pending").length, to_review: rec.length,
      pending_required: rec.filter((x) => x.required && x.decision.state === "pending").map((x) => x.key),
    };
  }

  // 사람의 결정 한 건(반영·고쳐서 반영·미반영). 명세값·계산값은 바꿀 수 없다
  function decide(items, decisions, key, d) {
    const it = list(items).find((x) => x.key === key);
    if (!it) throw new Error(`추천 항목이 없습니다: ${key}`);
    if (it.status === "spec" || it.status === "computed") throw new Error(`${it.label} 는 ${STATUS[it.status]}이라 바꿀 수 없습니다`);
    const state = d && d.state;
    if (!["accepted", "edited", "rejected", "pending"].includes(state)) throw new Error("결정은 반영·고쳐서 반영·미반영 중 하나입니다");
    if (state === "edited" && !has(d.value)) throw new Error("고친 값을 적어 주세요");
    const next = Object.assign({}, decisions || {});
    if (state === "pending") delete next[key];
    else next[key] = { state, value: state === "edited" ? str(d.value, 200) : undefined, reason: str(d.reason, 400), by: str(d.by, 80), at: str(d.at, 40), for_value: it.value };
    return next;
  }

  // 사람이 확정한 추천값을 상세설계 작업본의 신호 표에 써 넣는다(예전에는 추천 기록에만 남고 신호 표에는 없었다 — 사용자 QA 2026-11-26).
  // 신호 속성: 자료형·초기값·(요구사항이 비워 둔) Min/Max·원시 범위·Scaling·Offset·Resolution. 인터페이스의 전달 방식은 그 신호의 transfer.
  // 명세값은 건드리지 않는다(명세값은 확정 대상이 아니다). 유닛·함수의 결정(알고리즘·주기·초기 상태)은 설계 승인본의 추천 기록으로 코드 생성에 넘긴다.
  const WRITABLE = ["type", "initial", "min", "max", "raw_min", "raw_max", "scaling", "offset", "resolution"];
  function applyToDesign(design, items, blSignals) {
    const d = JSON.parse(JSON.stringify(design || {}));
    d.signals = list(d.signals);
    const blNames = new Set(list(blSignals).map((s) => s && s.name).filter(Boolean));
    const applied = [];
    const entry = (name) => {
      let e = d.signals.find((s) => s && s.name === name);
      if (!e) { e = { name, source: blNames.has(name) ? "requirements" : "design", category: "", description: "" }; d.signals.push(e); }
      return e;
    };
    for (const x of list(items)) {
      if (x.status !== "confirmed") continue;
      const v = str(x.value_final != null ? x.value_final : x.value, 200);
      if (!v) continue;
      let name = null; let field = null;
      if (/^signal:/.test(x.target) && WRITABLE.includes(x.attr)) { name = x.target.slice(7); field = x.attr; }
      else if (/^interface:/.test(x.target) && /전달|transfer|delivery/i.test(x.attr)) { name = x.target.slice(10); field = "transfer"; }
      if (!name || !field) continue;
      const exists = d.signals.find((s) => s && s.name === name);
      if (!exists && !blNames.has(name)) continue; // 없는 신호를 새로 만들지 않는다(요구사항 신호의 구체화만)
      const e = entry(name);
      if (str(e[field], 200) === v) continue;
      applied.push({ key: x.key, signal: name, field, from: str(e[field], 200), to: v });
      e[field] = v;
    }
    return { design: d, applied };
  }

  return { SCHEMA, STATUS, ATTRS, ATTR_LABEL, DECISIONS, keyOf, normalizeAi, build, summary, decide, applyToDesign };
});
