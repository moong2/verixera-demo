/* 설계 모델: 구성요소(Component) · 유닛(Unit) · 구현 함수(Function) · 신호 연결.
 *
 * 단위(유닛)는 C 함수 개수가 아니라 설계가 정한 검증 경계다. 한 유닛을 함수 여러 개가 구현할 수 있다.
 * 신호의 방향은 저장하지 않고, 신호마다 누가 쓰고(WRITE) 누가 읽는지(READ)와 고른 경계로 계산한다.
 * 같은 신호가 U01 에서는 출력, U02 에서는 입력, 둘을 품은 구성요소에서는 내부가 된다.
 *
 * 신호 정보의 소유(D-011): 외부 입출력의 의미·요구사항이 정한 단위·범위는 요구사항 Baseline(BL) 의 신호 표,
 * 유닛 사이 신호·내부 상태·구현 자료형·연결은 이 설계(DBL). 요구사항이 정한 값은 설계가 바꾸지 못한다.
 *
 * 브라우저(설계 화면)와 Node(설계 Baseline, 게이트, 에이전트)가 같이 쓴다. 결정: docs/DECISIONS.md D-009 ~ D-011,
 * 계획: docs/requirements/sw-design-boundary.md.
 */
(() => {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;

  const SCHEMA = "ears-design/v1";
  const COMPONENT_RE = /^CMP-[A-Z0-9][A-Z0-9_-]{0,40}$/;
  const UNIT_RE = /^U-[A-Z0-9][A-Z0-9_-]{0,40}$/;
  const DESIGN_ITEM_RE = /^SWD-[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/;
  const FUNC_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
  const SIGNAL_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
  // 바깥(이 소프트웨어 밖)의 상대. "EXT" 또는 "EXT:이름"(센서, 상위 제어기 등).
  const EXTERNAL_RE = /^EXT(?::[A-Za-z0-9_.-]{1,40})?$/;
  const MODES = ["READ", "WRITE", "READ_WRITE"];
  // 신호 종류. parameter·constant 는 흐르는 값이 아니라 기준값이라 입출력 목록에서 따로 묶는다.
  // 신호 사전(2026-11-26): 종류를 세분한다. 방향(입력·출력·내부)은 종류가 아니라 경계에서 계산한다.
  const CATEGORIES = ["interface", "state", "local", "calibration", "configuration", "parameter", "constant", "event"];
  const CATEGORY_LABELS = { interface: "인터페이스", state: "상태 변수", local: "지역 변수", calibration: "보정 파라미터", configuration: "설정 파라미터", parameter: "파라미터", constant: "상수", event: "이벤트" };
  // 흐르는 값이 아니라 기준값인 종류(입출력 목록에서 따로 묶고, 유닛이 쓰면 경고)
  const PARAM_LIKE = ["calibration", "configuration", "parameter", "constant"];
  // 신호 사전의 추가 속성(있을 때만 저장 — 예전 설계·승인본의 모양과 해시가 그대로이게)
  const DETAIL_FIELDS = ["id", "display_name", "raw_min", "raw_max", "scaling", "offset", "resolution", "validity"];
  const SIGNAL_ID_RE = /^SIG-\d{3,6}$/;
  const DIRECTION_LABELS = { input: "입력", output: "출력", inout: "입출력", internal: "내부" };
  // 요구사항이 값을 정했으면 설계가 바꾸지 못하는 필드(D-011).
  // 요구사항(외부 인터페이스 신호)이 정하고 설계가 바꿀 수 없는 값: 물리 단위·물리 범위.
  // 자료형·초기값은 구현 정보라 설계가 정한다 — 예전 요구사항 신호 표에 적혀 있으면 기본값으로만 쓴다(REQUIREMENT_DEFAULTS).
  const REQUIREMENT_OWNED = ["unit", "min", "max"];
  const REQUIREMENT_DEFAULTS = ["type", "initial"];
  const MAX_ITEMS = 500;

  const text = (v, max) => String(v == null ? "" : v).normalize("NFC").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().slice(0, max || 200);
  const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : []);
  const ids = (v, max) => Array.from(new Set(list(v).map((x) => text(x, max || 80)).filter(Boolean)));
  const reqIds = (v) => ids(list(v).map((x) => text(x, 80).replace(/@v\d+$/, "")));
  const modeOf = (v) => {
    const s = text(v, 20).toUpperCase().replace(/[\s/-]+/g, "_");
    if (MODES.includes(s)) return s;
    if (s === "R" || s === "READ_ONLY") return "READ";
    if (s === "W" || s === "WRITE_ONLY") return "WRITE";
    if (s === "RW") return "READ_WRITE";
    return "";
  };
  const reads = (m) => m === "READ" || m === "READ_WRITE";
  const writes = (m) => m === "WRITE" || m === "READ_WRITE";
  const isExternal = (by) => EXTERNAL_RE.test(by);

  // ───────────────────────── 모양 맞추기 ─────────────────────────

  function normalizeComponent(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = text(raw.id, 60);
    if (!id) return null;
    const out = { id, name: text(raw.name, 120), description: text(raw.description, 600) };
    if (raw.requirements != null) out.requirements = reqIds(raw.requirements);
    return out;
  }

  function normalizeUnit(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = text(raw.id, 60);
    if (!id) return null;
    return {
      id,
      name: text(raw.name, 120),
      component: text(raw.component, 60),
      responsibility: text(raw.responsibility, 1000),
      requirements: reqIds(raw.requirements),
      design_items: ids(raw.design_items),
      functions: ids(raw.functions, 64),
      acceptance: list(raw.acceptance).map((x) => text(x, 500)).filter(Boolean),
    };
  }

  // 설계에서 정의하거나 구체화하는 신호. source=requirements 이면 BL 신호에 구현 정보(자료형 등)를 더하는 것.
  function normalizeSignal(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = text(raw.name, 80);
    if (!name) return null;
    const category = text(raw.category, 20).toLowerCase();
    return Object.assign({
      name,
      source: text(raw.source, 20).toLowerCase() === "requirements" ? "requirements" : "design",
      category: CATEGORIES.includes(category) ? category : "",
      type: text(raw.type, 40),
      unit: text(raw.unit, 40),
      min: text(raw.min, 40),
      max: text(raw.max, 40),
      initial: text(raw.initial, 40),
      description: text(raw.description, 300),
      transfer: text(raw.transfer, 200),
    }, detailsOf(raw));
  }
  // 신호 사전의 추가 속성: 값이 있는 것만. enum 은 [{ value, meaning }]
  function detailsOf(raw) {
    const out = {};
    const lim = { id: 12, display_name: 80, validity: 300 };
    for (const k of DETAIL_FIELDS) { const v = text(raw[k], lim[k] || 40); if (v) out[k] = k === "id" ? v.toUpperCase() : v; }
    const en = Array.isArray(raw.enum) ? raw.enum.slice(0, 64).map((e) => ({ value: text(e && e.value, 40), meaning: text(e && e.meaning, 120) })).filter((e) => e.value !== "") : [];
    if (en.length) out.enum = en;
    return out;
  }

  function normalizeAccess(raw) {
    if (!raw || typeof raw !== "object") return null;
    const by = text(raw.by, 60);
    if (!by) return null;
    const out = { by, mode: modeOf(raw.mode) };
    const fn = text(raw.function, 64);
    if (fn) out.function = fn;
    return out;
  }

  function normalizeConnection(raw) {
    if (!raw || typeof raw !== "object") return null;
    const signal = text(raw.signal, 80);
    if (!signal) return null;
    const accesses = [];
    for (const a of Array.isArray(raw.accesses) ? raw.accesses : []) {
      const n = normalizeAccess(a);
      if (n) accesses.push(n);
    }
    return { signal, owner: text(raw.owner, 60), accesses };
  }

  const cap = (arr, fn) => {
    const out = [];
    for (const raw of Array.isArray(arr) ? arr : []) {
      const n = fn(raw);
      if (n) out.push(n);
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  };

  function normalize(design) {
    const d = design && typeof design === "object" ? design : {};
    const bl = d.requirements_baseline && typeof d.requirements_baseline === "object" ? d.requirements_baseline : null;
    const abl = d.architecture_baseline && typeof d.architecture_baseline === "object" ? d.architecture_baseline : null;
    return Object.assign({
      schema: SCHEMA,
      requirements_baseline: bl ? { id: text(bl.id, 60), hash: text(bl.hash, 120) } : null,
    // 근거 아키텍처 승인본(ABL, D-013). 있을 때만 둔다(없던 설계의 모양·해시가 그대로이게).
    }, abl ? { architecture_baseline: { id: text(abl.id, 60), hash: text(abl.hash, 120) } } : {}, {
      components: cap(d.components, normalizeComponent),
      units: cap(d.units, normalizeUnit),
      signals: cap(d.signals, normalizeSignal),
      connections: cap(d.connections, normalizeConnection),
    }, (() => { const m = normalizeMapping(d.data_mapping); return m.length ? { data_mapping: m } : {}; })());
  }

  // 요구사항 데이터(논리적) → 설계 요소(구현) 매핑. [{ data: "DATA-004"|이름, realized_by: [{ kind: signal|function|unit, id }], note }]
  // derived: 따로 실현하지 않고 다른 요구사항 데이터에서 도출(예: '정지 유지 상태' = '과열 보호 상태') — 근거(note) 필수
  const REALIZE_KINDS = ["signal", "function", "unit", "derived"];
  function normalizeMapping(list) {
    const out = [];
    for (const m of Array.isArray(list) ? list.slice(0, 300) : []) {
      if (!m || typeof m !== "object") continue;
      const data = text(m.data, 80);
      if (!data) continue;
      const by = [];
      for (const r of Array.isArray(m.realized_by) ? m.realized_by.slice(0, 20) : []) {
        if (!r || !REALIZE_KINDS.includes(r.kind)) continue;
        const id = text(r.id, 80);
        if (id && !by.some((x) => x.kind === r.kind && x.id === id)) by.push({ kind: r.kind, id });
      }
      const note = text(m.note, 300);
      if (out.some((x) => x.data === data)) continue;
      out.push(Object.assign({ data, realized_by: by }, note ? { note } : {}));
    }
    return out.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  }

  // 요구사항 데이터 사전의 종류(signals.js 와 같은 규칙: kind 가 있으면 그것, 없으면 방향에서)
  const LOGICAL_KINDS = ["state", "data", "parameter", "event", "condition", "timing"];
  const reqKindOf = (s) => (s && s.kind ? s.kind : s && s.direction === "input" ? "external_input" : s && s.direction === "output" ? "external_output" : "");
  // 논리적 데이터 가운데 값(변수)이 될 수 있는 것은 신호 사전에 둔다. 판단 조건·타이밍은 변수가 아니라 함수·로직으로 실현한다(매핑으로만).
  const KIND_CATEGORY = { state: "state", data: "interface", parameter: "parameter", event: "event" };

  // ───────────────────────── 신호 사전(BL + 설계) ─────────────────────────

  // BL 신호 표와 설계 신호를 하나의 사전으로 합친다. 항목마다 정의 출처(source)와, 값마다 어디서 왔는지(origin)를 남긴다.
  // blSignals: 요구사항 Baseline 의 signals (webapp/signals.js 모양). 반환: Map(name → entry)
  function dictionary(design, blSignals) {
    const d = normalize(design);
    const out = new Map();
    for (const s of Array.isArray(blSignals) ? blSignals : []) {
      if (!s || !s.name) continue;
      const rk = reqKindOf(s);
      if (rk === "condition" || rk === "timing") continue;
      const origin = {};
      for (const k of REQUIREMENT_OWNED) if (s[k]) origin[k] = "requirements";
      for (const k of REQUIREMENT_DEFAULTS) if (s[k]) origin[k] = "requirements-default";
      out.set(s.name, {
        name: s.name, source: "requirements", category: KIND_CATEGORY[rk] || "interface", requirement_kind: rk || "", data_id: s.data_id || "",
        type: s.type || "", unit: s.unit || "", min: s.min || "", max: s.max || "", initial: s.initial || "",
        description: s.description || "", requirements: Array.isArray(s.requirements) ? s.requirements.slice() : [],
        legacy_direction: s.direction || "", transfer: "", origin,
      });
    }
    for (const s of d.signals) {
      const base = out.get(s.name);
      if (base) {
        // 요구사항 신호의 구체화: 물리 단위·범위는 비어 있던 것만 설계가 채우고(요구사항 값 유지),
        // 자료형·초기값은 설계가 정한 값이 우선한다(요구사항 신호 표의 예전 값은 기본값).
        for (const k of REQUIREMENT_OWNED) if (!base[k] && s[k]) { base[k] = s[k]; base.origin[k] = "design"; }
        for (const k of REQUIREMENT_DEFAULTS) if (s[k]) { base[k] = s[k]; base.origin[k] = "design"; }
        if (s.category) base.category = s.category;
        if (s.transfer) base.transfer = s.transfer;
        Object.assign(base, detailsOf(s));
        continue;
      }
      const origin = {};
      for (const k of REQUIREMENT_OWNED) if (s[k]) origin[k] = "design";
      out.set(s.name, Object.assign({
        name: s.name, source: "design", category: s.category || "interface",
        type: s.type, unit: s.unit, min: s.min, max: s.max, initial: s.initial,
        description: s.description, requirements: [], legacy_direction: "", transfer: s.transfer, origin,
      }, detailsOf(s)));
    }
    return out;
  }

  // ───────────────────────── 신호 속성 ─────────────────────────

  const num = (v) => { const t = String(v == null ? "" : v).trim(); if (t === "") return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
  // C 정수 자료형의 표현 범위(int16 / int16_t / uint8_t ...). 모르면 null.
  function typeRange(type) {
    const m = String(type || "").trim().match(/^(u?)int(8|16|32)(?:_t)?$/i);
    if (m) { const bits = Number(m[2]); return m[1] ? { min: 0, max: 2 ** bits - 1 } : { min: -(2 ** (bits - 1)), max: 2 ** (bits - 1) - 1 }; }
    if (/^(bool|_Bool|boolean)$/i.test(String(type || "").trim())) return { min: 0, max: 1 };
    return null;
  }
  // 원시값 → 물리값(Physical = Raw × Scaling + Offset). Scaling 이 없으면 원시값 = 물리값으로 본다.
  function physicalOf(raw, e) { const r = num(raw), sc = num(e && e.scaling), of = num(e && e.offset); if (r === null || Number.isNaN(r)) return null; return r * (sc === null || Number.isNaN(sc) ? 1 : sc) + (of === null || Number.isNaN(of) ? 0 : of); }
  const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  function signalSpecProblems(e) {
    const out = [];
    const nums = {};
    for (const k of ["min", "max", "raw_min", "raw_max", "scaling", "offset", "resolution"]) {
      const v = num(e[k]);
      if (Number.isNaN(v)) out.push({ level: "error", field: k, message: `${k} 는 숫자여야 합니다(지금: ${e[k]})` });
      nums[k] = Number.isNaN(v) ? null : v;
    }
    if (nums.scaling === 0) out.push({ level: "error", field: "scaling", message: "Scaling 은 0 일 수 없습니다" });
    if (nums.raw_min !== null && nums.raw_max !== null && nums.raw_min > nums.raw_max) out.push({ level: "error", field: "raw_min", message: "원시값 최소가 최대보다 큽니다" });
    const tr = typeRange(e.type);
    if (tr) for (const k of ["raw_min", "raw_max"]) if (nums[k] !== null && (nums[k] < tr.min || nums[k] > tr.max)) out.push({ level: "error", field: k, message: `${k} ${nums[k]} 가 자료형 ${e.type} 의 범위(${tr.min} ~ ${tr.max})를 벗어납니다` });
    if (nums.scaling !== null && nums.scaling !== 0) {
      for (const [r, p] of [["raw_min", "min"], ["raw_max", "max"]]) {
        if (nums[r] === null || nums[p] === null) continue;
        const phys = nums[r] * nums.scaling + (nums.offset || 0);
        if (!near(phys, nums[p])) out.push({ level: "warning", field: r, message: `원시값 ${nums[r]} × ${nums.scaling} + ${nums.offset || 0} = ${Number(phys.toFixed(9))} 인데 물리 ${p === "min" ? "최소" : "최대"}는 ${nums[p]} 입니다` });
      }
      if (nums.resolution !== null && !near(Math.abs(nums.scaling), nums.resolution)) out.push({ level: "warning", field: "resolution", message: `해상도 ${nums.resolution} 가 Scaling ${nums.scaling} 과 다릅니다 — 확인하세요` });
    }
    if (Array.isArray(e.enum)) { const seen = new Set(); for (const x of e.enum) { if (seen.has(x.value)) out.push({ level: "error", field: "enum", message: `열거값 ${x.value} 가 두 번 있습니다` }); seen.add(x.value); } }
    return out;
  }
  // 경계값 후보: 물리 임계값 기준으로 해상도(없으면 Scaling, 없으면 1) 만큼 아래·같음·위. 원시값도 함께(Scaling 이 있으면).
  function boundaryValues(e, threshold) {
    const t = num(threshold);
    if (t === null || Number.isNaN(t)) return [];
    const step = num(e.resolution) || Math.abs(num(e.scaling) || 0) || 1;
    const sc = num(e.scaling), of = num(e.offset) || 0;
    return [t - step, t, t + step].map((v) => { const phys = Number(v.toFixed(9)); return { physical: phys, raw: sc ? Math.round((phys - of) / sc) : null }; });
  }

  // ───────────────────────── 검증 ─────────────────────────

  // 설계의 문제를 찾는다. opts.requirementIds: 근거 BL 의 요구사항 ID, opts.signals: 근거 BL 의 신호 표.
  // 결과: [{ level: "error" | "warning", where, field, message }]. error 가 있으면 승인(DBL 고정)할 수 없다.
  function validate(design, opts) {
    const o = opts || {};
    const d = normalize(design);
    const problems = [];
    const add = (level, where, field, message) => problems.push({ level, where, field, message: `${where}: ${message}` });
    const knownReqs = o.requirementIds ? new Set(Array.from(o.requirementIds, String)) : null;
    const blSignals = Array.isArray(o.signals) ? o.signals : [];
    const blByName = new Map(blSignals.filter((s) => s && s.name).map((s) => [s.name, s]));

    if (!d.requirements_baseline || !d.requirements_baseline.id || !d.requirements_baseline.hash) {
      add("error", "설계", "requirements_baseline", "근거 요구사항 Baseline(ID·해시)이 없습니다");
    }

    // 구성요소
    const comps = new Map();
    for (const c of d.components) {
      if (!COMPONENT_RE.test(c.id)) add("error", c.id, "id", "구성요소 ID 는 CMP- 로 시작하고 대문자·숫자·'-'·'_' 만 씁니다");
      if (comps.has(c.id)) add("error", c.id, "id", "같은 ID 의 구성요소가 두 번 있습니다");
      else comps.set(c.id, c);
      if (!c.name) add("warning", c.id, "name", "이름이 비어 있습니다");
      if (knownReqs && c.requirements) for (const r of c.requirements) if (!knownReqs.has(r)) add("error", c.id, "requirements", `할당한 요구사항 ${r} 가 근거 Baseline 에 없습니다`);
    }
    if (!d.components.length) add("error", "설계", "components", "구성요소가 하나도 없습니다");

    // 유닛
    const units = new Map();
    const fnOwner = new Map();
    const itemOwner = new Map();
    for (const u of d.units) {
      if (!UNIT_RE.test(u.id)) add("error", u.id, "id", "유닛 ID 는 U- 로 시작하고 대문자·숫자·'-'·'_' 만 씁니다");
      if (units.has(u.id)) add("error", u.id, "id", "같은 ID 의 유닛이 두 번 있습니다");
      else units.set(u.id, u);
      if (!u.name) add("warning", u.id, "name", "이름이 비어 있습니다");
      if (!u.responsibility) add("warning", u.id, "responsibility", "책임(무엇을 하는 유닛인지)이 비어 있습니다");
      const comp = comps.get(u.component);
      if (!u.component) add("error", u.id, "component", "소속 구성요소가 없습니다");
      else if (!comp) add("error", u.id, "component", `소속 구성요소 ${u.component} 가 없습니다`);
      if (!u.requirements.length) add("warning", u.id, "requirements", "할당된 요구사항이 없습니다");
      for (const r of u.requirements) {
        if (knownReqs && !knownReqs.has(r)) add("error", u.id, "requirements", `할당한 요구사항 ${r} 가 근거 Baseline 에 없습니다`);
        if (comp && comp.requirements && !comp.requirements.includes(r)) add("error", u.id, "requirements", `${r} 는 소속 구성요소 ${comp.id} 에 할당되지 않았습니다`);
      }
      for (const it of u.design_items) {
        if (!DESIGN_ITEM_RE.test(it)) add("error", u.id, "design_items", `설계 항목 ID 는 SWD- 로 시작합니다: ${it}`);
        if (itemOwner.has(it) && itemOwner.get(it) !== u.id) add("error", u.id, "design_items", `설계 항목 ${it} 가 ${itemOwner.get(it)} 에도 있습니다(설계 항목은 한 유닛에만 속합니다)`);
        else itemOwner.set(it, u.id);
      }
      for (const f of u.functions) {
        if (!FUNC_RE.test(f)) add("error", u.id, "functions", `C 함수 이름이 올바르지 않습니다: ${f}`);
        if (fnOwner.has(f) && fnOwner.get(f) !== u.id) add("error", u.id, "functions", `함수 ${f} 가 ${fnOwner.get(f)} 에도 있습니다(함수는 한 유닛에만 속합니다)`);
        else fnOwner.set(f, u.id);
      }
    }
    for (const c of comps.values()) if (!d.units.some((u) => u.component === c.id)) add("warning", c.id, "units", "이 구성요소에 유닛이 없습니다");

    // 설계 신호
    const designSignals = new Map();
    for (const s of d.signals) {
      if (!SIGNAL_RE.test(s.name)) add("error", s.name, "name", "신호 이름은 영문자로 시작하고 영문자·숫자·밑줄만 씁니다");
      if (designSignals.has(s.name)) { add("error", s.name, "name", "설계 신호에 같은 이름이 두 번 있습니다"); continue; }
      designSignals.set(s.name, s);
      const bl = blByName.get(s.name);
      if (s.source === "requirements" && !bl) add("error", s.name, "source", "요구사항 신호를 구체화한다고 했지만 근거 Baseline 의 신호 표에 없습니다");
      if (s.source === "design" && bl) add("error", s.name, "name", "요구사항 신호 표에 같은 이름이 있습니다(구체화라면 source 를 requirements 로)");
      if (bl) for (const k of REQUIREMENT_OWNED) if (bl[k] && s[k] && s[k] !== bl[k]) add("error", s.name, k, `요구사항이 정한 값(${bl[k]})을 설계가 바꿀 수 없습니다(설계 값 ${s[k]}). 바꾸려면 요구사항 변경으로 처리합니다`);
      if (s.source === "design") {
        if (!s.category) add("error", s.name, "category", "종류(인터페이스·상태 변수·파라미터·상수)를 정해야 합니다");
        if (!s.type) add("error", s.name, "type", "자료형을 정해야 합니다");
      }
    }

    // 연결
    const dict = dictionary(d, blSignals);
    const connected = new Set();
    for (const c of d.connections) {
      const where = `연결 ${c.signal}`;
      const entry = dict.get(c.signal);
      if (!entry) { add("error", where, "signal", "신호 사전(요구사항 신호 표·설계 신호)에 없는 신호입니다"); continue; }
      if (connected.has(c.signal)) add("error", where, "signal", "같은 신호의 연결이 두 번 있습니다(접근을 한 연결에 모읍니다)");
      connected.add(c.signal);
      if (!c.accesses.length) { add("error", where, "accesses", "누가 쓰고 읽는지(접근)가 없습니다"); continue; }
      const seen = new Set();
      for (const a of c.accesses) {
        if (!a.mode) add("error", where, "mode", `${a.by} 의 접근 방식(READ·WRITE·READ_WRITE)이 없습니다`);
        if (!isExternal(a.by) && !units.has(a.by)) add("error", where, "by", `${a.by} 는 설계에 없는 유닛입니다(바깥이면 EXT 또는 EXT:이름)`);
        if (a.function) {
          if (isExternal(a.by)) add("error", where, "function", "바깥(EXT)에는 함수를 적지 않습니다");
          else if (units.has(a.by) && !units.get(a.by).functions.includes(a.function)) add("error", where, "function", `${a.function} 는 ${a.by} 의 함수가 아닙니다`);
        }
        const key = `${a.by}|${a.function || ""}`;
        if (seen.has(key)) add("error", where, "accesses", `${a.by}${a.function ? `/${a.function}` : ""} 의 접근이 두 번 있습니다`);
        seen.add(key);
      }
      const writers = c.accesses.filter((a) => writes(a.mode));
      const readers = c.accesses.filter((a) => reads(a.mode));
      const flowing = entry.category === "interface" || entry.category === "state";
      if (flowing && !writers.length) add("warning", where, "accesses", "쓰는 쪽(생산자)이 없습니다");
      if (entry.category === "interface" && !readers.length) add("warning", where, "accesses", "읽는 쪽(소비자)이 없습니다");
      const writerOwners = new Set(writers.map((a) => a.by));
      if (writerOwners.size > 1) add("warning", where, "accesses", `여러 곳에서 씁니다(${Array.from(writerOwners).join(", ")}) — 쓰는 순서와 초기화를 설계에 적어야 합니다`);
      if (!c.owner) add("error", where, "owner", "소유자가 없습니다");
      else if (!c.accesses.some((a) => a.by === c.owner)) add("error", where, "owner", `소유자 ${c.owner} 가 이 신호에 접근하지 않습니다`);
      if (entry.category === "state") {
        if (isExternal(c.owner)) add("error", where, "owner", "상태 변수의 소유자는 유닛이어야 합니다");
        const others = c.accesses.filter((a) => a.by !== c.owner);
        if (others.length) add("warning", where, "accesses", `상태 변수를 소유 유닛 밖(${others.map((a) => a.by).join(", ")})에서 씁니다 — 인터페이스로 바꾸는 것을 검토하세요`);
      }
      if (PARAM_LIKE.includes(entry.category) && writers.some((a) => !isExternal(a.by))) {
        add("warning", where, "accesses", `${CATEGORY_LABELS[entry.category]}를 유닛이 씁니다(WRITE) — 종류가 맞는지 확인하세요`);
      }
    }
    for (const s of designSignals.values()) if (s.source === "design" && !connected.has(s.name)) add("warning", s.name, "connections", "어디에도 연결되지 않은 설계 신호입니다");
    // 신호 사전 속성의 정합성(ID, 숫자, 자료형 범위, 원시값↔물리값 변환, 해상도, 열거값, 지역 변수)
    const sigIds = new Map();
    for (const e of dict.values()) {
      if (e.id) {
        if (!SIGNAL_ID_RE.test(e.id)) add("error", e.name, "id", "신호 ID 는 SIG-숫자 형식입니다(예: SIG-001)");
        else if (sigIds.has(e.id)) add("error", e.name, "id", `신호 ID ${e.id} 가 ${sigIds.get(e.id)} 에도 있습니다`);
        else sigIds.set(e.id, e.name);
      }
      for (const p of signalSpecProblems(e)) add(p.level, e.name, p.field, p.message);
      if (e.category === "local") { const c = d.connections.find((x) => x.signal === e.name); if (c && new Set(c.accesses.map((a) => a.by)).size > 1) add("warning", e.name, "category", "지역 변수인데 여러 곳에서 접근합니다 — 인터페이스로 바꾸는 것을 검토하세요"); }
    }

    // 요구사항 데이터 사전의 논리적 데이터가 설계에 반영됐는가: 같은 이름의 설계 신호·연결이 있거나 매핑(data_mapping)이 있으면 반영.
    // 반영 방식(변수·논리식·상태 머신·함수)은 설계가 정한다. 해당 없음(na)은 보지 않는다.
    {
      const fnNames = new Set(d.units.flatMap((u) => u.functions));
      const unitIds = new Set(d.units.map((u) => u.id));
      const byKey = new Map();
      for (const b of blSignals) { if (!b || !b.name) continue; byKey.set(b.name, b); if (b.data_id) byKey.set(b.data_id, b); }
      const mapped = new Set();
      for (const m of d.data_mapping || []) {
        const b = byKey.get(m.data);
        if (!b) { add("error", `매핑 ${m.data}`, "data", "요구사항 데이터 사전에 없는 데이터입니다"); continue; }
        mapped.add(b.name);
        if (!m.realized_by.length) add("warning", `매핑 ${m.data}`, "realized_by", "무엇으로 실현하는지(신호·함수·유닛)가 비어 있습니다");
        for (const r of m.realized_by) {
          if (r.kind === "derived") {
            const src = byKey.get(r.id);
            if (!src) add("error", `매핑 ${m.data}`, "realized_by", `도출 근거 데이터 ${r.id} 가 요구사항 데이터 사전에 없습니다`);
            else if (src.name === b.name) add("error", `매핑 ${m.data}`, "realized_by", "자기 자신에서 도출할 수 없습니다");
            if (!m.note) add("warning", `매핑 ${m.data}`, "note", "다른 데이터에서 도출한다고 했으면 그 근거(왜 같은지·어떻게 계산되는지)를 note 에 적으세요");
            continue;
          }
          const ok = r.kind === "signal" ? dict.has(r.id) || d.connections.some((c) => c.signal === r.id) : r.kind === "function" ? fnNames.has(r.id) : unitIds.has(r.id);
          if (!ok) add("error", `매핑 ${m.data}`, "realized_by", `${r.kind === "signal" ? "신호" : r.kind === "function" ? "함수" : "유닛"} ${r.id} 가 설계에 없습니다`);
        }
      }
      for (const b of blSignals) {
        if (!b || !b.name || !LOGICAL_KINDS.includes(reqKindOf(b)) || b.definition_status === "na") continue;
        const direct = d.connections.some((c) => c.signal === b.name) || d.signals.some((x) => x.name === b.name);
        if (!direct && !mapped.has(b.name)) add("warning", b.name, "data_mapping", `요구사항 데이터${b.data_id ? ` ${b.data_id}` : ""}(${b.kind === "state" ? "내부 상태" : b.kind === "parameter" ? "파라미터" : b.kind === "event" ? "이벤트" : b.kind === "condition" ? "판단 조건" : b.kind === "timing" ? "타이밍" : "내부 데이터"})가 설계에 반영되지 않았습니다 — 어떤 신호·함수·유닛으로 실현하는지 매핑하세요`);
      }
    }

    // 외부 인터페이스 방향(요구사항)과 설계 연결로 계산한 SW 경계 방향이 같은가. 바깥(EXT)이 쓰고 안이 읽으면 입력, 안이 쓰고 바깥이 읽으면 출력.
    // 요구사항에 '내부'로 적힌 예전 신호는 신호 표 검사가 따로 알린다(여기서는 보지 않음).
    const DIR_KO = { input: "입력", output: "출력", inout: "입출력", internal: "내부(바깥 접근 없음)" };
    for (const s of blSignals) {
      if (!s || !s.name || (s.direction !== "input" && s.direction !== "output")) continue;
      if (!d.connections.some((c) => c.signal === s.name)) continue; // 연결이 없는 것은 위의 연결 검사가 알린다
      const dir = directionOf(d, s.name, { kind: "software" });
      if (dir === s.direction) continue;
      add("error", s.name, "direction", `요구사항의 외부 인터페이스 방향은 ${DIR_KO[s.direction]}인데, 설계 연결로 계산한 SW 경계 방향은 ${DIR_KO[dir] || dir || "없음"}입니다 — ${s.direction === "input" ? "바깥(EXT)이 쓰고 유닛이 읽게" : "유닛이 쓰고 바깥(EXT)이 읽게"} 연결을 고치거나, 요구사항 변경으로 방향을 바꿉니다`);
    }

    return problems;
  }

  // ───────────────────────── 경계와 방향 ─────────────────────────

  // 경계: { kind: "software" } | { kind: "component", id } | { kind: "unit", id } | { kind: "function", id: "함수 이름" }
  // 경계 안에 있는 접근인지 판정하는 함수를 돌려준다. 함수 경계에서 접근의 함수 정보가 없으면 판정할 수 없다(null).
  function insideTest(d, boundary) {
    const b = boundary || { kind: "software" };
    const unitComp = new Map(d.units.map((u) => [u.id, u.component]));
    if (b.kind === "software") return (a) => !isExternal(a.by);
    if (b.kind === "component") return (a) => !isExternal(a.by) && unitComp.get(a.by) === b.id;
    if (b.kind === "unit") return (a) => a.by === b.id;
    // 통합 범위(검증 계획): 유닛 집합 또는 구성요소 집합
    if (b.kind === "units") { const set = new Set(b.ids || []); return (a) => set.has(a.by); }
    if (b.kind === "components") { const set = new Set(b.ids || []); return (a) => !isExternal(a.by) && set.has(unitComp.get(a.by)); }
    if (b.kind === "function") {
      const owner = d.units.find((u) => u.functions.includes(b.id));
      return (a) => {
        if (a.function) return a.function === b.id;
        if (owner && a.by === owner.id) return null; // 이 함수가 속한 유닛의 접근인데 어느 함수인지 모른다
        return false;
      };
    }
    throw new Error(`알 수 없는 경계 종류: ${b.kind}`);
  }

  // 한 신호의 방향을 경계 기준으로 계산한다.
  // 반환: "input" | "output" | "inout" | "internal" | null(이 경계와 관계없음) | "unknown"(함수 수준 정보가 없어 판정 불가 — 추정하지 않는다)
  function directionOf(design, signal, boundary) {
    const d = normalize(design);
    const c = d.connections.find((x) => x.signal === signal);
    if (!c) return null;
    const inside = insideTest(d, boundary);
    const flags = { inR: false, inW: false, outR: false, outW: false };
    let unknown = false;
    for (const a of c.accesses) {
      const at = inside(a);
      if (at === null) { unknown = true; continue; }
      if (at) { flags.inR = flags.inR || reads(a.mode); flags.inW = flags.inW || writes(a.mode); }
      else { flags.outR = flags.outR || reads(a.mode); flags.outW = flags.outW || writes(a.mode); }
    }
    if (unknown) return "unknown";
    if (!flags.inR && !flags.inW) return null;
    const input = flags.inR && flags.outW;
    const output = flags.inW && flags.outR;
    if (input && output) return "inout";
    if (input) return "input";
    if (output) return "output";
    return "internal";
  }

  // 경계의 입출력 목록. 파라미터·상수는 방향과 별도로 parameters 에 모은다.
  // 반환: { input:[], output:[], inout:[], internal:[], parameters:[], unknown:[] } — 각 항목은 { name, category, source }
  function ioList(design, blSignals, boundary) {
    const d = normalize(design);
    const dict = dictionary(d, blSignals);
    const out = { input: [], output: [], inout: [], internal: [], parameters: [], unknown: [] };
    for (const c of d.connections) {
      const dir = directionOf(d, c.signal, boundary);
      if (!dir) continue;
      const e = dict.get(c.signal);
      const row = { name: c.signal, category: e ? e.category : "", source: e ? e.source : "" };
      if (e && PARAM_LIKE.includes(e.category)) out.parameters.push(Object.assign({ direction: dir }, row));
      else out[dir].push(row);
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // ───────────────────────── 할당과 함수 매핑 ─────────────────────────

  // 요구사항 할당 현황. leafIds: 할당돼야 하는 요구사항(보통 Baseline 의 잎 요구사항).
  // 반환: { byRequirement: Map(req → [unit]), unallocated: [req], unknown: [{unit, requirement}] }
  function allocation(design, leafIds) {
    const d = normalize(design);
    const by = new Map();
    for (const u of d.units) for (const r of u.requirements) {
      if (!by.has(r)) by.set(r, []);
      by.get(r).push(u.id);
    }
    const leaves = Array.from(leafIds || [], String);
    const known = new Set(leaves);
    const unknown = [];
    for (const u of d.units) for (const r of u.requirements) if (leaves.length && !known.has(r)) unknown.push({ unit: u.id, requirement: r });
    return { byRequirement: by, unallocated: leaves.filter((r) => !by.has(r)), unknown };
  }

  // 코드에서 찾은 함수(trace-check 의 cUnits 결과 등)를 설계 유닛에 대응시킨다.
  // codeFunctions: [{ name, file?, unit? }] — unit 은 코드의 @unit 태그(있으면). 설계의 functions 목록과 태그 둘 다 본다.
  // 반환: { mapped: [{function, unit}], unmapped: [function], conflicts: [{function, design, tag}], unknownUnits: [{function, unit}],
  //         unitsWithoutCode: [unit], missingFunctions: [{unit, function}] }
  function mapFunctions(design, codeFunctions) {
    const d = normalize(design);
    const unitIds = new Set(d.units.map((u) => u.id));
    const designOwner = new Map();
    for (const u of d.units) for (const f of u.functions) designOwner.set(f, u.id);
    const res = { mapped: [], unmapped: [], conflicts: [], unknownUnits: [], unitsWithoutCode: [], missingFunctions: [] };
    const found = new Set();
    const covered = new Set();
    for (const cf of Array.isArray(codeFunctions) ? codeFunctions : []) {
      const name = cf && text(cf.name, 64);
      if (!name) continue;
      found.add(name);
      const tag = cf.unit ? text(cf.unit, 60) : "";
      const fromDesign = designOwner.get(name) || "";
      if (tag && !unitIds.has(tag)) { res.unknownUnits.push({ function: name, unit: tag }); continue; }
      if (tag && fromDesign && tag !== fromDesign) { res.conflicts.push({ function: name, design: fromDesign, tag }); continue; }
      const unit = tag || fromDesign;
      if (!unit) { res.unmapped.push(name); continue; }
      res.mapped.push({ function: name, unit });
      covered.add(unit);
    }
    for (const u of d.units) {
      if (!covered.has(u.id)) res.unitsWithoutCode.push(u.id);
      for (const f of u.functions) if (!found.has(f)) res.missingFunctions.push({ unit: u.id, function: f });
    }
    return res;
  }

  const api = Object.freeze({
    normalizeMapping, LOGICAL_KINDS, REALIZE_KINDS, SCHEMA, MODES, CATEGORIES, CATEGORY_LABELS, DIRECTION_LABELS, REQUIREMENT_OWNED, REQUIREMENT_DEFAULTS,
    COMPONENT_RE, UNIT_RE, DESIGN_ITEM_RE, EXTERNAL_RE,
    normalize, dictionary, validate, directionOf, ioList, allocation, mapFunctions, isExternal, typeRange, physicalOf, signalSpecProblems, boundaryValues, PARAM_LIKE, DETAIL_FIELDS,
  });
  root.EarsDesignModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
