/* 설계 추천값 저장(design/recommendations.json): AI 추천(ai)과 사람의 결정(decisions)만 저장하고, 목록은 그때그때 만든다
 * (고정본·설계가 바뀌면 명세값·계산값이 자동으로 따라간다). 설계 승인(DBL) 때 그 시점의 목록을 승인본 옆에 남긴다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const R = require("../../webapp/design-recs.js");

const FILE = "design/recommendations.json";
const full = (root, rel) => path.join(root, ...rel.split("/"));

function load(root) {
  try { const o = JSON.parse(fs.readFileSync(full(root, FILE), "utf8")); if (o && o.schema === R.SCHEMA) return { ai: R.normalizeAi(o.ai), decisions: o.decisions && typeof o.decisions === "object" ? o.decisions : {}, generation_id: o.generation_id || null, updated_at: o.updated_at || null }; }
  catch (_) { /* 없음·깨짐 — 빈 것으로 */ }
  return { ai: [], decisions: {}, generation_id: null, updated_at: null };
}
function save(root, st, now) {
  const f = full(root, FILE);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const o = { schema: R.SCHEMA, generation_id: st.generation_id || null, ai: R.normalizeAi(st.ai), decisions: st.decisions || {}, updated_at: (now || new Date()).toISOString() };
  fs.writeFileSync(f, JSON.stringify(o, null, 1) + "\n");
  return o;
}
// 지금 목록: 고정본 데이터 사전 + 저장한 AI 추천 + 설계 초안 신호 + 결정
function view(root, baseline, design) {
  const st = load(root);
  const items = R.build({ signals: (baseline && baseline.signals) || [], ai: st.ai, designSignals: (design && design.signals) || [], decisions: st.decisions });
  return { items, summary: R.summary(items), generation_id: st.generation_id, updated_at: st.updated_at };
}
// 새 설계 생성의 AI 추천으로 바꾼다(사람의 결정은 이어받는다 — 같은 값이면 그대로, 고친 것·미반영은 늘)
function replaceAi(root, ai, generationId, now) {
  const st = load(root);
  return save(root, Object.assign(st, { ai, generation_id: generationId || st.generation_id }), now);
}
function decide(root, baseline, design, decisionsIn, by, now) {
  const st = load(root);
  const items = R.build({ signals: (baseline && baseline.signals) || [], ai: st.ai, designSignals: (design && design.signals) || [], decisions: st.decisions });
  let dec = st.decisions;
  const at = (now || new Date()).toISOString();
  for (const d of Array.isArray(decisionsIn) ? decisionsIn.slice(0, 300) : []) dec = R.decide(items, dec, d && d.key, Object.assign({}, d, { by, at }));
  save(root, Object.assign(st, { decisions: dec }), now);
  return view(root, baseline, design);
}
function confirmedValues(items) {
  return items.filter((item) => item.status === "confirmed" && ["accepted", "edited"].includes(item.decision?.state))
    .map(({ target, attr, value_final, unit }) => ({ target, attr, value: value_final, unit: unit || "" }))
    .sort((a, b) => a.target.localeCompare(b.target, "en") || a.attr.localeCompare(b.attr, "en"));
}

// 코드 생성과 T16이 같은 승인 신호 계약을 본다. 작업본을 읽지 않으며 정해진 신호 속성만 반영한다.
function approvedContract(dbl, blSignals) {
  const signals = blSignals || [];
  const dictionary = require("../../webapp/design-model.js").dictionary(dbl.design, signals);
  const confirmed = [];
  if (!dbl.confirmed_recommendations?.length) return { dictionary, confirmed };
  const fixed = new Map(R.build({ signals }).filter((item) => item.status === "spec" || item.status === "computed")
    .map((item) => [item.key, item.value]));
  const attributes = new Set([...R.ATTRS.map(([attr]) => attr), "transfer"]);
  for (const r of dbl.confirmed_recommendations) {
    const match = /^(signal|interface):(.+)$/.exec(r.target);
    const entry = match && dictionary.get(match[2]);
    if (entry && attributes.has(r.attr)) {
      const key = R.keyOf(`signal:${match[2]}`, r.attr);
      if (fixed.has(key)) {
        entry[r.attr] = fixed.get(key);
        continue;
      }
      entry[r.attr] = r.value;
    }
    confirmed.push(r);
  }
  return { dictionary, confirmed };
}

// 예전 부속 파일은 DBL 해시 적용 전의 기록이다. 값의 유무만 확인하며 코드 생성 입력에는 쓰지 않는다.
function legacyApprovalWarning(root, dbl) {
  if (Array.isArray(dbl.confirmed_recommendations)) return null;
  const id = dbl.design_baseline_id;
  if (!/^DBL-\d{3,}$/.test(id || "")) return null;
  const file = full(root, `design/recommendations/${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.schema === R.SCHEMA && saved.design_baseline_id === id && Array.isArray(saved.items)
        && !saved.items.some((item) => item?.status === "confirmed")) return null;
  } catch (_) { /* 손상된 부속 파일도 다시 승인하면 현재 확인한 값으로 복구할 수 있다. */ }
  return `${id}의 별도 추천값 기록은 승인 해시로 확인할 수 없어 코드 생성에서 제외합니다. 설계 검토에서 현재 확정값을 확인한 뒤 상세설계를 다시 승인하세요.`;
}

// 설계 승인 때 그 시점의 전체 검토 목록도 보관한다.
function snapshot(root, dblFile, baseline, design, dblId, v = view(root, baseline, design)) {
  const f = full(root, `design/recommendations/${dblId}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schema: R.SCHEMA, design_baseline_id: dblId, items: v.items, summary: v.summary }, null, 1) + "\n");
  return path.relative(root, f).split(path.sep).join("/");
}

module.exports = { FILE, load, save, view, replaceAi, decide, snapshot, confirmedValues, approvedContract, legacyApprovalWarning };
