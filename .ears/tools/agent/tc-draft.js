/* TC 입력 표의 AI 초안: 사용자가 쓴 한 문장(예: "스위치가 3초 이상 OFF 이면 로우빔 비활성화 확인")을
 * 신호 표의 신호와 시간 단계로 된 테스트케이스로 바꾼다.
 *
 * 결과는 표에 채워질 초안일 뿐이다. 저장은 사람이 표를 확인하고 '저장'을 누를 때 하며, 그때 누가 저장했는지 남는다.
 * 신호 표에 없는 신호, 없는 요구사항, 늘어나지 않는 시간은 받아들이지 않고 그 사실을 알린다.
 */
"use strict";

const { createHash } = require("node:crypto");

const ID_RE = /^TC-[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const TYPES = ["happy", "boundary", "negative", "no-trigger", "state-entry", "state-exit", "state-hold", "feature-on", "feature-off"];
const METHODS = ["requirement", "equivalence", "boundary", "error-guessing", "interface", "fault-injection"];
const MAX_TEXT = 1000;

class DraftError extends Error { constructor(message, status) { super(message); this.status = status || 400; } }

const str = (v, max) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : []);
const sha256 = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

function normalizeInput(input) {
  const text = str(input && input.text, MAX_TEXT + 1);
  if (!text) throw new DraftError("어떤 시험을 만들지 적으세요.");
  if (text.length > MAX_TEXT) throw new DraftError(`${MAX_TEXT}자까지 적을 수 있습니다.`);
  const requirements = list(input.requirements).slice(0, 200).map((r) => ({
    id: str(r.id, 80), type: str(r.type, 40), parent: str(r.parent, 80) || null, text: str(r.text, 2000),
    acceptance_criteria: list(r.acceptanceCriteria || r.acceptance_criteria).map((x) => str(x, 500)).filter(Boolean).slice(0, 30),
  })).filter((r) => r.id && r.text);
  if (!requirements.length) throw new DraftError("요구사항이 없습니다.");
  const signals = list(input.signals).slice(0, 200).map((s) => ({
    name: str(s.name, 80), direction: str(s.direction, 20), type: str(s.type, 40), unit: str(s.unit, 20),
    min: s.min == null ? "" : str(s.min, 40), max: s.max == null ? "" : str(s.max, 40), initial: s.initial == null ? "" : str(s.initial, 40), description: str(s.description, 300),
  })).filter((s) => s.name && (s.direction === "input" || s.direction === "output"));
  if (!signals.some((s) => s.direction === "output")) throw new DraftError("신호 표에 출력 신호가 없어 기대 출력을 정할 수 없습니다.");
  const focus = str(input.focus, 80);
  return { text, requirements, signals, focus: requirements.some((r) => r.id === focus) ? focus : "" };
}

function systemPrompt() {
  return [
    "너는 시험 설계 도우미다. 사용자가 한 문장으로 말한 시험을, 아래 신호 표의 신호와 시간 단계로 된 테스트케이스로 바꾼다.",
    "",
    "## 규칙",
    "- 입력·기대 출력에는 신호 표의 신호 이름만 쓴다. 입력은 direction=input, 기대 출력은 direction=output 신호다.",
    "- 시간은 시험 시작(0 ms)부터의 경과 시간 t_ms(정수, 늘어나는 순서)다. 첫 단계는 0 ms 다.",
    "- 각 단계의 inputs 에는 그 시간에 바뀌는 입력만 적는다(안 적은 입력은 앞 단계 값 그대로, 첫 단계에서 안 적은 입력은 0). 첫 단계에는 시험의 시작 조건이 되는 입력을 모두 적는다.",
    "- 각 단계의 outputs 에는 그 시간에 확인할 기대 출력만 적는다. 확인하지 않는 시간에는 outputs 를 빈 객체로 둔다.",
    "- \"N초 이상\", \"N ms 이내\" 같은 시간 조건은 경계를 확인한다: 조건 직전(예: 2999 ms)에는 아직 바뀌지 않음, 조건 시점(예: 3000 ms)에는 바뀜. 두 단계를 하나의 TC 에 넣거나, 사용자가 원하면 TC 를 나눈다.",
    "- 값은 사용자의 문장, 요구사항 문장·수용 기준, 신호 표의 범위에서만 정한다. 정할 수 없는 값(예: 전압 기준)은 지어내지 말고 정상 범위의 무난한 값을 쓰되 notes 에 '확인 필요'로 적는다.",
    "- 불리언 신호는 1(참)·0(거짓)으로 적는다.",
    "- linkedReq 는 이 시험이 검증하는 요구사항 ID 하나다(아래 목록에 있는 것만). 맞는 요구사항이 없으면 notes 에 그렇게 적고 가장 가까운 것을 쓴다.",
    "- id 는 TC- 로 시작한다(예: TC-LMP-01-1-M01). 이미 있는 ID 는 피한다.",
    "- description 과 notes 는 한국어로 쓴다.",
    "",
    "## 출력",
    "설명 없이 아래 JSON 하나만 ```tc_draft 블록에 담아 낸다.",
    "```tc_draft",
    JSON.stringify({
      testcases: [{ id: "TC-…-M01", linkedReq: "REQ-…", type: "happy", method: ["requirement"], description: "무엇을 확인하는지", steps: [{ t_ms: 0, inputs: { "입력신호": 1 }, outputs: { "출력신호": 1 } }, { t_ms: 100, inputs: { "입력신호": 0 }, outputs: {} }] }],
      notes: ["확인이 필요한 점"],
    }, null, 2),
    "```",
    `type 은 ${TYPES.join(", ")} 가운데 하나, method 는 ${METHODS.join(", ")} 가운데에서 고른다.`,
  ].join("\n");
}

