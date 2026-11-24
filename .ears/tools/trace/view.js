/* 요구사항별 코드 보기와 대상 프로젝트 파일 읽기(읽기 전용).
 *
 * 추적 태그를 따라 요구사항 하나에 연결된 설계 항목의 본문, 함수의 실제 소스(위쪽 주석 포함),
 * 시험 블록을 뽑는다. 파일을 수정하지 않는다.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const trace = require("./trace-check.js");
const impact = require("./impact.js");

const DIRS = { design: ["docs/design"], code: ["src"], tests: ["tests"] };
const VIEWABLE = [/^docs\/standards\/(?:coding|static)\/[^/\\]+\.(?:md|txt)$/, /^docs\/design\/[^\\]+$/, /^src\/[^\\]+$/, /^tests\/[^\\]+$/, /^agent-log\/[^\\]+\.json$/, /^requirements\/baseline\/[^\\]+\.json$/, /^Makefile$/, /^project\.json$/, /^verification-log\/[^\\]+\.json$/, /^impact-log\/[^\\]+\.json$/, /^review-log\/[^\\]+\.json$/, /^consistency-log\/[^\\]+\.json$/, /^test-spec\/[^/\\]+\.json$/];
const MAX_VIEW_BYTES = 400 * 1024;

const readLines = (root, rel) => fs.readFileSync(path.join(root, ...rel.split("/")), "utf8").replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
const trimBlank = (lines) => { const out = lines.slice(); while (out.length && !out[out.length - 1].trim()) out.pop(); return out; };

function viewablePath(p) {
  const s = String(p || "");
  if (!s || s.length > 300 || s.includes("\\") || s.includes(":") || s.startsWith("/")) return false;
  if (s.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || seg.startsWith("."))) return false;
  return VIEWABLE.some((re) => re.test(s));
}

function listViewable(root) {
  const out = [];
  const walk = (rel) => {
    const full = path.join(root, ...rel.split("/"));
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) return; // 폴더 자리에 파일이 있으면 그 폴더는 없는 것으로 본다
    for (const d of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (d.name.startsWith(".")) continue;
      const r = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(r);
      else if (viewablePath(r)) out.push({ path: r, bytes: fs.statSync(path.join(full, d.name)).size, writable: writablePath(r) });
    }
  };
  for (const d of ["docs/standards/coding", "docs/standards/static", "docs/design", "src", "tests", "requirements/baseline", "test-spec", "agent-log", "impact-log", "review-log", "verification-log"]) walk(d);
  for (const name of ["Makefile", "project.json"]) if (fs.existsSync(path.join(root, name))) out.push({ path: name, bytes: fs.statSync(path.join(root, name)).size, writable: writablePath(name) });
  return out;
}

function readViewable(root, p) {
  if (!viewablePath(p)) return { error: "볼 수 없는 경로입니다.", status: 400 };
  const full = path.join(root, ...p.split("/"));
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { error: `파일이 없습니다: ${p}`, status: 404 };
  if (fs.statSync(full).size > MAX_VIEW_BYTES) return { error: "파일이 너무 커서 표시하지 않습니다.", status: 413 };
  const content = fs.readFileSync(full, "utf8").replace(/\r\n?/g, "\n");
  return { path: p, content, sha256: sha256(content), writable: writablePath(p) };
}

// ── 사람이 편집기에서 고친 파일 저장 ──
// 쓸 수 있는 곳은 설계 문서, 소스, 시험, Makefile 뿐이다. Baseline 과 생성 기록은 고칠 수 없다.

const WRITABLE = [/^docs\/standards\/(?:coding|static)\/[^/\\]+\.(?:md|txt)$/, /^docs\/design\/[^/\\]+\.md$/, /^src\/[^/\\]+\.(c|h)$/, /^tests\/[^/\\]+\.(c|h)$/, /^Makefile$/];
const WRITABLE_TEXT = "docs/standards/coding/*.md·txt, docs/standards/static/*.md·txt, docs/design/*.md, src/*.c, src/*.h, tests/*.c, tests/*.h, Makefile";
const MANUAL_LOG = "agent-log/manual-edits.jsonl";

function sha256(text) { return "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
function writablePath(p) { return viewablePath(p) && WRITABLE.some((re) => re.test(p)); }

// Windows 에서 만들 수 없거나 Git 이 받지 않는 이름. 다른 OS 에서는 만들어지더라도 Windows 에서 받지 못하고
// (aux.h 가 하나 있으면 git add 가 통째로 실패한다) GitHub 올리기를 막으므로 어디서나 거절한다.
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
function reservedName(name) { return WIN_RESERVED.test(String(name || "")); }
// 새로 만들 파일 이름으로 쓸 수 없는 까닭(쓸 수 있으면 "").
function badFileName(p) {
  const name = String(p || "").split("/").pop();
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) return `파일 이름에 쓸 수 없는 글자가 있습니다: ${name} — < > : " | ? * 는 Windows 에서 파일 이름에 쓸 수 없습니다.`;
  if (reservedName(name)) return `${name.split(".")[0]} 은(는) Windows 가 장치 이름으로 쓰는 예약어라 파일 이름으로 쓸 수 없습니다(con, prn, aux, nul, com1~9, lpt1~9). 다른 이름을 쓰세요(예: ${name.split(".")[0]}_io.${name.split(".").slice(1).join(".") || "c"}).`;
  if (name !== name.trim()) return `파일 이름의 앞뒤에 빈칸이 있습니다: '${name}'`;
  return "";
}

// 줄 단위로 늘어난 줄 수와 줄어든 줄 수(같은 줄은 개수만큼 상쇄).
function lineDelta(before, after) {
  const count = new Map();
  for (const l of before.split("\n")) count.set(l, (count.get(l) || 0) + 1);
  let added = 0;
  for (const l of after.split("\n")) { const n = count.get(l) || 0; if (n > 0) count.set(l, n - 1); else added++; }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

// baseSha: 편집을 시작할 때 읽은 내용의 해시(새 파일이면 null). 그 사이 디스크의 파일이 바뀌었으면 덮어쓰지 않는다.
function writeViewable(root, p, content, baseSha) {
  if (!writablePath(p)) return { error: `편집기에서 저장할 수 없는 경로입니다 (허용: ${WRITABLE_TEXT}).`, status: 400 };
  if (typeof content !== "string") return { error: "내용이 없습니다.", status: 400 };
  if (content.includes("\0")) return { error: "텍스트가 아닌 내용은 저장할 수 없습니다.", status: 400 };
  const text = content.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(text) > MAX_VIEW_BYTES) return { error: "파일이 너무 큽니다.", status: 413 };
  const full = path.join(root, ...p.split("/"));
  const exists = fs.existsSync(full);
  if (!exists) { const bad = badFileName(p); if (bad) return { error: bad, status: 400 }; }
  if (exists && !fs.statSync(full).isFile()) return { error: `파일이 아닙니다: ${p}`, status: 400 };
  const before = exists ? fs.readFileSync(full, "utf8").replace(/\r\n?/g, "\n") : null;
  if (exists && !baseSha) return { error: `${p} 가 이미 있습니다. 파일을 열어서 고치세요.`, status: 409 };
  if (!exists && baseSha) return { error: `${p} 가 디스크에서 지워졌습니다. 내용을 따로 보관한 뒤 다시 여세요.`, status: 409 };
  if (exists && sha256(before) !== baseSha) return { error: `${p} 가 편집을 시작한 뒤 디스크에서 바뀌었습니다(생성 결과 적용 등). 내용을 따로 보관한 뒤 파일을 다시 여세요.`, status: 409 };
  const after = sha256(text);
  if (exists && before === text) return { path: p, sha256: after, created: false, changed: false, added: 0, removed: 0 };
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // 고치기 전·후 내용을 남긴다(커밋하지 않은 코드에서도 사람이 무엇을 바꿨는지 비교할 수 있게)
  try { const snap = require("./snapshots.js"); if (before !== null) snap.put(root, before); snap.put(root, text); } catch (_) { /* 남기지 못해도 저장은 한다 */ }
  fs.writeFileSync(full, text);
  const delta = lineDelta(before === null ? "" : before, text);
  // 사람이 고친 내역을 생성 기록 옆에 남긴다(한 줄에 한 번의 저장).
  const log = path.join(root, ...MANUAL_LOG.split("/"));
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), by: "human", path: p, before_sha256: before === null ? null : sha256(before), after_sha256: after, added: delta.added, removed: delta.removed }) + "\n");
  return { path: p, sha256: after, created: !exists, changed: true, added: delta.added, removed: delta.removed };
}

