/* 신호 표(인터페이스 사전): 요구사항이 말하는 입력·출력 신호의 이름, 방향, 자료형, 단위, 범위를 사람이 정해 승인하는 표.
 *
 * 요구사항 단계에서 정해 Baseline 에 함께 고정한다. 코드·시험 에이전트는 이 표의 이름·자료형·단위만 쓰고,
 * 설계 문서는 쓰는 신호를 `@signal 이름@vN` 으로 선언한다(추적 점검 T12).
 * 브라우저(요구사항 화면)와 Node(Baseline 검증, 에이전트, 추적 점검)가 같이 쓴다.
 */
(() => {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;

  const DIRECTIONS = ["input", "output", "internal"];
  const DIRECTION_LABELS = { input: "입력", output: "출력", internal: "내부" };
  // 요구사항(외부 인터페이스 신호)에서 고를 수 있는 방향: SW 경계 기준 입력·출력만. internal 은 예전 자료를 읽기 위해서만 남긴다.
  const EXTERNAL_DIRECTIONS = ["input", "output"];
  // 자주 쓰는 자료형(화면의 선택 목록). 다른 이름(프로젝트의 typedef 등)도 받는다.
  const TYPES = ["bool", "uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64", "enum"];
  const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
  const TYPE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
  const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  const MAX_SIGNALS = 300;
  // 신호의 버전을 결정하는 필드. 이 가운데 하나라도 바뀌면 버전이 오른다.
  // 요구사항 데이터 사전(docs/requirements/requirements-data-dictionary.md): 뒤의 속성은 값이 있을 때만 저장한다 — 예전 고정본의 해시·버전 그대로.
  const CONTENT_FIELDS = ["name", "direction", "type", "unit", "min", "max", "initial", "description", "requirements",
    "data_id", "kind", "logical_type", "allowed_values", "activation", "release", "expression", "timing", "propositions", "definition_status", "evidence",
    // 신호 속성(docs/requirements/signal-extraction.md S1) — 요구사항에 정의된 것만, 값이 있을 때만 저장
    "raw_min", "raw_max", "resolution", "scale", "offset", "reset", "invalid", "tolerance", "update_period", "timeout", "thresholds", "aliases"];
  // 글 한 줄 속성(값이 있을 때만). Physical Min/Max·Unit·Initial 은 예전 칸(min·max·unit·initial)을 쓴다.
  const ATTRS = ["raw_min", "raw_max", "resolution", "scale", "offset", "reset", "invalid", "tolerance", "update_period", "timeout"];
  const ATTR_LABELS = { min: "물리 최소", max: "물리 최대", unit: "물리 단위", initial: "초기값", raw_min: "원시 최소", raw_max: "원시 최대", resolution: "분해능", scale: "Scaling", offset: "Offset", reset: "Reset 값", invalid: "무효 값·조건", tolerance: "허용 오차", update_period: "갱신 주기", timeout: "Timeout", allowed_values: "허용값", logical_type: "논리 자료형", thresholds: "기능 임계값" };
  // 출처를 남기는 속성(속성별 출처 요구사항)
  const SOURCED = ["unit", "min", "max", "initial", "logical_type", "allowed_values", ...ATTRS];
  // 요구사항 단계에서 독립 신호로 만들지 않는 종류 — 관련 신호의 속성(동작 조건·타이밍·기능 임계값)으로 둔다
  const NOT_SIGNAL_KINDS = ["event", "condition", "timing"];
  // 데이터 종류: 외부 입력·출력(방향 있음)과 논리적 내부 데이터(방향 없음 — 구현 형태는 설계가 정함)
  const KINDS = ["external_input", "external_output", "state", "data", "parameter", "event", "condition", "timing"];
  const KIND_LABELS = { external_input: "외부 입력", external_output: "외부 출력", state: "내부 상태", data: "내부 데이터", parameter: "파라미터", event: "이벤트", condition: "판단 조건", timing: "타이밍" };
  const INTERNAL_KINDS = KINDS.slice(2);
  const LOGICAL_TYPES = ["boolean", "integer", "real", "enum", "event", "duration"];
  const LOGICAL_TYPE_LABELS = { boolean: "참·거짓", integer: "정수", real: "실수", enum: "열거(상태)", event: "사건", duration: "시간" };
  const DEF_STATUS = ["confirmed", "undefined", "na"];
  const DATA_ID_RE = /^DATA-\d{3,}$/;
  // 종류: 적혀 있으면 그것, 없으면 방향에서(예전 자료)
  const kindOf = (s) => (s && KINDS.includes(s.kind) ? s.kind : s && s.direction === "input" ? "external_input" : s && s.direction === "output" ? "external_output" : "");

  // AI 가 요구사항에 없는 값을 구현을 위해 정했다고 밝힐 수 있는 필드. 사람이 그 칸을 고치거나 확인하면 표시가 사라진다.
  const ASSUMABLE = ["direction", "type", "unit", "min", "max", "initial"];
  const ASSUMED_LABELS = { direction: "방향", type: "자료형", unit: "단위", min: "최소", max: "최대", initial: "초기값" };

  const text = (v, max) => String(v == null ? "" : v).normalize("NFC").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().slice(0, max || 200);

  function directionOf(v) {
    const s = text(v, 20).toLowerCase();
    if (DIRECTIONS.includes(s)) return s;
    if (/^(in|입력)$/.test(s)) return "input";
    if (/^(out|출력)$/.test(s)) return "output";
    if (/^(내부|local|state|상태)$/.test(s)) return "internal";
    return "";
  }

  // 사람이나 AI 가 준 값 하나를 정해진 모양으로 맞춘다. 이름이 없으면 null.
  function normalizeOne(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = text(raw.name, 80);
    if (!name) return null;
    const reqs = Array.isArray(raw.requirements) ? raw.requirements : typeof raw.requirements === "string" ? raw.requirements.split(/[\s,]+/) : [];
    const assumed = Array.isArray(raw.assumed) ? ASSUMABLE.filter((k) => raw.assumed.map((x) => String(x).toLowerCase()).includes(k)) : [];
    return Object.assign(assumed.length ? { assumed } : {}, {
      name,
      direction: directionOf(raw.direction),
      type: text(raw.type, 40),
      unit: text(raw.unit, 40),
      min: text(raw.min, 40),
      max: text(raw.max, 40),
      initial: text(raw.initial, 40),
      description: text(raw.description != null ? raw.description : raw.desc, 300),
      requirements: Array.from(new Set(reqs.map((r) => text(r, 80).replace(/@v\d+$/, "")).filter(Boolean))).sort(),
    }, detailsOf(raw));
  }

  // 데이터 사전 속성(값이 있을 때만 — 없는 키는 저장하지 않는다)
  function detailsOf(raw) {
    const o = {};
    const id = text(raw.data_id, 20).toUpperCase();
    if (id) o.data_id = id;
    if (KINDS.includes(raw.kind)) o.kind = raw.kind;
    const lt = text(raw.logical_type, 20).toLowerCase();
    if (lt) o.logical_type = lt;
    const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\s*[,/·|]\s*/) : []).map((x) => text(x, 60)).filter(Boolean);
    const av = Array.from(new Set(list(raw.allowed_values))).slice(0, 30);
    if (av.length) o.allowed_values = av;
    for (const k of ["activation", "release", "expression", "timing"]) { const v = text(raw[k], 300); if (v) o[k] = v; }
    // 근거 문장: 이 데이터를 직접 말하는 요구사항 문장·수용 기준(내부 데이터가 설계 구조를 미리 정하지 않게)
    const ev = text(raw.evidence, 500);
    if (ev) o.evidence = ev;
    const props = Array.from(new Set(list(raw.propositions))).slice(0, 20);
    if (props.length) o.propositions = props;
    if (DEF_STATUS.includes(raw.definition_status)) o.definition_status = raw.definition_status;
    for (const k of ATTRS) { const v = text(raw[k], 120); if (v) o[k] = v; }
    // 기능 판단 임계값: 범위(min·max)가 아니다 — 값·단위·적용 조건·출처 요구사항
    const th = (Array.isArray(raw.thresholds) ? raw.thresholds : []).map((t) => t && typeof t === "object" ? ({ value: text(t.value, 40), unit: text(t.unit, 20), condition: text(t.condition, 200), requirement: text(t.requirement, 80).replace(/@v\d+$/, "") }) : null)
      .filter((t) => t && t.value).map((t) => { for (const k of ["unit", "condition", "requirement"]) if (!t[k]) delete t[k]; return t; }).slice(0, 20);
    if (th.length) o.thresholds = th;
    const al = Array.from(new Set(list(raw.aliases))).filter((x) => x !== text(raw.name, 80)).slice(0, 10);
    if (al.length) o.aliases = al;
    // 속성별 출처 요구사항(내용 해시에 넣지 않음 — 추적용)
    if (raw.sources && typeof raw.sources === "object") {
      const src = {};
      for (const [k, v] of Object.entries(raw.sources)) if (SOURCED.includes(k) || k === "thresholds") { const ids = Array.from(new Set(list(v).map((x) => x.replace(/@v\d+$/, "")))).slice(0, 20); if (ids.length) src[k] = ids; }
      if (Object.keys(src).length) o.sources = src;
    }
    // 사람이 표에서 고친 칸: AI 가 덮어쓰지 않는다(다르게 제안하면 충돌로)
    const lk = Array.from(new Set(list(raw.locked))).filter((k) => SOURCED.includes(k) || ["description", "requirements", "kind", "direction"].includes(k));
    if (lk.length) o.locked = lk;
    // 덮어쓰지 않고 남긴 충돌: 같은 속성을 다르게 정의한 요구사항·제안
    const cf = (Array.isArray(raw.conflicts) ? raw.conflicts : []).map((c) => c && typeof c === "object" ? ({ field: text(c.field, 30), current: text(c.current, 120), proposed: text(c.proposed, 120), requirement: text(c.requirement, 80) }) : null).filter((c) => c && c.field).slice(0, 20);
    if (cf.length) o.conflicts = cf;
    return o;
  }

  function normalize(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const s = normalizeOne(raw);
      if (s) out.push(s);
      if (out.length >= MAX_SIGNALS) break;
    }
    return out;
  }

  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  // 표의 문제를 찾는다. requirementIds: 지금 있는 요구사항 ID(주면 연결을 확인한다).
  // 결과: [{ level: "error" | "warning", name, field, message }]. error 가 있으면 Baseline 으로 고정할 수 없다.
  function validate(list, requirementIds) {
    const signals = normalize(list);
    const problems = [];
    const add = (level, s, field, message) => problems.push({ level, name: s.name, field, message: `${s.name}: ${message}` });
    const known = requirementIds ? new Set(Array.from(requirementIds, String)) : null;
    const seen = new Map();
    const ids = new Map();
    for (const s of signals) if (s.data_id) { if (ids.has(s.data_id)) add("error", s, "data_id", `데이터 ID ${s.data_id} 가 ${ids.get(s.data_id)} 에도 있습니다`); else ids.set(s.data_id, s.name); }
    for (const s of signals) {
      // 길이가 문제인 이름에 형식 안내만 보이던 것을 나눈다(QA 2026-11-26)
      if (!NAME_RE.test(s.name)) add("error", s, "name", /^[A-Za-z][A-Za-z0-9_]*$/.test(s.name) ? `이름이 너무 깁니다(${s.name.length}자 — 63자 이하)` : "이름은 영문자로 시작하고 영문자·숫자·밑줄만 씁니다(코드의 이름으로 쓰기 위해)");
      const key = s.name.toLowerCase();
      if (seen.has(key)) add("error", s, "name", seen.get(key) === s.name ? "같은 이름의 신호가 두 번 있습니다" : `대소문자만 다른 이름이 있습니다 (${seen.get(key)})`);
      else seen.set(key, s.name);
      // 요구사항 데이터: 외부 입력·출력은 SW 경계 기준 방향을, 논리적 내부 데이터(상태·데이터·파라미터·이벤트·조건·타이밍)는 방향 없이 종류를 정한다.
      // 유닛 사이 전달 변수 같은 구현 신호는 요구사항 데이터가 아니다(설계의 신호 사전).
      const kind = kindOf(s);
      if (!kind && s.direction === "internal") add("error", s, "kind", "종류를 고르세요 — 요구사항이 말하는 내부 상태·내부 데이터·파라미터·이벤트·판단 조건·타이밍이면 그 종류로, 유닛을 나누면서 생기는 구현 신호라면 표에서 빼고 설계의 신호 사전에 둡니다");
      else if (!kind) add("error", s, "kind", "종류를 정해야 합니다(외부 입력·외부 출력이면 SW 경계 기준 방향, 그 밖에는 논리적 내부 데이터의 종류)");
      else if (kind === "external_input" && s.direction !== "input") add("error", s, "direction", "외부 입력은 방향이 입력(바깥에서 들어옴)이어야 합니다");
      else if (kind === "external_output" && s.direction !== "output") add("error", s, "direction", "외부 출력은 방향이 출력(바깥으로 나감)이어야 합니다");
      else if (INTERNAL_KINDS.includes(kind) && (s.direction === "input" || s.direction === "output")) add("error", s, "direction", "SW 경계 방향(입력·출력)은 외부 입력·출력에만 씁니다 — 내부 데이터는 방향을 비웁니다");
      if (s.data_id && !DATA_ID_RE.test(s.data_id)) add("error", s, "data_id", `데이터 ID 는 DATA-숫자 형식입니다(지금: ${s.data_id})`);
      if (s.logical_type && !LOGICAL_TYPES.includes(s.logical_type)) add("error", s, "logical_type", `논리 자료형은 ${LOGICAL_TYPES.join(", ")} 가운데 하나입니다(지금: ${s.logical_type})`);
      if (NOT_SIGNAL_KINDS.includes(kind)) add("warning", s, "kind", `${KIND_LABELS[kind]}은(는) 독립 신호로 두지 않습니다 — 관련 신호의 ${kind === "timing" ? "시간 속성(갱신 주기·Timeout)·동작 조건" : kind === "event" ? "동작 조건(활성화·해제)" : "동작 조건·기능 임계값"}으로 옮기고 이 줄은 지우세요`);
      if (kind === "condition" && !s.expression) add("warning", s, "expression", "판단 조건인데 논리식(예: temp >= trip_threshold)이 비어 있습니다");
      for (const c of s.conflicts || []) add("error", s, c.field, `${ATTR_LABELS[c.field] || c.field} 충돌 — 지금 '${c.current || "(비어 있음)"}', ${c.requirement ? `${c.requirement} 에서 ` : ""}'${c.proposed}' — 어느 쪽이 맞는지 정하세요(자동으로 덮어쓰지 않았습니다)`);
      if (s.definition_status === "undefined") add("warning", s, "definition_status", "미정으로 표시되어 있습니다 — 요구사항에서 정할 것이 남았습니다");
      // 설계 자유도: 내부 상태·데이터·파라미터는 요구사항 문장에 근거가 있어야 한다. 근거 없이 '있으면 좋은' 데이터는 설계 데이터(설계의 신호 사전).
      if (["state", "data", "parameter"].includes(kind) && !s.evidence) {
        if (s.definition_status === "confirmed") add("error", s, "evidence", "근거 문장(이 데이터를 직접 말하는 요구사항 문장·수용 기준) 없이 확정할 수 없습니다 — 요구사항에 근거가 없으면 설계 데이터로 둡니다");
        else add("warning", s, "evidence", kind === "data" ? "내부 데이터는 요구사항이 이름을 붙여 말하는 판단·연산 결과만 둡니다 — 근거 문장을 적거나, 중간 계산값이면 표에서 빼고 설계에서 정합니다" : "근거 문장(요구사항 문장·수용 기준)을 적으세요");
      }
      // 자료형·초기값은 설계가 정한다(적혀 있으면 설계의 기본값). 형식만 본다.
      if (s.type && !TYPE_RE.test(s.type)) add("error", s, "type", `자료형 이름이 올바르지 않습니다: ${s.type}`);
      // 단위에 배율이 섞인 것(예: '0.1 °C', '10 ms'): 요구사항에는 물리 단위만, 배율(Scaling·해상도)은 설계의 신호 사전에
      if (/^\s*[+-]?\d*\.?\d+\s*(?:[x×*]\s*)?\S/.test(s.unit) && !/^\s*\d+\s*$/.test(s.unit)) add("warning", s, "unit", `단위(${s.unit})에 배율이 섞여 있습니다 — 요구사항에는 물리 단위(예: °C)만 적고, 배율은 설계의 Scaling·해상도로 둡니다`);
      const num = (v) => (NUMBER_RE.test(v) ? Number(v) : null);
      const lo = num(s.min);
      const hi = num(s.max);
      if (s.min && lo === null) add("error", s, "min", `최소값이 숫자가 아닙니다: ${s.min}`);
      if (s.max && hi === null) add("error", s, "max", `최대값이 숫자가 아닙니다: ${s.max}`);
      if (lo !== null && hi !== null && lo > hi) add("error", s, "min", `최소값(${s.min})이 최대값(${s.max})보다 큽니다`);
      const init = num(s.initial);
      if (init !== null && ((lo !== null && init < lo) || (hi !== null && init > hi))) add("error", s, "initial", `초기값(${s.initial})이 범위 밖입니다`);
      if (s.type === "bool" && (s.min || s.max)) add("warning", s, "min", "bool 신호에는 범위를 두지 않습니다");
      if (s.type !== "bool" && s.type !== "enum" && s.type && !s.unit) add("warning", s, "unit", "단위가 비어 있습니다 (단위가 없는 값이면 '-' 를 적습니다)");
      if (!s.description) add("warning", s, "description", "설명이 비어 있습니다");
      // AI 가 정한 값 가운데 아직 값이 남아 있는 칸. 고정하면 사람이 승인한 것이 되므로 고정 전에 보게 한다.
      for (const k of (s.assumed || []).filter((f) => s[f])) add("warning", s, k, `${ASSUMED_LABELS[k]}(${s[k]})은 요구사항에 없어 AI 가 정한 값입니다. 맞는지 확인하세요`);
      if (!s.requirements.length) add("warning", s, "requirements", "이 신호를 쓰는 요구사항이 적혀 있지 않습니다");
      else if (known) for (const id of s.requirements) if (!known.has(id)) add("error", s, "requirements", `연결한 요구사항 ${id} 가 없습니다`);
    }
    return problems;
  }

  // 대화에서 AI 가 제안한 변경(add·update·delete)을 표에 적용한다. 돌려주는 것: { signals, applied }.
  // update 는 준 필드만 바꾼다. 이름을 바꾸려면 rename 에 새 이름을 준다.
  // opts.ai: AI 가 낸 변경 — 요구사항 단계의 정책을 지킨다
  //  · 독립 신호로 두지 않는 것(이벤트·판단 조건·타이밍·단순 비교 임계값)은 추가하지 않고 rejected 로 알린다
  //  · 사람이 고친 칸(locked)과, 다른 요구사항이 정한 값은 덮어쓰지 않고 conflicts 로 남긴다
  //  · 속성별 출처(sources)를 남긴다(action.sources 가 없으면 action.requirements 를 그 속성의 출처로)
  function applyActions(current, actions, opts) {
    if (opts && opts.ai) return applyAi(current, actions);
    const list = normalize(current);
    let applied = 0;
    for (const a of Array.isArray(actions) ? actions : []) {
      if (!a || typeof a !== "object") continue;
      const name = text(a.name, 80);
      if (!name) continue;
      const i = list.findIndex((s) => s.name === name);
      const op = String(a.op || "").toLowerCase();
      if (op === "delete") { if (i >= 0) { list.splice(i, 1); applied += 1; } continue; }
      if (op !== "add" && op !== "update") continue;
      const base = i >= 0 ? list[i] : { name };
      const merged = Object.assign({}, base);
      for (const k of ACTION_FIELDS) if (a[k] !== undefined) merged[k] = a[k];
      if (a.desc !== undefined && a.description === undefined) merged.description = a.desc;
      if (a.rename) merged.name = a.rename;
      const next = normalizeOne(merged);
      if (!next) continue;
      if (i >= 0) list[i] = next; else if (list.length < MAX_SIGNALS) list.push(next); else continue;
      applied += 1;
    }
    return { signals: list, applied };
  }

  const ACTION_FIELDS = ["direction", "type", "unit", "min", "max", "initial", "description", "requirements", "assumed", "kind", "logical_type", "allowed_values", "activation", "release", "expression", "timing", "propositions", "definition_status", "evidence", ...ATTRS, "thresholds", "aliases", "sources"];
  // 단순 비교 임계값을 파라미터로 만든 것(예: overheat_stop_threshold — "75 °C 이상이면"): 보정·설정 파라미터라는 근거가 없으면 신호가 아니다
  const looksThreshold = (a) => a.kind === "parameter" && /thresh|limit|임계|기준값/i.test(`${a.name || ""} ${a.description || ""}`) && !/보정|설정\s*값|설정할 수|calibrat|configur|튜닝|tuning/i.test(`${a.evidence || ""} ${a.description || ""}`);
  function applyAi(current, actions) {
    const list = normalize(current);
    let applied = 0;
    const rejected = [];
    let conflicts = 0;
    const same = (x, y) => String(x == null ? "" : Array.isArray(x) ? x.join(",") : x) === String(y == null ? "" : Array.isArray(y) ? y.join(",") : y);
    for (const a of Array.isArray(actions) ? actions : []) {
      if (!a || typeof a !== "object") continue;
      const name = text(a.name, 80);
      if (!name) continue;
      const op = String(a.op || "").toLowerCase();
      const i = list.findIndex((s) => s.name === name || (s.aliases || []).includes(name));
      if (op === "delete") {
        // 다른 요구사항이 아직 쓰는 신호는 지우지 않는다(근거 확인)
        if (i >= 0) { if (a.keep_if_used !== false && (list[i].requirements || []).length && a.reason !== "no_requirement") { rejected.push({ name, reason: "다른 요구사항이 쓰는 신호라 지우지 않았습니다 — 쓰는 요구사항을 확인하세요" }); continue; } list.splice(i, 1); applied++; }
        continue;
      }
      if (op !== "add" && op !== "update") continue;
      const kind = a.kind || (i >= 0 ? list[i].kind : "");
      if (i < 0 && (NOT_SIGNAL_KINDS.includes(kind) || looksThreshold(a))) { rejected.push({ name, reason: looksThreshold(a) ? "단순 비교 임계값은 독립 신호가 아닙니다 — 비교하는 신호의 기능 임계값(thresholds)으로" : `${KIND_LABELS[kind] || kind}은(는) 독립 신호가 아닙니다 — 관련 신호의 동작 조건·시간 속성으로` }); continue; }
      const base = i >= 0 ? list[i] : { name };
      const merged = JSON.parse(JSON.stringify(base));
      const reqs = (Array.isArray(a.requirements) ? a.requirements : []).map((x) => text(x, 80).replace(/@v\d+$/, "")).filter(Boolean);
      const srcOf = (k) => (a.sources && Array.isArray(a.sources[k]) && a.sources[k].length ? a.sources[k] : reqs).map((x) => text(x, 80).replace(/@v\d+$/, ""));
      merged.sources = Object.assign({}, base.sources || {});
      merged.conflicts = (base.conflicts || []).slice();
      for (const k of ACTION_FIELDS) {
        if (a[k] === undefined || k === "sources") continue;
        if (k === "requirements") { merged.requirements = Array.from(new Set([...(base.requirements || []), ...reqs])); continue; }
        if (k === "aliases") { merged.aliases = Array.from(new Set([...(base.aliases || []), ...(Array.isArray(a.aliases) ? a.aliases : [])])); continue; }
        if (k === "thresholds") {
          // 이번에 다룬 요구사항에서 온 예전 임계값은 새 것으로 바꾼다(요구사항이 바뀌면 옛 기준값이 남지 않게)
          const incoming = (Array.isArray(a.thresholds) ? a.thresholds : []);
          const redo = new Set([...reqs, ...incoming.map((t) => t && t.requirement).filter(Boolean)]);
          const have = (base.thresholds || []).filter((h) => !(h.requirement && redo.has(h.requirement)));
          const add = (Array.isArray(a.thresholds) ? a.thresholds : []).filter((t) => t && t.value && !have.some((h) => same(h.value, t.value) && same(h.condition, t.condition)));
          merged.thresholds = have.concat(add);
          continue;
        }
        const was = base[k];
        const empty = was == null || was === "" || (Array.isArray(was) && !was.length);
        if (!empty && !same(was, a[k]) && SOURCED.includes(k)) {
          // 사람이 고친 칸, 또는 다른 요구사항이 정한 값: 덮어쓰지 않고 충돌로
          const fromOther = (base.sources && base.sources[k] || []).length && !srcOf(k).some((r) => (base.sources[k] || []).includes(r));
          if ((base.locked || []).includes(k) || fromOther) {
            if (!merged.conflicts.some((c) => c.field === k && same(c.proposed, a[k]))) { merged.conflicts.push({ field: k, current: String(was), proposed: Array.isArray(a[k]) ? a[k].join(", ") : String(a[k]), requirement: srcOf(k).join(",") }); conflicts++; }
            continue;
          }
        }
        merged[k] = a[k];
        if (SOURCED.includes(k) && a[k] !== "" && srcOf(k).length) merged.sources[k] = Array.from(new Set(srcOf(k)));
      }
      if (a.rename && i >= 0) { merged.aliases = Array.from(new Set([...(merged.aliases || []), base.name])); merged.name = a.rename; }
      const next = normalizeOne(merged);
      if (!next) continue;
      if (i >= 0) list[i] = next; else if (list.length < MAX_SIGNALS) list.push(next); else continue;
      applied++;
    }
    return { signals: list, applied, rejected, conflicts };
  }

  // 신호 추출 규칙(추출 에이전트 tools/agent/signal-extract.js 와 대화의 ears_signals 지시가 같이 쓴다)
  const EXTRACT_RULES = [
    "## 요구사항 데이터 사전(신호) 추출 규칙",
    "목표는 신호 개수가 아니라 정확성·속성 완전성·중복 방지다.",
    "### 추출 대상(이것만)",
    "- 외부 입력(kind external_input, direction input) · 외부 출력(kind external_output, direction output): SW 경계를 넘어 주고받는 값",
    "- 요구사항이 이름을 붙여 명시적으로 정의한 내부 상태(kind state)·내부 데이터(kind data) — 근거 문장(evidence) 필수",
    "- 명시적으로 정의된 보정·설정 파라미터(kind parameter) — '설정할 수 있다', '보정값' 같은 근거 문장 필수",
    "### 독립 신호로 만들지 않는 것 → 관련 신호의 속성으로",
    "- 단순 비교 임계값(예: '온도가 75 °C 이상이면') → 그 온도 신호의 thresholds: [{ value, unit, condition, requirement }]",
    "- 논리식·조건식·LTL/MTL 명제 → 관련 출력·상태 신호의 activation·release(동작 조건). 명제 하나 = 신호 하나가 아니다",
    "- 단순 이벤트(전원 투입·초기화 등)·시간 제약(응답 시간 등) → 관련 신호의 activation·release·timeout·update_period",
    "- AI 가 추론한 중간 연산값, 유닛 사이 전달값·이전 값·버퍼·카운터·플래그 같은 구현 변수 → 넣지 않는다(설계가 정한다)",
    "### 수치의 뜻을 나눈다",
    "- min·max 는 유효 물리 범위(Physical Min/Max)만: '유효 입력 범위는 -40~150 °C' → min -40, max 150. 판단 기준값(75 °C 이상)을 min·max 에 넣지 않는다",
    "- raw_min·raw_max(유효 원시값 범위) · resolution(분해능) · scale·offset(Scaling) · initial(초기값 — 전원 투입·초기화 직후 값) · reset(Reset 값 — Reset 명령·리셋 동작이 명시될 때만. 전원 투입 직후 값은 initial) · invalid(무효 값·조건) · tolerance(허용 오차) · update_period(입력이 갱신되는 주기) · timeout(입력 갱신이 끊겼다고 보는 시간 — 통신·센서 끊김 판단만) · allowed_values(Enum·허용값) · logical_type(boolean·integer·real·enum·duration)",
    "- 응답 시간('50 ms 이내에 활성화')·지연('소등 지연 시간 후')은 timeout 이 아니다 — 관련 출력 신호의 timing(예: '활성화 조건 성립 후 50 ms 이내')에 적는다",
    "- 조건별 범위·값은 그 조건을 유지한다(thresholds 의 condition, activation·release)",
    "- 요구사항에 정의되지 않은 속성은 키를 넣지 않는다(지어내지 않는다). 자료형 표현 범위(int16 등)는 설계가 정한다 — type 은 쓰지 않는다",
    "### 통합·출처·충돌",
    "- 같은 신호를 말하는 모든 요구사항을 찾아 신호 하나에 합친다(requirements 에 모두). 요구사항마다 신호를 따로 만들지 않는다",
    "- 다른 이름으로 같은 대상을 말하면 aliases 에 적는다(의미가 같을 때만 합친다)",
    "- 속성마다 출처 요구사항을 sources: { 속성: [REQ…] } 로 적는다",
    "- 서로 다른 요구사항이 같은 속성을 다르게 정하면 고르지 말고 둘 다 알린다(자연어로) — 프로그램이 충돌로 표시한다",
    "### 바뀐 요구사항만 다룰 때(증분)",
    "- [바뀐 요구사항]이 주어지면 그 요구사항과 연결된 신호·속성만 add·update 한다. 다른 신호는 건드리지 않는다. 사람이 고친 칸(locked)은 다시 쓰지 않는다",
    "- 지우기(delete)는 그 신호를 쓰던 요구사항이 모두 사라졌을 때만, reason: \"no_requirement\" 와 함께",
    "### 출력",
    "```ears_signals",
    JSON.stringify({ actions: [
      { op: "add", name: "sensor_temp", kind: "external_input", direction: "input", logical_type: "real", unit: "°C", min: "-40", max: "150", thresholds: [{ value: "75", unit: "°C", condition: "이상이면 정지 명령 활성", requirement: "REQ-A-1" }], description: "센서 온도(물리값)", requirements: ["REQ-A-1", "REQ-A-3"], sources: { unit: ["REQ-A-1"], min: ["REQ-A-3"], max: ["REQ-A-3"] } },
      { op: "update", name: "stop_cmd", kind: "external_output", direction: "output", logical_type: "boolean", initial: "false", activation: "유효 온도 ≥ 75 °C 또는 센서 무효", requirements: ["REQ-A-1", "REQ-A-2"], sources: { initial: ["REQ-A-4"] } },
    ] }),
    "```",
  ].join("\n");

  // 요구사항을 지우면(또는 없는 요구사항을 가리키면) 신호 표의 참조를 정리한다: 쓰는 요구사항·속성별 출처·기능 임계값의 출처·충돌에서 뺀다.
  // keep: 지금 있는 요구사항 ID(주면 그 밖의 ID 를 모두 뺀다) · removed: 지운 ID(주면 그것만 뺀다). 신호 자체는 지우지 않는다(근거가 사라진 신호는 orphans 로 알림).
  function pruneRequirementRefs(list, opts) {
    const keep = opts && opts.keep ? new Set(Array.from(opts.keep, String)) : null;
    const removed = opts && opts.removed ? new Set(Array.from(opts.removed, String)) : null;
    const gone = (id) => (removed ? removed.has(String(id)) : keep ? !keep.has(String(id)) : false);
    const touched = []; const orphans = []; const refs = new Set();
    const out = (Array.isArray(list) ? list : []).map((s) => {
      if (!s || !s.name) return s;
      const before = JSON.stringify([s.requirements, s.sources, s.thresholds, s.conflicts]);
      const n = Object.assign({}, s);
      const had = (s.requirements || []).length;
      n.requirements = (s.requirements || []).filter((id) => { if (gone(id)) { refs.add(id); return false; } return true; });
      if (s.sources) { const src = {}; for (const [k, v] of Object.entries(s.sources)) { const kept = (v || []).filter((id) => !gone(id)); if (kept.length) src[k] = kept; } if (Object.keys(src).length) n.sources = src; else delete n.sources; }
      if (s.thresholds) { const th = s.thresholds.filter((t) => !(t.requirement && gone(t.requirement))); if (th.length) n.thresholds = th; else delete n.thresholds; }
      if (s.conflicts) { const cf = s.conflicts.filter((c) => !(c.requirement && String(c.requirement).split(",").every((id) => gone(id.trim())))); if (cf.length) n.conflicts = cf; else delete n.conflicts; }
      if (JSON.stringify([n.requirements, n.sources, n.thresholds, n.conflicts]) !== before) touched.push(s.name);
      if (had && !n.requirements.length) orphans.push(s.name);
      return n;
    });
    return { signals: out, touched, orphans, refs: [...refs].sort() };
  }

  // 코드 에이전트가 제안한 신호를 표에 더한다. 이미 있는 이름(대소문자 무시)은 사람이 정한 것이므로 건드리지 않는다.
  function mergeProposed(current, proposed) {
    const list = Array.isArray(current) ? current.slice() : [];
    const have = new Set(list.filter((s) => s && s.name).map((s) => String(s.name).toLowerCase()));
    const added = [];
    const skipped = [];
    for (const s of normalize(proposed)) {
      if (have.has(s.name.toLowerCase())) { skipped.push(s.name); continue; }
      if (list.length >= MAX_SIGNALS) break;
      have.add(s.name.toLowerCase());
      list.push(s);
      added.push(s.name);
    }
    return { signals: list, added, skipped };
  }

  const contentOf = (s) => { const out = {}; for (const k of CONTENT_FIELDS) out[k] = s[k]; return out; };
  // 이름이 있고 ID 가 없는 항목에 DATA-NNN 을 붙인다(이미 있는 번호 다음부터). 바뀐 목록을 돌려준다.
  function assignIds(list) {
    const items = Array.isArray(list) ? list : [];
    let n = Math.max(0, ...items.map((s) => (s && DATA_ID_RE.test(s.data_id || "") ? Number(s.data_id.slice(5)) : 0)));
    return items.map((s) => (s && s.name && !s.data_id ? Object.assign({}, s, { data_id: `DATA-${String(++n).padStart(3, "0")}` }) : s));
  }
  const ref = (s) => `${s.name}@v${s.version}`;
  const rangeText = (s) => (s.min || s.max ? `${s.min || "…"} ~ ${s.max || "…"}` : "");

  // 에이전트에 보내는 신호 표(Baseline 에 고정된 것). selectedIds: 이번에 다루는 요구사항 ID.
  function promptSection(signals, selectedIds) {
    const list = Array.isArray(signals) ? signals : [];
    if (!list.length) return "";
    const selected = new Set(Array.from(selectedIds || [], String));
    const row = (s) => JSON.stringify(Object.assign({
      signal: ref(s), data_id: s.data_id || null, kind: kindOf(s) || null, direction: s.direction || null, type: s.type || null, unit: s.unit || null, min: s.min || null, max: s.max || null, initial: s.initial || null,
      description: s.description, requirements: s.requirements, used_by_target: s.requirements.some((id) => selected.has(id)),
    }, ...["logical_type", "allowed_values", "activation", "release", "expression", "timing", "propositions", "definition_status", "evidence"].filter((k) => s[k]).map((k) => ({ [k]: s[k] }))));
    return [
      "[신호 표 — 사람이 승인한 인터페이스. 이름·방향·자료형·단위·범위는 여기 적힌 것만 쓴다]",
      ...list.map(row),
      "- 표에 있는 신호는 이름과 자료형, 단위를 그대로 쓴다. 다른 이름으로 바꾸거나 단위를 바꾸지 않는다(코드의 식별자는 신호 이름을 그대로 쓰거나, 설계 문서의 인터페이스 절에 '신호 → 식별자' 대응을 적는다).",
      "- 요구사항을 구현·시험하는 데 필요한데 표에 없는 신호는 지어내지 않는다. questions 에 '어떤 신호가 표에 없다'고 적는다.",
      "- 범위(min·max)가 있으면 그 범위를 벗어난 값의 동작을 요구사항에서 찾고, 요구사항에 없으면 추측하지 않고 questions 에 적는다.",
    ].join("\n");
  }

  const api = Object.freeze({ pruneRequirementRefs, EXTRACT_RULES, ATTRS, ATTR_LABELS, SOURCED, NOT_SIGNAL_KINDS, KINDS, KIND_LABELS, INTERNAL_KINDS, LOGICAL_TYPES, LOGICAL_TYPE_LABELS, DEF_STATUS, DATA_ID_RE, kindOf, assignIds, detailsOf, DIRECTIONS, EXTERNAL_DIRECTIONS, DIRECTION_LABELS, TYPES, NAME_RE, CONTENT_FIELDS, MAX_SIGNALS, ASSUMABLE, ASSUMED_LABELS, mergeProposed, normalize, normalizeOne, validate, applyActions, contentOf, ref, rangeText, promptSection });
  root.EarsSignals = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
