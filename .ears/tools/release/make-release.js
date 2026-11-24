#!/usr/bin/env node
/* 릴리스 묶음 만들기(CD): 태그가 가리키는 커밋을 게이트에 통과시킨 뒤, 소스와 증거를 한 묶음으로 만든다.
 *
 * 태그 형식: release/<대상 프로젝트>/v<주>.<부>.<수>   예) release/overheat-protection/v1.0.0
 *
 * 하는 일
 *  1. 대상 프로젝트의 추적성 게이트를 실행한다(시험 실행 + 요구사항–설계–코드–시험–결과 점검).
 *     게이트가 실패하거나, 고정된 컨테이너 이미지에서 실행하지 않았으면 묶음을 만들지 않는다.
 *  2. <out>/ 에 다음을 만든다.
 *     - <대상>-v<버전>.tar.gz    설계·코드·시험·Baseline·생성 기록 + 증거(evidence/)
 *     - release-manifest.json    무엇을 어떤 Baseline·커밋·환경에서 시험해 내보냈는지(파일별 해시 포함)
 *     - trace-matrix.md          요구사항별 추적표
 *     - release-notes.md         릴리스 설명
 *
 * 사용법: node tools/release/make-release.js --tag <태그> [--commit SHA] [--targets DIR] [--out DIR]
 * 종료 코드: 0 묶음 생성, 1 게이트 실패 등으로 릴리스 불가, 2 실행 조건 오류.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const gate = require("../trace/run-gate.js");
const trace = require("../trace/trace-check.js");

const TAG_RE = /^release\/([a-z0-9][a-z0-9-]{0,39})\/v(\d+\.\d+\.\d+)$/;
const MANIFEST_SCHEMA = "release-manifest/v1";
const SKIP_DIRS = new Set(["trace-out", "build", ".git", "node_modules"]);
const EVIDENCE = ["results.json", "trace-matrix.json", "trace-matrix.md", "test-output.log"];

const sha256 = (buf) => "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");

function parseTag(tag) {
  const m = TAG_RE.exec(String(tag || ""));
  return m ? { target: m[1], version: m[2] } : null;
}

// 대상 폴더의 파일 목록(실행 산출물 폴더 제외). 경로는 '/' 구분, 이름순.
function listFiles(dir, prefix) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) out.push(...listFiles(path.join(dir, d.name), `${prefix || ""}${d.name}/`)); }
    else if (d.isFile() && !/^\.env(\.|$)/.test(d.name)) out.push(`${prefix || ""}${d.name}`);
  }
  return out.sort();
}

// tar(ustar) 묶음. 시각·소유자·권한을 고정해 같은 내용이면 같은 바이트가 나오게 한다.
function tarball(entries) {
  const blocks = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    if (name.length > 255) throw new Error(`경로가 너무 김: ${e.name}`);
    let prefix = Buffer.alloc(0);
    let base = name;
    if (name.length > 100) {
      // 긴 경로는 '/' 에서 나눠 앞부분(155바이트 이하)과 뒷부분(100바이트 이하)에 담는다.
      let at = -1;
      for (let i = e.name.indexOf("/"); i >= 0; i = e.name.indexOf("/", i + 1)) {
        if (Buffer.byteLength(e.name.slice(0, i)) <= 155 && Buffer.byteLength(e.name.slice(i + 1)) <= 100) { at = i; break; }
      }
      if (at < 0) throw new Error(`경로를 tar 머리말에 담을 수 없음: ${e.name}`);
      prefix = Buffer.from(e.name.slice(0, at), "utf8");
      base = Buffer.from(e.name.slice(at + 1), "utf8");
    }
    const head = Buffer.alloc(512);
    base.copy(head, 0);
    head.write("0000644\0", 100, "ascii");
    head.write("0000000\0", 108, "ascii");
    head.write("0000000\0", 116, "ascii");
    head.write(e.data.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    head.write("00000000000\0", 136, "ascii"); // 수정 시각 0
    head.write("        ", 148, "ascii");
    head.write("0", 156, "ascii");
    head.write("ustar\0" + "00", 257, "ascii");
    prefix.copy(head, 345);
    let sum = 0;
    for (const b of head) sum += b;
    head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(head, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const gz = zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
  gz[9] = 255; // 만든 운영체제 표시를 '알 수 없음'으로 고정
  return gz;
}

function parseArgs(argv) {
  const opts = { tag: null, commit: null, targets: "targets", out: "release-out", testCmd: null, allowUnpinned: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new trace.UsageError(`${a} 뒤에 값이 필요함`); return argv[++i]; };
    if (a === "--tag") opts.tag = value();
    else if (a === "--commit") opts.commit = value();
    else if (a === "--targets") opts.targets = value();
    else if (a === "--out") opts.out = value();
    else if (a === "--test-cmd") opts.testCmd = value();
    else if (a === "--allow-unpinned") opts.allowUnpinned = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new trace.UsageError(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

const HELP = `릴리스 묶음 만들기: 게이트 통과 → 소스와 증거를 한 묶음으로

사용법: node tools/release/make-release.js --tag release/<대상>/v<주.부.수> [옵션]

  --tag TAG         릴리스 태그 (필수)
  --commit SHA      태그가 가리키는 커밋 (기본: git rev-parse HEAD)
  --targets DIR     대상 프로젝트들이 있는 폴더 (기본: targets)
  --out DIR         결과 폴더 (기본: release-out)
  --test-cmd CMD    게이트에 넘길 시험 명령 (기본: 게이트 기본값)
  --allow-unpinned  고정된 컨테이너 이미지가 아니어도 만든다 (시험용. 실제 릴리스에 쓰지 않는다)

종료 코드: 0 묶음 생성, 1 릴리스 불가, 2 실행 조건 오류`;

function notes(m, matrixRows) {
  const rows = matrixRows.map((r) => `| ${r.requirement_id} | v${r.version} | ${r.status} | ${(r.results || []).map((x) => `${x.tc_id} ${x.result}`).join("<br>") || "-"} |`).join("\n");
  return [
    `# ${m.target} v${m.version}`,
    "",
    `- 커밋: \`${m.commit}\``,
    `- Baseline: ${m.baseline_id} (\`${m.baseline_hash}\`)`,
    `- 게이트: 통과 (시험 ${m.tests.pass}개 통과, 실패 ${m.tests.fail}, 건너뜀 ${m.tests.skip})`,
    `- 결과 지문: \`${m.result_fingerprint}\``,
    `- 실행 환경: ${m.environment.image || "고정되지 않음"}${m.environment.cc ? ` · ${m.environment.cc}` : ""}`,
    ...(m.coverage && m.coverage.measured ? [`- 커버리지: 구문 ${m.coverage.statement.percent}% · 분기 ${m.coverage.branch.percent}%${m.coverage.mcdc ? ` · MC/DC ${m.coverage.mcdc.percent}%` : ""}`] : []),
    ...(m.static_analysis ? [`- 정적 분석: ${m.static_analysis.ran ? `${m.static_analysis.tool} ${m.static_analysis.version || ""} · 기준 이상 지적 ${m.static_analysis.counted}건` : `실행 못 함 — ${m.static_analysis.reason || ""}`}`] : []),
    `- 묶음: \`${m.bundle.name}\` (\`${m.bundle.sha256}\`)`,
    "",
    "| 요구사항 | 버전 | 판정 | 시험 결과 |",
    "|---|---|---|---|",
    rows,
    "",
    "묶음 안의 `release-manifest.json` 에 파일별 해시가 있다. `evidence/` 에 시험 결과와 추적표가 있다.",
    "",
  ].join("\n");
}

async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return { code: 0, text: HELP };
  const parsed = parseTag(opts.tag);
  if (!parsed) throw new trace.UsageError(`릴리스 태그 형식이 아님: ${opts.tag || "(없음)"} — release/<대상>/v<주.부.수> 형식이어야 한다`);
  const root = path.resolve(opts.targets, parsed.target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new trace.UsageError(`대상 프로젝트 폴더가 없음: ${path.join(opts.targets, parsed.target)}`);

  const gateArgs = ["--root", root];
  if (opts.commit) gateArgs.push("--commit", opts.commit);
  if (opts.testCmd) gateArgs.push("--test-cmd", opts.testCmd);
  const g = await gate.run(gateArgs);
  const lines = [`# 릴리스 ${opts.tag}`, "", g.text, ""];
  if (g.code !== 0) { lines.push("릴리스: 만들지 않음 — 게이트를 통과하지 못함"); return { code: 1, text: lines.join("\n") }; }
  if (g.dirty && g.dirty.length) { lines.push("릴리스: 만들지 않음 — 대상 폴더에 커밋되지 않은 변경이 있음"); return { code: 1, text: lines.join("\n") }; }
  const record = g.record;
  if (!record.environment.pinned && !opts.allowUnpinned) { lines.push("릴리스: 만들지 않음 — 해시로 고정한 컨테이너 이미지에서 실행하지 않음"); return { code: 1, text: lines.join("\n") }; }

  const files = listFiles(root).map((rel) => ({ rel, data: fs.readFileSync(path.join(root, ...rel.split("/"))) }));
  const evidence = EVIDENCE.map((name) => ({ rel: `evidence/${name}`, file: path.join(root, "trace-out", name) }))
    .filter((e) => fs.existsSync(e.file)).map((e) => ({ rel: e.rel, data: fs.readFileSync(e.file) }));
  const matrixRows = g.report.result.matrix;
  const count = (k) => record.results.filter((x) => x.result === k).length;
  const bundleName = `${parsed.target}-v${parsed.version}.tar.gz`;
  const manifest = {
    schema: MANIFEST_SCHEMA,
    target: parsed.target, version: parsed.version, tag: opts.tag,
    commit: record.commit,
    baseline_id: record.baseline_id, baseline_hash: record.baseline_hash,
    gate: "pass",
    tests: { pass: count("pass"), fail: count("fail"), skip: count("skip") },
    result_fingerprint: record.result_fingerprint,
    environment: record.environment,
    config: record.config ? { domain: record.config.domain, level: record.config.level, standard: record.config.standard, compiler: record.config.compiler || null, compiler_used: record.config.compiler_used || null, cflags: record.config.cflags } : null,
    coverage: record.coverage || null,
    static_analysis: record.static_analysis ? { ran: Boolean(record.static_analysis.ran), tool: record.static_analysis.tool, version: record.static_analysis.version || null, level: record.static_analysis.level || null, fail_on: record.static_analysis.fail_on || null, findings: (record.static_analysis.findings || []).length, counted: record.static_analysis.counted || 0, reason: record.static_analysis.reason || null } : null,
    problems: (record.gate && record.gate.problems) || [],
    requirements: matrixRows.map((r) => ({ requirement_id: r.requirement_id, version: r.version, status: r.status, designs: r.designs, code: r.code, results: r.results })),
    files: [...files, ...evidence].map((f) => ({ path: f.rel, bytes: f.data.length, sha256: sha256(f.data) })),
  };
  const top = `${parsed.target}-v${parsed.version}`;
  const manifestInBundle = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const bundle = tarball([
    { name: `${top}/release-manifest.json`, data: manifestInBundle },
    ...[...files, ...evidence].map((f) => ({ name: `${top}/${f.rel}`, data: f.data })),
  ]);
  manifest.bundle = { name: bundleName, bytes: bundle.length, sha256: sha256(bundle) };

  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, bundleName), bundle);
  fs.writeFileSync(path.join(outDir, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const md = path.join(root, "trace-out", "trace-matrix.md");
  if (fs.existsSync(md)) fs.copyFileSync(md, path.join(outDir, "trace-matrix.md"));
  fs.writeFileSync(path.join(outDir, "release-notes.md"), notes(manifest, matrixRows));
  lines.push(`릴리스: 묶음 생성 — ${bundleName} (${bundle.length} 바이트, 파일 ${manifest.files.length}개)`);
  return { code: 0, text: lines.join("\n"), manifest, outDir, bundle: path.join(outDir, bundleName) };
}

module.exports = { run, parseTag, tarball, listFiles, TAG_RE, MANIFEST_SCHEMA };

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (r) => { console.log(r.text); process.exitCode = r.code; },
    (e) => { console.error(e instanceof trace.UsageError ? e.message : e); process.exitCode = 2; }
  );
}