function userPrompt(input, existingIds) {
  const lines = ["[만들 시험]", input.text, "", "[요구사항]"];
  for (const r of input.requirements) {
    lines.push(`- ${r.id} | type=${r.type || "?"} | parent=${r.parent || "(최상위)"}`, `    text: ${r.text}`);
    for (const a of r.acceptance_criteria) lines.push(`    acceptance: ${a}`);
  }
  lines.push("", "[신호 표]");
  for (const s of input.signals) lines.push(`- ${s.name} | ${s.direction} | ${s.type || "?"} | unit=${s.unit || "-"} | min=${s.min || "?"} | max=${s.max || "?"} | initial=${s.initial || "?"} | ${s.description}`);
  if (input.focus) lines.push("", `[지금 보고 있는 요구사항] ${input.focus}`);
  if (existingIds.length) lines.push("", `[이미 있는 TC ID] ${existingIds.slice(0, 300).join(", ")}`);
  return lines.join("\n");
}

const val = (v) => (typeof v === "number" || typeof v === "boolean" ? v : str(v, 200));

function parseDraft(text, input) {
  const m = /```tc_draft\s*\n([\s\S]*?)```/.exec(String(text || "")) || /```json\s*\n([\s\S]*?)```/.exec(String(text || ""));
  let raw;
  try { raw = JSON.parse(m ? m[1] : String(text || "").trim()); } catch (_) { throw new DraftError("AI 초안을 해석하지 못했습니다. 다시 시도하세요.", 502); }
  const reqIds = new Set(input.requirements.map((r) => r.id));
  const ins = new Set(input.signals.filter((s) => s.direction === "input").map((s) => s.name));
  const outs = new Set(input.signals.filter((s) => s.direction === "output").map((s) => s.name));
  const dropped = [];
  const testcases = [];
  for (const tc of list(raw && raw.testcases).slice(0, 20)) {
    const id = str(tc && tc.id, 60);
    const linkedReq = str(tc && tc.linkedReq, 80);
    if (!reqIds.has(linkedReq)) { dropped.push(`${id || "(ID 없음)"}: 없는 요구사항 ${linkedReq || "(없음)"}`); continue; }
    const steps = [];
    let last = -1;
    let bad = "";
    for (const s of list(tc.steps).slice(0, 100)) {
      const t = Number(s && s.t_ms);
      if (!Number.isInteger(t) || t < 0 || t <= last) { bad = "시간이 늘어나는 정수가 아님"; break; }
      last = t;
      const step = { t_ms: t, inputs: {}, outputs: {} };
      for (const [k, v] of Object.entries((s && s.inputs) || {})) { if (ins.has(k)) step.inputs[k] = val(v); else dropped.push(`${id}: 신호 표에 없는 입력 ${k}`); }
      for (const [k, v] of Object.entries((s && s.outputs) || {})) { if (outs.has(k)) step.outputs[k] = val(v); else dropped.push(`${id}: 신호 표에 없는 출력 ${k}`); }
      steps.push(step);
    }
    if (bad || !steps.length) { dropped.push(`${id || "(ID 없음)"}: ${bad || "단계 없음"}`); continue; }
    if (!steps.some((s) => Object.keys(s.outputs).length)) { dropped.push(`${id}: 확인할 기대 출력이 없음`); continue; }
    testcases.push({
      id: ID_RE.test(id) ? id : "", linkedReq,
      type: TYPES.includes(tc.type) ? tc.type : "happy",
      method: list(tc.method).map((x) => str(x, 30)).filter((x) => METHODS.includes(x)).slice(0, 1),
      description: str(tc.description, 500), steps,
    });
  }
  if (!testcases.length) throw new DraftError(`AI 가 쓸 수 있는 TC 를 만들지 못했습니다${dropped.length ? `: ${dropped.slice(0, 3).join(" / ")}` : ""}. 문장을 더 구체적으로 적어 보세요.`, 422);
  return { testcases, notes: list(raw && raw.notes).map((x) => str(x, 300)).filter(Boolean).slice(0, 10), dropped };
}

async function draft({ input, existingIds, provider, model, complete }) {
  const norm = normalizeInput(input);
  const ids = list(existingIds).map((x) => str(x, 60)).filter(Boolean);
  const system = systemPrompt();
  const user = userPrompt(norm, ids);
  const answer = await complete({ provider, model, system, messages: [{ role: "user", content: user }], maxTokens: 32000 });
  const text = answer && typeof answer === "object" ? answer.text : answer;
  const out = parseDraft(text, norm);
  return Object.assign(out, { model: model || null, prompt_hash: sha256(system + "\n\n" + user) });
}

module.exports = { DraftError, normalizeInput, systemPrompt, userPrompt, parseDraft, draft };