// 사람이 탐색기에서 지운 파일. 지울 수 있는 곳은 저장할 수 있는 곳과 같다(설계·소스·시험·표준 문서·Makefile).
// 고정본(requirements/baseline)·생성/검증 기록·project.json 은 근거라서 지우지 않는다. 지운 내역을 남긴다.
function deleteViewable(root, p, baseSha) {
  if (!writablePath(p)) return { error: `지울 수 없는 파일입니다. 지울 수 있는 곳: ${WRITABLE_TEXT}. 고정본·기록·설정 파일은 근거라서 지우지 않습니다.`, status: 400 };
  const full = path.join(root, ...p.split("/"));
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { error: `파일이 없습니다: ${p}`, status: 404 };
  const before = fs.readFileSync(full, "utf8").replace(/\r\n?/g, "\n");
  if (baseSha && sha256(before) !== baseSha) return { error: `${p} 가 그 사이 바뀌었습니다. 다시 열어 확인한 뒤 지우세요.`, status: 409 };
  try { require("./snapshots.js").put(root, before); } catch (_) { /* 남기지 못해도 지운다 */ }
  fs.unlinkSync(full);
  const log = path.join(root, ...MANUAL_LOG.split("/"));
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), by: "human", path: p, before_sha256: sha256(before), after_sha256: null, deleted: true, added: 0, removed: before.split("\n").length }) + "\n");
  return { path: p, deleted: true };
}

