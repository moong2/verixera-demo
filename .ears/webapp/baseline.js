/* Approved requirements baseline: content hashing, versioning and verification. */
(() => {
  "use strict";

  const root = typeof window !== "undefined" ? window : globalThis;
  // 신호 표(webapp/signals.js). 브라우저에서는 먼저 불러온 전역을, Node 에서는 모듈을 쓴다.
  const signalsApi = root.EarsSignals || (typeof module !== "undefined" && module.exports && typeof require === "function" ? require("./signals.js") : null);

  const SCHEMA = "ears-baseline/v1";
  const HASH_PREFIX = "sha256:";
  // 요구사항의 버전을 결정하는 필드. 요약·출처·LTL은 설명 또는 파생 정보라 제외한다.
  const CONTENT_FIELDS = ["requirement_id", "ears_type", "text", "parent", "acceptance_criteria"];
  const PLACEHOLDER_RE = /\[[^\]\n]*필요[^\]\n]*\]/;
  const HASH_SCOPE =
    "content_hash = sha256(정규화 JSON{" + CONTENT_FIELDS.join(", ") + "}); " +
    "baseline_hash = sha256(정규화 JSON{schema, baseline_id, requirements[{requirement_id, version, content_hash}]})";

  // 신호 표가 있는 Baseline 에만 덧붙는 설명. 신호가 없으면 baseline_hash 는 예전 계산과 같다.
  const HASH_SCOPE_SIGNALS =
    "; 신호 표가 있으면 signals[{name, version, content_hash}] 도 baseline_hash 에 넣는다 — 신호의 content_hash = sha256(정규화 JSON{" +
    (signalsApi ? signalsApi.CONTENT_FIELDS.join(", ") : "") + "})";

  // 새로 고정할 때의 한도(이미 만든 고정본을 검증할 때는 적용하지 않는다).
  const MAX_ID_LENGTH = 80;
  const MAX_TEXT_LENGTH = 5000;
  const MAX_APPROVER_LENGTH = 80;
  function baselineError(code, message, extra) {
    return Object.assign(new Error(message), { code }, extra || {});
  }

  function normalizeText(value) {
    return String(value == null ? "" : value).normalize("NFC").replace(/\r\n?/g, "\n").trim();
  }

  // 키 순서와 공백에 영향받지 않는 직렬화. 같은 내용이면 항상 같은 문자열이 된다.
  function canonicalize(value) {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
  }

  async function sha256Hex(text) {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) {
      throw baselineError("NO_CRYPTO", "이 환경에서는 SHA-256을 계산할 수 없습니다. http://127.0.0.1 주소로 접속했는지 확인하세요.");
    }
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function compareIds(a, b) {
    const model = root.EarsRequirements;
    if (model && typeof model.idCompare === "function") return model.idCompare(a, b);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function effectiveParent(req, idSet) {
    const model = root.EarsRequirements;
    if (model && typeof model.resolveParent === "function") return model.resolveParent(req, idSet).parent;
    return req.parent && idSet.has(req.parent) ? req.parent : null;
  }

  function contentOf(item) {
    const out = {};
    for (const key of CONTENT_FIELDS) out[key] = item[key];
    return out;
  }

  async function contentHash(item) {
    return HASH_PREFIX + (await sha256Hex(canonicalize(contentOf(item))));
  }

  async function baselineHash(baselineId, items, signals) {
    const index = items.map((r) => ({ requirement_id: r.requirement_id, version: r.version, content_hash: r.content_hash }));
    // 신호가 없으면 signals 키 자체를 넣지 않는다(정규화가 undefined 를 뺀다). 그래서 신호 표가 없던 예전 Baseline 의 해시가 그대로다.
    const signalIndex = Array.isArray(signals) && signals.length ? signals.map((s) => ({ name: s.name, version: s.version, content_hash: s.content_hash })) : undefined;
    return HASH_PREFIX + (await sha256Hex(canonicalize({ schema: SCHEMA, baseline_id: baselineId, requirements: index, signals: signalIndex })));
  }

  async function signalHash(signal) {
    return HASH_PREFIX + (await sha256Hex(canonicalize(signalsApi.contentOf(signal))));
  }

  // 가장 최근에 그 이름의 신호가 들어 있던 Baseline 의 기록. 빠졌다가 돌아온 신호도 버전을 이어 간다.
  function lastKnownSignal(records, name) {
    for (let i = records.length - 1; i >= 0; i--) {
      const sigs = records[i] && records[i].signals;
      if (sigs && Object.prototype.hasOwnProperty.call(sigs, name)) return sigs[name];
    }
    return null;
  }

  // 가장 최근에 그 ID가 포함됐던 Baseline의 기록. 한 번 빠졌다가 돌아온 요구사항도 버전을 이어 간다.
  function lastKnown(records, id) {
    for (let i = records.length - 1; i >= 0; i--) {
      const reqs = records[i] && records[i].requirements;
      if (reqs && Object.prototype.hasOwnProperty.call(reqs, id)) return reqs[id];
    }
    return null;
  }

  function nextBaselineId(records) {
    let max = 0;
    for (const rec of records) {
      const m = /^BL-(\d+)$/.exec((rec && rec.baseline_id) || "");
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return "BL-" + String(max + 1).padStart(3, "0");
  }

  // 확정 요구사항으로 다음 Baseline의 내용을 계산한다. 저장하거나 번호를 소비하지 않는다.
  async function planBaseline(input) {
    const all = Array.isArray(input && input.requirements) ? input.requirements : [];
    const records = Array.isArray(input && input.records) ? input.records.filter(Boolean) : [];
    const confirmed = all.filter((r) => r && r.status === "confirmed");
    const draftCount = all.length - confirmed.length;

    const seen = new Set();
    for (const r of confirmed) {
      const id = String(r.id || "");
      if (!id || id.includes("?")) throw baselineError("BAD_ID", `요구사항 ID가 정해지지 않은 항목이 있습니다: "${id}"`);
      // 설계·코드·시험의 추적 태그(@req ID@v1)가 가리킬 수 없는 ID 는 고정하지 않는다.
      if (/[\s,@<>"'&\u0000-\u001f]/.test(id) || id.length > MAX_ID_LENGTH) throw baselineError("BAD_ID", `요구사항 ID 로 쓸 수 없는 모양입니다: "${id.slice(0, 60)}" — 빈칸 , @ < > " ' & 는 쓸 수 없고 ${MAX_ID_LENGTH}자를 넘을 수 없습니다(추적 태그가 가리킬 수 없습니다).`);
      if (seen.has(id)) throw baselineError("DUPLICATE_ID", `요구사항 ID가 중복됩니다: ${id}`);
      seen.add(id);
      const body = normalizeText(r.text);
      if (!body) throw baselineError("EMPTY_TEXT", `${id}: 요구사항 문장이 비어 있습니다. 문장을 채우거나 초안(draft)으로 돌린 뒤 고정하세요.`);
      if (body.length > MAX_TEXT_LENGTH) throw baselineError("TEXT_TOO_LONG", `${id}: 요구사항 문장이 너무 깁니다(${body.length.toLocaleString()}자, 최대 ${MAX_TEXT_LENGTH.toLocaleString()}자). 여러 요구사항으로 나누세요.`);
    }

    const allIds = new Set(all.map((r) => String(r.id)));
    const items = [];
    for (const r of confirmed) {
      const item = {
        requirement_id: String(r.id),
        version: 0,
        status: "confirmed",
        ears_type: String(r.type || ""),
        text: normalizeText(r.text),
        summary: normalizeText(r.summary),
        parent: effectiveParent(r, allIds),
        source: normalizeText(r.source),
        acceptance_criteria: (Array.isArray(r.acceptanceCriteria) ? r.acceptanceCriteria : []).map(normalizeText).filter(Boolean),
        ltl: normalizeText(r.ltl),
        ltl_text: normalizeText(r.ltlText),
        content_hash: "",
      };
      item.content_hash = await contentHash(item);
      items.push(item);
    }
    items.sort((a, b) => compareIds(a.requirement_id, b.requirement_id));
    // 상위 관계가 돌고 돌면(자기 자신 포함) 고정하지 않는다: 트리·추적표가 그 관계를 따라가다 끝나지 않는다.
    const parentOf = new Map(items.map((it) => [it.requirement_id, it.parent || null]));
    for (const it of items) {
      const path = [it.requirement_id];
      let cur = it.parent || null;
      while (cur && parentOf.has(cur) && path.length <= items.length) {
        if (cur === it.requirement_id) throw baselineError("BAD_PARENT", `${it.requirement_id}: 상위 요구사항이 돌고 돕니다(${path.concat(cur).join(" → ")}). 상위 관계를 고친 뒤 고정하세요.`);
        path.push(cur);
        cur = parentOf.get(cur);
      }
    }

    const changes = { added: [], modified: [], unchanged: [], removed: [] };
    for (const item of items) {
      const prior = lastKnown(records, item.requirement_id);
      if (!prior) { item.version = 1; changes.added.push(item.requirement_id); }
      else if (prior.content_hash === item.content_hash) { item.version = prior.version; changes.unchanged.push(item.requirement_id); }
      else { item.version = prior.version + 1; changes.modified.push(item.requirement_id); }
    }
    const previous = records.length ? records[records.length - 1] : null;
    if (previous && previous.requirements) {
      changes.removed = Object.keys(previous.requirements).filter((id) => !seen.has(id)).sort(compareIds);
      // 직전 Baseline에는 없었지만 그 이전에 있던 요구사항이 같은 내용으로 돌아온 경우도 변경이다.
      const back = changes.unchanged.filter((id) => !Object.prototype.hasOwnProperty.call(previous.requirements, id));
      changes.unchanged = changes.unchanged.filter((id) => !back.includes(id));
      changes.added.push(...back);
      changes.added.sort(compareIds);
    }

    // 신호 표: 확정 요구사항에 연결된 것만 연결로 남긴다(초안 요구사항은 Baseline 에 없으므로).
    const signalInput = signalsApi ? signalsApi.normalize(input && input.signals) : [];
    const signalProblems = signalsApi ? signalsApi.validate(signalInput, allIds) : [];
    const signals = [];
    const signalChanges = { added: [], modified: [], unchanged: [], removed: [] };
    const outsideBaseline = [];
    for (const s of signalInput) {
      const item = Object.assign(signalsApi.contentOf(s), { requirements: s.requirements.filter((id) => seen.has(id)), version: 0, content_hash: "" });
      if (item.requirements.length !== s.requirements.length) outsideBaseline.push(s.name);
      item.content_hash = await signalHash(item);
      const prior = lastKnownSignal(records, item.name);
      if (!prior) { item.version = 1; signalChanges.added.push(item.name); }
      else if (prior.content_hash === item.content_hash) { item.version = prior.version; signalChanges.unchanged.push(item.name); }
      else { item.version = prior.version + 1; signalChanges.modified.push(item.name); }
      signals.push(item);
    }
    signals.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const k of Object.keys(signalChanges)) signalChanges[k].sort();
    const previousRecord = records.length ? records[records.length - 1] : null;
    if (previousRecord && previousRecord.signals) {
      const names = new Set(signals.map((s) => s.name));
      signalChanges.removed = Object.keys(previousRecord.signals).filter((n) => !names.has(n)).sort();
      const back = signalChanges.unchanged.filter((n) => !Object.prototype.hasOwnProperty.call(previousRecord.signals, n));
      signalChanges.unchanged = signalChanges.unchanged.filter((n) => !back.includes(n));
      signalChanges.added = signalChanges.added.concat(back).sort();
    } else if (previousRecord) {
      // 직전 Baseline 에 신호 표가 없었다: 예전에 있던 신호가 돌아온 것도 추가다.
      signalChanges.added = signalChanges.added.concat(signalChanges.unchanged).sort();
      signalChanges.unchanged = [];
    }
    const signalsChanged = signalChanges.added.length + signalChanges.modified.length + signalChanges.removed.length > 0;

    const openItems = {
      missing_acceptance_criteria: items.filter((r) => r.acceptance_criteria.length === 0).map((r) => r.requirement_id),
      parent_not_in_baseline: items.filter((r) => r.parent && !seen.has(r.parent)).map((r) => r.requirement_id),
      // "[수치 필요]"처럼 값이 정해지지 않은 자리표시자가 남은 채 확정된 요구사항
      unresolved_placeholder: items.filter((r) => PLACEHOLDER_RE.test(r.text)).map((r) => r.requirement_id),
    };
    if (signals.length) {
      // 어느 확정 요구사항에도 연결되지 않은 신호, 초안 요구사항에만 연결되어 그 연결이 빠진 신호
      openItems.signals_without_requirement = signals.filter((s) => s.requirements.length === 0).map((s) => s.name);
      openItems.signal_links_outside_baseline = outsideBaseline.sort();
    }
    const noChange = !!previous && items.length > 0 && !signalsChanged &&
      changes.added.length === 0 && changes.modified.length === 0 && changes.removed.length === 0;

    return {
      baselineId: nextBaselineId(records),
      items, changes, openItems, noChange, draftCount,
      signals, signalChanges, signalsChanged, signalProblems,
      previous: previous ? { baseline_id: previous.baseline_id, baseline_hash: previous.baseline_hash } : null,
    };
  }

  // 승인 정보를 붙여 Baseline 파일 내용과 프로젝트에 남길 기록을 만든다.
  async function buildBaseline(input) {
    const plan = await planBaseline(input);
    if (plan.items.length === 0) throw baselineError("NO_CONFIRMED", "확정(confirmed)된 요구사항이 없어 고정본을 만들 수 없습니다.");
    // 변경이 없으면 새로 승인할 것이 없으므로 승인자 확인보다 먼저 판정한다.
    if (plan.noChange) {
      throw baselineError("NO_CHANGE", `직전 Baseline(${plan.previous.baseline_id}) 이후 확정 요구사항에 변경이 없습니다.`, { previous: plan.previous });
    }
    const signalErrors = plan.signalProblems.filter((x) => x.level === "error");
    if (signalErrors.length) {
      throw baselineError("BAD_SIGNALS", `신호 표에 고쳐야 할 것이 있습니다: ${signalErrors.slice(0, 3).map((x) => x.message).join(" / ")}${signalErrors.length > 3 ? ` 외 ${signalErrors.length - 3}건` : ""}`, { problems: signalErrors });
    }
    const approver = normalizeText(input && input.approver);
    if (!approver) throw baselineError("NO_APPROVER", "승인자를 입력해야 고정본을 만들 수 있습니다.");
    if (approver.length > MAX_APPROVER_LENGTH) throw baselineError("BAD_APPROVER", `승인자 이름이 너무 깁니다(${MAX_APPROVER_LENGTH}자 이하).`);
    const now = input.now instanceof Date ? input.now : new Date();
    const hash = await baselineHash(plan.baselineId, plan.items, plan.signals);
    const baseline = {
      schema: SCHEMA,
      baseline_id: plan.baselineId,
      project: normalizeText(input.projectName),
      created_at: now.toISOString(),
      approver,
      change_reason: normalizeText(input.changeReason),
      previous_baseline: plan.previous,
      hash_algorithm: "sha256",
      hash_scope: plan.signals.length ? HASH_SCOPE + HASH_SCOPE_SIGNALS : HASH_SCOPE,
      baseline_hash: hash,
      summary: {
        total: plan.items.length,
        added: plan.changes.added,
        modified: plan.changes.modified,
        unchanged: plan.changes.unchanged,
        removed: plan.changes.removed,
      },
      open_items: plan.openItems,
      requirements: plan.items,
    };
    // 신호 표가 있거나, 있던 신호가 빠졌을 때만 적는다(신호 표를 쓰지 않는 프로젝트의 파일 모양은 예전과 같다).
    if (plan.signals.length || plan.signalsChanged) {
      baseline.summary.signals = { total: plan.signals.length, added: plan.signalChanges.added, modified: plan.signalChanges.modified, unchanged: plan.signalChanges.unchanged, removed: plan.signalChanges.removed };
    }
    if (plan.signals.length) baseline.signals = plan.signals;
    const requirements = {};
    for (const r of plan.items) requirements[r.requirement_id] = { version: r.version, content_hash: r.content_hash };
    const record = {
      baseline_id: baseline.baseline_id,
      baseline_hash: hash,
      created_at: baseline.created_at,
      approver,
      requirements,
      file: baseline,
    };
    if (plan.signals.length) {
      record.signals = {};
      for (const s of plan.signals) record.signals[s.name] = { version: s.version, content_hash: s.content_hash };
    }
    return { baseline, record };
  }

  // Baseline 파일이 만든 뒤 바뀌지 않았는지 해시를 다시 계산해 확인한다.
  async function verifyBaseline(baseline) {
    const errors = [];
    if (!baseline || baseline.schema !== SCHEMA) return { ok: false, errors: [`지원하지 않는 형식입니다: ${baseline && baseline.schema}`] };
    const items = Array.isArray(baseline.requirements) ? baseline.requirements : [];
    for (const r of items) {
      if ((await contentHash(r)) !== r.content_hash) errors.push(`${r.requirement_id}: 내용이 content_hash와 맞지 않습니다`);
    }
    const signals = Array.isArray(baseline.signals) ? baseline.signals : [];
    if (baseline.signals !== undefined && !Array.isArray(baseline.signals)) errors.push("signals 가 목록이 아닙니다");
    if (signals.length && !signalsApi) errors.push("신호 표를 확인할 수 없습니다 (signals.js 를 불러오지 못함)");
    else for (const s of signals) {
      if (!s || typeof s.name !== "string" || (await signalHash(s)) !== s.content_hash) errors.push(`신호 ${(s && s.name) || "(이름 없음)"}: 내용이 content_hash와 맞지 않습니다`);
    }
    if ((await baselineHash(baseline.baseline_id, items, signals)) !== baseline.baseline_hash) {
      errors.push(signals.length ? "baseline_hash가 요구사항 목록·신호 표와 맞지 않습니다" : "baseline_hash가 요구사항 목록과 맞지 않습니다");
    }
    return { ok: errors.length === 0, errors };
  }

  const api = Object.freeze({ SCHEMA, CONTENT_FIELDS, canonicalize, normalizeText, sha256Hex, planBaseline, buildBaseline, verifyBaseline });
  root.EarsBaseline = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
