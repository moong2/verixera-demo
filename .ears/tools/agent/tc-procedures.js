/* 시험 코드에만 있는 TC 의 절차표(시간·호출 단계별 입력과 기대 출력)를 AI 로 읽어 저장한다.
 * 단위 검증 명세서에 C 코드 대신 사람이 읽는 절차표를 넣기 위해서다.
 *
 * - 읽기는 tc-from-code.js(시험 파일 전체·신호 표·요구사항을 주고 TC 마다 단계를 받음)를 쓴다. 한 번에 몇 개씩 나눠 부른다.
 * - 결과는 대상 프로젝트 test-spec/tc-procedures.json 에 둔다. 시험 파일 내용이 같으면 다시 읽지 않는다.
 * - AI 가 읽은 값이므로 문서에 '시험 코드에서 AI 가 읽음 — 시험 코드가 기준'으로 표시한다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const testcases = require("../trace/testcases.js");
const fromCode = require("./tc-from-code.js");

const FILE = "test-spec/tc-procedures.json";
const SCHEMA = "tc-procedures/v1";
const BATCH = 6;
const sha256 = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

function load(root) {
  const f = path.join(root, ...FILE.split("/"));
  if (!fs.existsSync(f)) return { schema: SCHEMA, items: {} };
  try { const o = JSON.parse(fs.readFileSync(f, "utf8")); return o && o.schema === SCHEMA && o.items ? o : { schema: SCHEMA, items: {} }; } catch (_) { return { schema: SCHEMA, items: {} }; }
}
function save(root, data) {
  const f = path.join(root, ...FILE.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2) + "\n");
}

// TC 마다 해시: 그 TC 가 든 시험 파일 전체(도우미 함수가 바뀌어도 다시 읽게) + ID
function hashes(root, tcs) {
  const files = new Map();
  const out = new Map();
  for (const t of tcs) {
    if (!files.has(t.file)) files.set(t.file, fs.readFileSync(path.join(root, ...t.file.split("/")), "utf8").replace(/\r\n?/g, "\n"));
    out.set(t.id, sha256(`${t.id}\n${files.get(t.file)}`));
  }
  return out;
}

// baseline: 최신 고정본(요구사항·신호). 없거나 바뀐 TC 만 읽는다.
async function ensure({ root, baseline, provider, model, complete, force, onlyIds }) {
  const data = load(root);
  const all = testcases.table(root).testcases.filter((t) => !onlyIds || onlyIds.includes(t.id));
  const hs = hashes(root, all);
  const todo = all.filter((t) => force || !data.items[t.id] || data.items[t.id].hash !== hs.get(t.id));
  const made = []; const failed = [];
  if (todo.length && !complete) return { data, made, failed: todo.map((t) => t.id) };
  const requirements = ((baseline && baseline.requirements) || []).map((r) => ({ id: r.requirement_id, type: r.ears_type, text: r.text, acceptanceCriteria: r.acceptance_criteria || [] }));
  const signals = (baseline && baseline.signals) || [];
  for (let i = 0; i < todo.length; i += BATCH) {
    const group = todo.slice(i, i + BATCH).map((t) => t.id);
    try {
      const out = await fromCode.fromCode({ root, input: { ids: group, requirements, signals }, provider, model, complete });
      for (const tc of out.testcases) {
        data.items[tc.id] = { hash: hs.get(tc.id), time_unit: tc.time_unit, description: tc.description, steps: tc.steps, from: tc.from };
        made.push(tc.id);
      }
      for (const id of group) if (!out.testcases.some((x) => x.id === id)) failed.push(id);
    } catch (e) { failed.push(...group); }
  }
  if (made.length) save(root, data);
  return { data, made, failed };
}

module.exports = { FILE, SCHEMA, load, save, ensure, hashes };
