/* 정적 분석: 게이트에서 Cppcheck 로 구현 코드(src/)를 검사한다.
 *
 * 프로젝트 설정(project.json)의 static_analysis 가 정한다.
 *   level   : required(지적이 있으면 게이트 실패) · recommended(경고만) · off
 *   fail_on : 어느 심각도부터 셀지 — error · warning(기본) · style
 * 도구는 확장(tools/project/extensions.js)과 같은 방법으로 찾는다. 없으면 '검사하지 못함'으로 보고한다
 * (required 이면 게이트 실패, recommended 이면 경고).
 * 시험 코드(tests/)는 검사하지 않는다. 제품 코드의 품질 기준이기 때문이다.
 */
"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const extensions = require("./extensions.js");

const FAIL_ON = ["error", "warning", "style"];
const RANK = { error: 3, warning: 2, style: 1, performance: 1, portability: 1, information: 0, debug: 0, none: 0 };
const IGNORE_IDS = new Set(["missingIncludeSystem", "missingInclude", "checkersReport", "unmatchedSuppression", "toomanyconfigs", "normalCheckLevelMaxBranches"]);

// Cppcheck 실행 파일을 찾는다. 결과: { exe, version } 또는 null.
function findCppcheck(env) {
  const item = extensions.CATALOG.find((x) => x.id === "cppcheck");
  const found = extensions.inspect(item, env || process.env);
  if (!found.installed) return null;
  return { exe: path.join(found.where, process.platform === "win32" ? "cppcheck.exe" : "cppcheck"), version: found.version };
}

// Cppcheck 의 XML(버전 2) 보고서를 읽는다.
function parseXml(text) {
  const findings = [];
  const unq = (s) => String(s || "").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unq(m[1]) : ""; };
  const re = /<error\b([^>]*?)(\/>|>([\s\S]*?)<\/error>)/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    const head = m[1];
    const id = attr(head, "id");
    if (!id || IGNORE_IDS.has(id)) continue;
    const loc = /<location\b([^>]*)\/?>/.exec(m[3] || "");
    findings.push({
      id, severity: attr(head, "severity") || "none", message: attr(head, "msg"),
      cwe: attr(head, "cwe") || null,
      file: loc ? attr(loc[1], "file").split(path.sep).join("/") : "", line: loc ? Number(attr(loc[1], "line")) || 0 : 0,
    });
  }
  return findings;
}

const counts = (sev, failOn) => (RANK[sev] || 0) >= (RANK[failOn] || RANK.warning);

// 검사를 실행한다. options: { env, exec(cmd, args, opts) → { status, stdout, stderr, error }, find(env) }
function run(root, config, options) {
  const o = options || {};
  const sa = config.static_analysis;
  const tool = (o.find || findCppcheck)(o.env);
  if (!tool) return { ran: false, tool: "cppcheck", reason: "Cppcheck 를 찾을 수 없음 — 왼쪽 '확장'에서 설치하거나 PATH 에 넣는다" };
  const args = [
    "--enable=warning,style,performance,portability", `--std=${config.build.c_standard}`, "--language=c",
    "--inline-suppr", "--suppress=missingIncludeSystem", "--error-exitcode=0", "--quiet", "--xml", "--xml-version=2",
    "-I", "src", "src",
  ];
  const exec = o.exec || ((cmd, a, opts) => spawnSync(cmd, a, opts));
  const r = exec(tool.exe, args, { cwd: root, encoding: "utf8", timeout: 5 * 60 * 1000, windowsHide: true, env: o.env || process.env, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { ran: false, tool: "cppcheck", version: tool.version, reason: `Cppcheck 실행 실패: ${r.error ? r.error.message : String(r.stderr || "").split(/\r?\n/).find(Boolean) || `종료 코드 ${r.status}`}` };
  const findings = parseXml(r.stderr).filter((f) => !f.file || f.file.startsWith("src/") || !f.file.includes("/"));
  const counted = findings.filter((f) => counts(f.severity, sa.fail_on));
  return {
    ran: true, tool: "cppcheck", version: tool.version, path: tool.exe, command: `cppcheck ${args.join(" ")}`, fail_on: sa.fail_on,
    findings, counted: counted.length,
    by_severity: findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {}),
  };
}

// 게이트 판정 문장. 문제 없음이면 null.
function verdict(result, config) {
  const sa = config.static_analysis;
  if (!result.ran) return `[V-STATIC] 정적 분석을 하지 못함 — ${result.reason}`;
  if (!result.counted) return null;
  const top = result.findings.filter((f) => counts(f.severity, sa.fail_on)).slice(0, 5).map((f) => `${f.file}:${f.line} ${f.severity} ${f.id}`).join("; ");
  return `[V-STATIC] 정적 분석(${result.tool}) 지적 ${result.counted}건 (${sa.fail_on} 이상) — ${top}${result.counted > 5 ? " …" : ""}`;
}

module.exports = { FAIL_ON, RANK, findCppcheck, parseXml, run, verdict };
