/* 미검증 선언: 이 환경의 시험으로는 확인할 수 없는 요구사항을 사람이 사유와 함께 밝혀 두는 기록.
 *
 * 예) "정지 명령은 100 ms 안에 나와야 한다" — PC(Host)에서 함수를 부르는 시험으로는 실제 장비의 응답 시간을 잴 수 없다.
 * 이런 요구사항을 시험 없이 통과로 두거나 조용히 빼지 않고, "미검증"으로 따로 보이게 한다.
 *
 *   파일  requirements/not-verified.json   (형식 not-verified/v1)
 *   항목  { requirement_id, version, reason, decided_by, decided_at }
 *
 * - 사람이 결정한다. AI 에이전트는 이 파일을 쓸 수 없다(코드 에이전트는 docs/design·src·Makefile, 시험 에이전트는 tests/ 에만 쓴다).
 *   편집기에서도 저장할 수 없고, 앱의 요구사항 보기에서 사유와 결정한 사람을 적어야만 만들어진다.
 * - 요구사항의 버전에 묶인다. 요구사항이 바뀌면 선언은 낡은 것이 되어 다시 결정해야 한다(추적 점검이 오류로 알린다).
 * - 미검증은 통과가 아니다. 추적표의 상태가 "미검증"으로 나오고 결과 요약에 건수가 따로 나온다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "not-verified/v1";
const REL = "requirements/not-verified.json";
const fileOf = (root) => path.join(root, ...REL.split("/"));

class NotVerifiedError extends Error {
  constructor(message, status) { super(message); this.status = status || 400; }
}

// 파일을 읽는다. 없으면 빈 목록. 깨졌으면 problem 에 사유를 담는다(추적 점검이 오류로 알린다).
function load(root) {
  const file = fileOf(root);
  if (!fs.existsSync(file)) return { items: [], problem: null };
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { items: [], problem: `${REL} 를 읽을 수 없음 (${e.message})` }; }
  if (!data || data.schema !== SCHEMA || !Array.isArray(data.items)) return { items: [], problem: `${REL} 의 형식이 ${SCHEMA} 가 아님` };
  return { items: data.items.filter((x) => x && typeof x === "object"), problem: null };
}

function save(root, items) {
  const file = fileOf(root);
  const sorted = [...items].sort((a, b) => (a.requirement_id < b.requirement_id ? -1 : a.requirement_id > b.requirement_id ? 1 : 0));
  if (!sorted.length) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: SCHEMA, items: sorted }, null, 2) + "\n");
}

const clean = (v) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim();

// 미검증 선언을 더하거나 바꾼다. baseline 은 지금의 승인 Baseline(요구사항 목록과 버전의 기준).
function declare(root, baseline, input, now) {
  const id = clean(input && input.requirement_id);
  const reason = clean(input && input.reason);
  const by = clean(input && input.decided_by);
  const req = (baseline.requirements || []).find((r) => r.requirement_id === id);
  if (!req) throw new NotVerifiedError(`${id || "(ID 없음)"}: 승인된 고정본 ${baseline.baseline_id} 에 없는 요구사항입니다.`, 404);
  if ((baseline.requirements || []).some((r) => r.parent === id)) throw new NotVerifiedError(`${id} 는 하위 요구사항으로 나뉜 요구사항입니다. 확인할 수 없는 하위 요구사항에 표시하세요.`);
  if (reason.length < 10 || reason.length > 300) throw new NotVerifiedError("사유는 10~300자로 적습니다. 왜 이 환경의 시험으로 확인할 수 없는지, 어디서 확인할 것인지를 적으세요.");
  if (!by || by.length > 60) throw new NotVerifiedError("결정한 사람의 이름을 적습니다(1~60자).");
  const item = { requirement_id: id, version: req.version, reason, decided_by: by, decided_at: (now || new Date()).toISOString() };
  const { items } = load(root);
  save(root, items.filter((x) => x.requirement_id !== id).concat([item]));
  return item;
}

function remove(root, requirementId) {
  const id = clean(requirementId);
  const { items } = load(root);
  if (!items.some((x) => x.requirement_id === id)) throw new NotVerifiedError(`${id}: 미검증으로 표시되어 있지 않습니다.`, 404);
  save(root, items.filter((x) => x.requirement_id !== id));
  return { requirement_id: id, removed: true };
}

module.exports = { SCHEMA, REL, load, declare, remove, NotVerifiedError };