// 이름 바꾸기·옮기기(잘라내기 → 붙여넣기). 두 경로 모두 저장할 수 있는 곳이어야 하고, 새 이름의 파일이 없어야 한다.
function renameViewable(root, from, to) {
  if (!writablePath(from)) return { error: `이름을 바꿀 수 없는 파일입니다 (허용: ${WRITABLE_TEXT}).`, status: 400 };
  if (!writablePath(to)) return { error: `그 이름으로는 둘 수 없습니다 (허용: ${WRITABLE_TEXT}).`, status: 400 };
  if (from === to) return { path: to, renamed: false };
  { const bad = badFileName(to); if (bad) return { error: bad, status: 400 }; }
  const a = path.join(root, ...from.split("/"));
  const b = path.join(root, ...to.split("/"));
  if (!fs.existsSync(a) || !fs.statSync(a).isFile()) return { error: `파일이 없습니다: ${from}`, status: 404 };
  // Windows 는 대소문자만 다른 이름을 같은 파일로 본다: 그때는 바꾸기만 허용한다.
  if (fs.existsSync(b) && from.toLowerCase() !== to.toLowerCase()) return { error: `${to} 가 이미 있습니다.`, status: 409 };
  const text = fs.readFileSync(a, "utf8").replace(/\r\n?/g, "\n");
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.renameSync(a, b);
  const log = path.join(root, ...MANUAL_LOG.split("/"));
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), by: "human", path: to, renamed_from: from, before_sha256: sha256(text), after_sha256: sha256(text), added: 0, removed: 0 }) + "\n");
  return { path: to, from, renamed: true };
}

