#!/usr/bin/env node
/* 커밋 메시지의 요구사항 표기 점검.
 *
 * 대상 프로젝트의 설계·코드·시험을 바꾼 커밋이 어떤 Baseline 의 어떤 요구사항 때문에
 * 만들어졌는지 메시지 끝의 "Baseline:" / "Req:" 줄로 밝혔는지 확인한다.
 * 형식은 같은 폴더의 TAG_RULES.md 를 본다. 저장소를 수정하지 않는다.
 *
 * 사용법:
 *   node tools/trace/commit-check.js --root <대상 프로젝트> [--range A..B]
 * 종료 코드: 0 오류 없음, 1 표기 오류, 2 실행 조건 오류.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseRef, UsageError } = require("./trace-check.js");

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// 메시지에서 "Baseline: BL-001", "Req: REQ-A-1@v1, REQ-A-2@v1" 줄을 읽는다.
function parseTrailers(message) {
  const baselines = [];
  const reqs = [];
  for (const line of message.split(/\r?\n/)) {
    let m = /^Baseline:\s*(\S+)/i.exec(line.trim());
    if (m) { baselines.push(m[1]); continue; }
    m = /^Req:\s*(.+)$/i.exec(line.trim());
    if (m) reqs.push(...m[1].split(/[\s,]+/).filter(Boolean));
  }
  return { baselines, reqs };
}

function loadBaselines(root) {
  const dir = path.join(root, "requirements", "baseline");
  const map = new Map();
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith(".baseline.json")) continue;
    try {
      const b = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      map.set(b.baseline_id, new Map(b.requirements.map((r) => [r.requirement_id, r.version])));
    } catch (_) { /* 읽지 못한 파일은 없는 Baseline 으로 취급된다 */ }
  }
  return map;
}

function checkCommit(commit, baselines) {
  const errors = [];
  const { baselines: named, reqs } = parseTrailers(commit.message);
  if (named.length === 0) errors.push({ rule: "C1", message: "Baseline: 줄이 없음 (예: Baseline: BL-001)" });
  if (named.length > 1) errors.push({ rule: "C1", message: `Baseline: 줄이 여러 개임 (${named.join(", ")}) — 커밋 하나는 Baseline 하나를 기준으로 한다` });
  const baseline = named.length === 1 ? baselines.get(named[0]) : null;
  if (named.length === 1 && !baseline) errors.push({ rule: "C2", message: `${named[0]}: requirements/baseline 에 없는 Baseline` });
  if (reqs.length === 0) errors.push({ rule: "C3", message: "Req: 줄이 없음 (예: Req: REQ-OTP-01-1@v1)" });
  for (const token of reqs) {
    const ref = parseRef(token);
    if (ref.version === null) { errors.push({ rule: "C4", message: `${token}: 버전이 없음 (${token}@vN 형식으로 적는다)` }); continue; }
    if (!baseline) continue;
    if (!baseline.has(ref.id)) errors.push({ rule: "C4", message: `${ref.id}: ${named[0]} 에 없는 요구사항` });
    else if (baseline.get(ref.id) !== ref.version) errors.push({ rule: "C4", message: `${token}: ${named[0]} 의 버전은 v${baseline.get(ref.id)}` });
  }
  return errors;
}

function parseArgs(argv) {
  const opts = { root: ".", range: null, paths: ["docs/design", "src", "tests"], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} 뒤에 값이 필요함`); return argv[++i]; };
    if (a === "--root") opts.root = value();
    else if (a === "--range") opts.range = value();
    else if (a === "--paths") opts.paths = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new UsageError(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

const HELP = `커밋 메시지의 요구사항 표기 점검

사용법: node tools/trace/commit-check.js --root <대상 프로젝트> [옵션]

  --root DIR      대상 프로젝트 폴더 (기본: 현재 폴더)
  --range A..B    점검할 커밋 범위 (기본: HEAD 커밋 하나). 병합 커밋은 건너뛴다
  --paths DIRS    이 폴더를 바꾼 커밋만 점검, 대상 폴더 기준 (기본: docs/design,src,tests)

종료 코드: 0 오류 없음, 1 표기 오류, 2 실행 조건 오류`;

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return { code: 0, text: HELP };
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UsageError(`대상 폴더를 찾을 수 없음: ${root}`);

  let shas;
  try {
    const revs = opts.range ? ["--no-merges", "--reverse", opts.range] : ["--no-merges", "-1", "HEAD"];
    shas = git(root, "log", "--format=%H", ...revs, "--", ...opts.paths).split(/\r?\n/).filter(Boolean);
  } catch (e) {
    throw new UsageError(`Git 이력을 읽을 수 없음: ${String(e.stderr || e.message).trim().split("\n")[0]}`);
  }
  const baselines = loadBaselines(root);
  const commits = [];
  let errorCount = 0;
  for (const sha of shas) {
    const message = git(root, "log", "-1", "--format=%B", sha);
    const errors = checkCommit({ sha, message }, baselines);
    errorCount += errors.length;
    commits.push({ sha, subject: message.split(/\r?\n/)[0], errors, trailers: parseTrailers(message) });
  }

  const lines = [`# 커밋 표기 점검: ${opts.range || "HEAD"} — 대상 폴더를 바꾼 커밋 ${commits.length}개`];
  for (const c of commits) {
    lines.push(`- ${c.sha.slice(0, 12)} ${c.subject} — ${c.errors.length ? "오류" : `${c.trailers.baselines[0]} / ${c.trailers.reqs.join(", ")}`}`);
    for (const e of c.errors) lines.push(`  [오류 ${e.rule}] ${e.message}`);
  }
  if (commits.length === 0) lines.push("- 점검할 커밋이 없음 (범위 안에 설계·코드·시험을 바꾼 커밋이 없다)");
  lines.push("", `판정: ${errorCount ? "실패" : "통과"} — 오류 ${errorCount}개`);
  return { code: errorCount ? 1 : 0, text: lines.join("\n"), commits };
}

module.exports = { run, parseTrailers, checkCommit };

if (require.main === module) {
  try { const r = run(process.argv.slice(2)); console.log(r.text); process.exitCode = r.code; }
  catch (e) { console.error(e instanceof UsageError ? e.message : e); process.exitCode = 2; }
}
