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
  // 자주 쓰는 자료형(화면의 선택 목록). 다른 이름(프로젝트의 typedef 등)도 받는다.
  const TYPES = ["bool", "uint8", "int8", "uint16", "int16", "uint32", "int32", "float32", "float64", "enum"];
  const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
  const TYPE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
  const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
  const MAX_SIGNALS = 300;
  // 신호의 버전을 결정하는 필드. 이 가운데 하나라도 바뀌면 버전이 오른다.
  const CONTENT_FIELDS = ["name", "direction", "type", "unit", "min", "max", "initial", "description", "requirements"];

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
    });
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
    for (const s of signals) {
      if (!NAME_RE.test(s.name)) add("error", s, "name", "이름은 영문자로 시작하고 영문자·숫자·밑줄만 씁니다(코드의 이름으로 쓰기 위해)");
      const key = s.name.toLowerCase();
      if (seen.has(key)) add("error", s, "name", seen.get(key) === s.name ? "같은 이름의 신호가 두 번 있습니다" : `대소문자만 다른 이름이 있습니다 (${seen.get(key)})`);
      else seen.set(key, s.name);
      if (!s.direction) add("error", s, "direction", "방향(입력·출력·내부)을 정해야 합니다");
      if (!s.type) add("error", s, "type", "자료형을 정해야 합니다");
      else if (!TYPE_RE.test(s.type)) add("error", s, "type", `자료형 이름이 올바르지 않습니다: ${s.type}`);
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
  function applyActions(current, actions) {
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
      for (const k of ["direction", "type", "unit", "min", "max", "initial", "description", "requirements", "assumed"]) if (a[k] !== undefined) merged[k] = a[k];
      if (a.desc !== undefined && a.description === undefined) merged.description = a.desc;
      if (a.rename) merged.name = a.rename;
      const next = normalizeOne(merged);
      if (!next) continue;
      if (i >= 0) list[i] = next; else if (list.length < MAX_SIGNALS) list.push(next); else continue;
      applied += 1;
    }
    return { signals: list, applied };
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
  const ref = (s) => `${s.name}@v${s.version}`;
  const rangeText = (s) => (s.min || s.max ? `${s.min || "…"} ~ ${s.max || "…"}` : "");

  // 에이전트에 보내는 신호 표(Baseline 에 고정된 것). selectedIds: 이번에 다루는 요구사항 ID.
  function promptSection(signals, selectedIds) {
    const list = Array.isArray(signals) ? signals : [];
    if (!list.length) return "";
    const selected = new Set(Array.from(selectedIds || [], String));
    const row = (s) => JSON.stringify({
      signal: ref(s), direction: s.direction, type: s.type, unit: s.unit || null, min: s.min || null, max: s.max || null, initial: s.initial || null,
      description: s.description, requirements: s.requirements, used_by_target: s.requirements.some((id) => selected.has(id)),
    });
    return [
      "[신호 표 — 사람이 승인한 인터페이스. 이름·방향·자료형·단위·범위는 여기 적힌 것만 쓴다]",
      ...list.map(row),
      "- 표에 있는 신호는 이름과 자료형, 단위를 그대로 쓴다. 다른 이름으로 바꾸거나 단위를 바꾸지 않는다(코드의 식별자는 신호 이름을 그대로 쓰거나, 설계 문서의 인터페이스 절에 '신호 → 식별자' 대응을 적는다).",
      "- 요구사항을 구현·시험하는 데 필요한데 표에 없는 신호는 지어내지 않는다. questions 에 '어떤 신호가 표에 없다'고 적는다.",
      "- 범위(min·max)가 있으면 그 범위를 벗어난 값의 동작을 요구사항에서 찾고, 요구사항에 없으면 추측하지 않고 questions 에 적는다.",
    ].join("\n");
  }

  const api = Object.freeze({ DIRECTIONS, DIRECTION_LABELS, TYPES, NAME_RE, CONTENT_FIELDS, MAX_SIGNALS, ASSUMABLE, ASSUMED_LABELS, mergeProposed, normalize, normalizeOne, validate, applyActions, contentOf, ref, rangeText, promptSection });
  root.EarsSignals = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