// 마지막 커밋(HEAD)에 들어 있는 내용. 커밋 전 변경을 비교해서 보여 주는 데 쓴다. 커밋에 없는 파일이면 exists: false.
function readAtHead(root, p) {
  if (!viewablePath(p)) return { error: "볼 수 없는 경로입니다.", status: 400 };
  try {
    const out = execFileSync("git", ["-c", "core.quotepath=false", "show", `HEAD:./${p}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
    return { path: p, ref: "HEAD", exists: true, content: out.replace(/\r\n?/g, "\n") };
  } catch (e) {
    const msg = String((e && e.stderr) || "");
    if (/does not exist|exists on disk, but not in|bad revision|invalid object name/i.test(msg)) return { path: p, ref: "HEAD", exists: false, content: "" };
    return { error: "마지막 커밋의 내용을 읽을 수 없습니다(Git 저장소가 아니거나 커밋이 없음).", status: 409 };
  }
}

// 설계·소스·시험·Makefile·Baseline 에서 문자열을 찾는다(생성 기록은 제외).
const SEARCH_MAX = 300;
function searchViewable(root, query, options) {
  const q = String(query || "");
  if (!q.trim()) return { query: q, matches: [], files: 0, truncated: false };
  if (q.length > 200) return { error: "검색어가 너무 깁니다.", status: 400 };
  const cs = Boolean(options && options.caseSensitive);
  const needle = cs ? q : q.toLowerCase();
  const matches = [];
  const files = new Set();
  let truncated = false;
  for (const f of listViewable(root)) {
    if (/^(agent-log|verification-log|impact-log|review-log)\//.test(f.path) || f.bytes > MAX_VIEW_BYTES) continue;
    const lines = readLines(root, f.path);
    for (let i = 0; i < lines.length && !truncated; i++) {
      const hay = cs ? lines[i] : lines[i].toLowerCase();
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        if (matches.length >= SEARCH_MAX) { truncated = true; break; }
        const from = Math.max(0, at - 60);
        matches.push({ path: f.path, line: i + 1, column: at + 1, length: q.length, text: lines[i].slice(from, from + 200), offset: at - from });
        files.add(f.path);
      }
    }
    if (truncated) break;
  }
  return { query: q, matches, files: files.size, truncated };
}

// 설계 항목 본문: @design 바로 위의 제목 줄(있으면)부터 다음 설계 항목 앞까지.
function designBlocks(lines) {
  const tags = trace.parseTags(lines.join("\n")).filter((t) => t.tag === "design" && t.args[0]);
  const starts = tags.map((t) => {
    let s = t.line;
    for (let k = t.line - 1; k >= Math.max(1, t.line - 3); k--) {
      if (/^#{1,6}\s/.test(lines[k - 1])) { s = k; break; }
      if (lines[k - 1].trim()) break;
    }
    return { id: t.args[0], start: s };
  });
  return starts.map((b, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].start - 1 : lines.length;
    return { id: b.id, startLine: b.start, endLine: b.start + trimBlank(lines.slice(b.start - 1, end)).length - 1 };
  });
}

// 함수 소스: 함수 바로 위에 붙은 주석부터 함수 끝까지.
function functionRange(lines, unit) {
  let s = unit.startLine;
  for (let k = unit.startLine - 1; k >= 1; k--) {
    const t = lines[k - 1].trim();
    if (/^(\/\*|\*|\/\/)/.test(t) || /\*\/$/.test(t)) s = k;
    else break;
  }
  return { startLine: s, endLine: unit.endLine };
}

// 시험 블록: @testcase 가 있는 줄부터 다음 @testcase 앞까지(빈 줄 제외).
function testBlocks(lines) {
  const tags = trace.parseTags(lines.join("\n")).filter((t) => t.tag === "testcase" && t.args[0]);
  return tags.map((t, i) => {
    const end = i + 1 < tags.length ? tags[i + 1].line - 1 : lines.length;
    let body = trimBlank(lines.slice(t.line - 1, end));
    // 마지막 블록이 main 의 끝(return·닫는 중괄호)까지 끌고 오지 않게 한다.
    if (i + 1 === tags.length) {
      const stop = body.findIndex((l, k) => k > 0 && /^\s*(return\b|}\s*$)/.test(l));
      if (stop > 0) body = trimBlank(body.slice(0, stop));
    }
    return { id: t.args[0], startLine: t.line, endLine: t.line + body.length - 1 };
  });
}

const snippet = (lines, a, b) => ({ startLine: a, endLine: b, code: lines.slice(a - 1, b).join("\n") });

async function requirementView(root, requirementId) {
  const all = impact.loadBaselines(root);
  if (!all.length) throw new trace.UsageError("대상 프로젝트에 고정본이 없음");
  const baseline = all[all.length - 1].baseline;
  const req = baseline.requirements.find((r) => r.requirement_id === requirementId);
  if (!req) throw new trace.UsageError(`${baseline.baseline_id} 에 없는 요구사항: ${requirementId}`);

  const model = trace.collect(root, DIRS);
  const cache = new Map();
  const lines = (rel) => { if (!cache.has(rel)) cache.set(rel, readLines(root, rel)); return cache.get(rel); };
  const linkState = (v) => (v === req.version ? "현재 버전" : v === null ? "버전 없음" : "낡은 버전");

  const designs = [...model.designs.values()].filter((d) => d.links.some((l) => l.id === requirementId)).map((d) => {
    const v = d.links.find((l) => l.id === requirementId).version;
    const ls = lines(d.file);
    const block = designBlocks(ls).find((b) => b.id === d.id);
    return Object.assign({ id: d.id, file: d.file, linked_version: v, state: linkState(v) }, block ? snippet(ls, block.startLine, block.endLine) : snippet(ls, d.line, d.line));
  });
  const designIds = new Set(designs.map((d) => d.id));

  const functions = [];
  for (const u of model.units.filter((x) => x.implements.some((id) => designIds.has(id)))) {
    const ls = lines(u.file);
    let range = { startLine: u.line, endLine: u.line };
    if (u.func) {
      const unit = trace.cUnits(ls.join("\n")).units.find((x) => x.name === u.func && x.startLine === u.line);
      if (unit) range = functionRange(ls, unit);
    } else range = { startLine: 1, endLine: ls.length };
    functions.push(Object.assign({ file: u.file, func: u.func, via: u.implements.filter((id) => designIds.has(id)) }, snippet(ls, range.startLine, range.endLine)));
  }

  const tests = [...model.tests.values()].filter((t) => t.links.some((l) => l.id === requirementId || designIds.has(l.id))).map((t) => {
    const direct = t.links.find((l) => l.id === requirementId);
    const v = direct ? direct.version : null;
    const ls = lines(t.file);
    const block = testBlocks(ls).find((b) => b.id === t.id);
    return Object.assign({ id: t.id, file: t.file, linked_version: v, state: direct ? linkState(v) : "설계 항목을 통해 연결" }, block ? snippet(ls, block.startLine, block.endLine) : snippet(ls, t.line, t.line));
  });

  return {
    baseline: { baseline_id: baseline.baseline_id, baseline_hash: baseline.baseline_hash },
    requirement: {
      requirement_id: req.requirement_id, version: req.version, ears_type: req.ears_type, text: req.text, summary: req.summary,
      parent: req.parent, acceptance_criteria: req.acceptance_criteria, source: req.source,
      children: baseline.requirements.filter((r) => r.parent === requirementId).map((r) => r.requirement_id),
    },
    designs, functions, tests,
  };
}

// 파일 안의 추적 영역: 함수·설계 항목·시험마다 연결된 요구사항(현재 버전인지 포함).
// 코드를 보다가 "이 부분은 어느 요구사항 때문에 있나"를 바로 알 수 있게 한다.
function fileRegions(root, rel) {
  const all = impact.loadBaselines(root);
  if (!all.length) return [];
  const versions = new Map(all[all.length - 1].baseline.requirements.map((r) => [r.requirement_id, r.version]));
  const model = trace.collect(root, DIRS);
  const ls = readLines(root, rel);
  const refState = (ref) => ({ id: ref.id, version: ref.version, state: !versions.has(ref.id) ? "고정본에 없음" : ref.version === versions.get(ref.id) ? "현재 버전" : "낡은 버전" });
  const viaDesigns = (designIds) => {
    const out = [];
    for (const id of designIds) { const d = model.designs.get(id); if (d) for (const l of d.links) out.push(refState(l)); }
    return out;
  };
  const uniqRefs = (refs) => refs.filter((r, i) => refs.findIndex((x) => x.id === r.id && x.version === r.version) === i);
  const regions = [];
  if (rel.startsWith("docs/design/")) {
    for (const b of designBlocks(ls)) {
      const d = model.designs.get(b.id);
      regions.push({ kind: "설계", label: b.id, startLine: b.startLine, endLine: b.endLine, links: [b.id], requirements: uniqRefs(d ? d.links.map(refState) : []) });
    }
  } else if (rel.startsWith("src/") && /\.(c|h)$/.test(rel)) {
    for (const u of trace.cUnits(ls.join("\n")).units) {
      const r = functionRange(ls, u);
      regions.push({ kind: "함수", label: `${u.name}()`, startLine: r.startLine, endLine: r.endLine, links: u.implements, exempt: u.exempt, requirements: uniqRefs(viaDesigns(u.implements)) });
    }
  } else if (rel.startsWith("tests/")) {
    for (const b of testBlocks(ls)) {
      const t = model.tests.get(b.id);
      const links = t ? t.links : [];
      const reqs = [...links.filter((l) => !l.id.startsWith("SWD-")).map(refState), ...viaDesigns(links.filter((l) => l.id.startsWith("SWD-")).map((l) => l.id))];
      regions.push({ kind: "시험", label: b.id, startLine: b.startLine, endLine: b.endLine, links: links.map((l) => l.id + (l.version ? "@v" + l.version : "")), requirements: uniqRefs(reqs) });
    }
  }
  return regions;
}

module.exports = { requirementView, listViewable, readViewable, viewablePath, designBlocks, testBlocks, fileRegions, writablePath, writeViewable, deleteViewable, renameViewable, readAtHead, searchViewable, sha256, MANUAL_LOG, reservedName, badFileName };
