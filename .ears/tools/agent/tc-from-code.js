/* 시험 코드에만 있는 TC 를 신호 값의 표로 옮긴다(엑셀로 내보내기 위해).
 *
 * 시험 코드는 도우미 함수·반복문·구조체 배열로 쓰여 있어 글자만으로는 값을 정확히 뽑을 수 없다.
 * 그래서 AI 에게 시험 파일 전체(도우미 함수 포함)와 신호 표를 주고, 고른 TC 마다
 * "어떤 순서로 어떤 입력을 넣고 무엇을 기대하는지"를 시간 단계(steps)로 적게 한다.
 * 결과는 신호 표의 신호·요구사항·늘어나는 시간만 받아들이고(tc-draft.js 와 같은 검사),
 * 값 출처(파일·줄·모델·시각)를 함께 남긴다. 사람이 확인하기 전의 값임을 내보낸 파일에 적는다.
 */
"use strict";

const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const tcDraft = require("./tc-draft.js");
const testcases = require("../trace/testcases.js");

const MAX_FILE_BYTES = 200 * 1024;
const MAX_IDS = 60;

class FromCodeError extends Error { constructor(message, status) { super(message); this.status = status || 400; } }

function systemPrompt() {
  return [
    "너는 시험 코드 판독자다. 아래 C 시험 코드에서 지정한 TC 마다, 시험이 실제로 넣는 입력과 확인하는 기대 출력을 신호 표의 신호 이름으로 옮긴다.",
    "",
    "## 규칙",
    "- 코드를 실행한 것처럼 정확히 따라간다: 도우미 함수, 구조체 배열, 반복문을 펼쳐 실제로 일어나는 호출을 차례대로 적는다. 짐작하지 않는다.",
    "- 입력·기대 출력에는 신호 표의 신호 이름만 쓴다(direction=input / output). 코드의 인자·필드 이름이 신호 이름과 다르면 뜻이 같은 신호로 옮긴다.",
    "- 시간: 시험이 실제 시간(ms)을 넘기면 time_unit=\"ms\" 로 그 값을 t_ms 에 쓴다. 시간 대신 호출을 차례로 하면 time_unit=\"step\" 으로 하고 t_ms 에 호출 순서 1, 2, 3 … 을 쓴다(초기화 호출도 한 단계).",
    "- 단계마다 그 호출에 넣은 입력 전체와, 그 호출 뒤에 확인하는 기대 출력을 적는다. 확인하지 않는 단계는 outputs 를 빈 객체로.",
    "- 불리언은 1(참)·0(거짓). 상태 구조체를 넘기는 것은 입력 신호로 적지 않는다(앞 단계의 결과를 이어 받는다는 뜻으로 description 에 적는다).",
    "- linkedReq 는 그 시험의 @verifies 요구사항(버전 없이). description 은 이 TC 가 무엇을 확인하는지 한국어 한두 문장.",
    "- source 에는 값을 읽은 곳(함수 이름과 줄)을 적는다. 신호로 옮길 수 없는 것이 있으면 notes 에 TC ID 와 이유를 적고, 그 TC 는 빼도 된다.",
    "",
    "## 출력",
    "설명 없이 아래 JSON 하나만 ```tc_draft 블록에 담아 낸다.",
    "```tc_draft",
    JSON.stringify({ testcases: [{ id: "TC-…", linkedReq: "REQ-…", type: "happy", method: [], time_unit: "step", description: "…", source: "check_sequence, 210~240행", steps: [{ t_ms: 1, inputs: { "입력신호": 1 }, outputs: { "출력신호": 1 } }] }], notes: [] }, null, 2),
    "```",
  ].join("\n");
}

async function fromCode({ root, input, provider, model, complete, now }) {
  const ids = [...new Set((Array.isArray(input && input.ids) ? input.ids : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (!ids.length) throw new FromCodeError("옮길 TC 를 고르세요.");
  const table = testcases.table(root);
  const found = table.testcases.filter((t) => ids.includes(t.id));
  const missing = ids.filter((id) => !found.some((t) => t.id === id));
  if (!found.length) throw new FromCodeError(`시험 코드에서 찾지 못한 TC: ${missing.join(", ")}`, 404);
  const files = [...new Set(found.map((t) => t.file))];
  const code = files.map((f) => {
    const full = path.join(root, ...f.split("/"));
    const text = fs.readFileSync(full, "utf8");
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new FromCodeError(`${f} 가 너무 큽니다(${MAX_FILE_BYTES / 1024} KB 초과).`);
    return `<<<FILE ${f}>>>\n${text.split(/\r?\n/).map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n")}\n<<<END FILE>>>`;
  }).join("\n\n");
  const norm = tcDraft.normalizeInput(Object.assign({}, input, { text: "시험 코드에서 값 읽기" }));
  const lines = ["[옮길 TC]", ...found.map((t) => `- ${t.id} (${t.file}:${t.startLine}~${t.endLine}, @verifies ${(t.verifies || []).map((v) => v.id).join(", ")})`), "", "[신호 표]",
    ...norm.signals.map((s) => `- ${s.name} | ${s.direction} | ${s.type || "?"} | unit=${s.unit || "-"} | min=${s.min || "?"} | max=${s.max || "?"} | ${s.description}`), "", "[요구사항]",
    ...norm.requirements.map((r) => `- ${r.id}: ${r.text}`), "", "[시험 코드]", code];
  const answer = await complete({ provider, model, system: systemPrompt(), messages: [{ role: "user", content: lines.join("\n") }], maxTokens: 32000 });
  const text = answer && typeof answer === "object" ? answer.text : answer;
  const parsed = tcDraft.parseDraft(text, norm);
  // 고른 TC 만, 원래 ID 그대로. 시간 단위와 출처를 붙인다.
  let raw = {};
  try { const m = /```tc_draft\s*\n([\s\S]*?)```/.exec(String(text || "")); raw = JSON.parse(m ? m[1] : text); } catch (_) { raw = {}; }
  const extra = new Map((Array.isArray(raw.testcases) ? raw.testcases : []).map((x) => [String(x && x.id), x]));
  const at = (now || new Date()).toISOString();
  const out = parsed.testcases.filter((t) => ids.includes(t.id)).map((t) => {
    const x = extra.get(t.id) || {};
    const loc = found.find((f) => f.id === t.id);
    return Object.assign(t, {
      time_unit: x.time_unit === "ms" ? "ms" : "step",
      source: "code-ai",
      from: { file: loc.file, startLine: loc.startLine, endLine: loc.endLine, where: String(x.source || "").slice(0, 200), model: model || null, at, prompt_hash: "sha256:" + createHash("sha256").update(systemPrompt(), "utf8").digest("hex") },
    });
  });
  const notRead = found.map((t) => t.id).filter((id) => !out.some((t) => t.id === id));
  return { testcases: out, notes: parsed.notes, dropped: parsed.dropped, missing, not_read: notRead };
}

module.exports = { FromCodeError, systemPrompt, fromCode };
