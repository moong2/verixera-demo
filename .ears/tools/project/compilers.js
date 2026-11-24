/* 검증 환경의 C 컴파일러 고르기.
 *
 * 프로젝트 설정(project.json 의 build.compiler)에 컴파일러를 적는다. 설정 파일이 대상 프로젝트 폴더에 있으므로
 * 프로젝트를 GitHub 로 올리고 내려받거나 폴더째 옮겨도 같은 선택이 따라간다.
 *
 * CI(generated-artifact-verify.yml, release.yml)는 해시로 고정한 컨테이너 이미지(Debian 13 trixie) 하나를 쓰고,
 * 대상 프로젝트들이 고른 컴파일러를 그 이미지의 패키지 저장소에서 정확한 버전으로 설치한다(아래 apt 값).
 * 그 버전이 저장소에서 없어지면 조용히 다른 버전이 깔리지 않고 설치 단계가 실패한다.
 *   node tools/project/compilers.js --ci-packages targets   → 설치할 패키지 목록(한 줄)
 *
 * 게이트(run-gate.js)는 고른 컴파일러로 빌드하고, 실제로 쓴 컴파일러의 버전을 기록한다.
 * 고정 환경(CI)에서 고른 컴파일러가 없거나 버전이 다르면 게이트를 막는다. 이 PC 에서는 있는 컴파일러로 돌리고 경고만 한다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// 버전은 Debian 13(trixie) 의 패키지 버전이다(packages.debian.org/trixie 에서 확인, 2026-11-17).
// coverage: gcov 의 JSON 출력으로 구문·분기 커버리지를 잴 수 있는지. mcdc: 조건 커버리지(MC/DC)를 잴 수 있는지.
const CATALOG = [
  { id: "gcc-14", label: "GCC 14.2", family: "gcc", major: 14, cc: "gcc-14", gcov: "gcov-14", apt: [], builtin: true, coverage: true, mcdc: true,
    note: "CI 이미지에 들어 있는 기본 컴파일러. 구문·분기·MC/DC 커버리지를 모두 잽니다." },
  { id: "gcc-13", label: "GCC 13.3", family: "gcc", major: 13, cc: "gcc-13", gcov: "gcov-13", apt: ["gcc-13=13.3.0-16"], coverage: true, mcdc: false,
    note: "구문·분기 커버리지를 잽니다. MC/DC 는 gcc 14 이상에서만 잴 수 있습니다." },
  { id: "gcc-12", label: "GCC 12.4", family: "gcc", major: 12, cc: "gcc-12", gcov: "gcov-12", apt: ["gcc-12=12.4.0-5"], coverage: true, mcdc: false,
    note: "구문·분기 커버리지를 잽니다. MC/DC 는 gcc 14 이상에서만 잴 수 있습니다." },
  { id: "clang-19", label: "Clang 19.1", family: "clang", major: 19, cc: "clang-19", gcov: null, apt: ["clang-19=1:19.1.7-3"], coverage: false, mcdc: false,
    note: "빌드·시험·정적 분석만 합니다. 커버리지는 gcc 계열을 골라야 잴 수 있습니다." },
  { id: "clang-18", label: "Clang 18.1", family: "clang", major: 18, cc: "clang-18", gcov: null, apt: ["clang-18=1:18.1.8-18"], coverage: false, mcdc: false,
    note: "빌드·시험·정적 분석만 합니다. 커버리지는 gcc 계열을 골라야 잴 수 있습니다." },
  { id: "clang-17", label: "Clang 17.0", family: "clang", major: 17, cc: "clang-17", gcov: null, apt: ["clang-17=1:17.0.6-22"], coverage: false, mcdc: false,
    note: "빌드·시험·정적 분석만 합니다. 커버리지는 gcc 계열을 골라야 잴 수 있습니다." },
];
const DEFAULT = "gcc-14";
const IMAGE_OS = "Debian 13 (trixie)";

const of = (id) => CATALOG.find((c) => c.id === id) || null;

// 실행해 보고 주 버전을 읽는다. 없거나 실행되지 않으면 null.
function probe(cmd, env) {
  if (!cmd) return null;
  try {
    const r = spawnSync(cmd, ["-dumpversion"], { env: env || process.env, encoding: "utf8", timeout: 10000 });
    if (r.error || r.status !== 0) return null;
    const v = String(r.stdout).trim();
    return { version: v, major: parseInt(v, 10) || 0 };
  } catch (_) { return null; }
}

// 게이트가 쓸 컴파일러를 정한다.
//   config: 검증한 project.json, tools: toolchain.detect() 결과, env: 빌드 명령의 환경, pinned: 고정 환경(CI)인지
// 결과: { id, chosen, cc, gcov, major, family, coverage, mcdc, used: "chosen"|"fallback", problem, note }
function resolve(config, tools, env, options) {
  const o = options || {};
  const id = (config && config.build && config.build.compiler) || DEFAULT;
  const chosen = of(id) || of(DEFAULT);
  const run = o.probe || probe;
  const got = run(chosen.cc, env);
  if (got) {
    const out = { id: chosen.id, chosen, cc: chosen.cc, gcov: chosen.gcov, family: chosen.family, major: got.major, version: got.version, coverage: chosen.coverage, mcdc: chosen.mcdc && got.major >= 14, used: "chosen", problem: null, note: null };
    if (got.major !== chosen.major) {
      const msg = `선택한 컴파일러 ${chosen.label} 대신 ${chosen.cc} ${got.version} 이(가) 있음 — 주 버전이 다름`;
      if (o.pinned) out.problem = msg; else out.note = msg;
    }
    return out;
  }
  // 고른 컴파일러가 없다. 고정 환경(CI)이면 막고, 이 PC 면 찾은 컴파일러로 돌리되 그 사실을 남긴다.
  const fallbackCc = (env && env.CC) || (tools && tools.cc) || "cc";
  const fb = run(fallbackCc, env);
  const isClang = /clang/i.test(fallbackCc);
  const msg = `선택한 컴파일러 ${chosen.label}(${chosen.cc})가 이 환경에 없음`;
  return {
    id: chosen.id, chosen, cc: fallbackCc, gcov: isClang ? null : (tools && tools.gcov) || "gcov", family: isClang ? "clang" : "gcc",
    major: fb ? fb.major : 0, version: fb ? fb.version : null, coverage: !isClang, mcdc: !isClang && Boolean(fb && fb.major >= 14), used: "fallback",
    problem: o.pinned ? `${msg} — CI 설치 단계(node tools/project/compilers.js --ci-packages)를 확인` : null,
    note: o.pinned ? null : `${msg} — 이 PC 의 ${fallbackCc}${fb ? ` ${fb.version}` : ""} 로 실행함. 판정 증거는 CI 의 고정 환경 결과를 쓴다`,
  };
}

// 대상 프로젝트들(targets/*/project.json)이 고른 컴파일러를 CI 에 설치할 패키지(정확한 버전)로 모은다.
// 설정이 없거나 고르지 않았으면 기본(이미지 내장)이라 설치할 것이 없다.
function ciPackages(targetsDir) {
  const pkgs = new Set();
  const used = [];
  let dirs = [];
  try { dirs = fs.readdirSync(targetsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch (_) { /* 대상 폴더 없음 */ }
  for (const name of dirs) {
    const file = path.join(targetsDir, name, "project.json");
    if (!fs.existsSync(file)) continue;
    let id = DEFAULT;
    try { const j = JSON.parse(fs.readFileSync(file, "utf8")); id = (j.build && j.build.compiler) || DEFAULT; } catch (_) { /* 깨진 설정은 게이트가 따로 알린다 */ }
    const c = of(id);
    if (!c) throw new Error(`${name}/project.json: 모르는 컴파일러 '${id}' — ${CATALOG.map((x) => x.id).join(", ")} 중 하나`);
    used.push(`${name}: ${c.label}`);
    for (const p of c.apt) pkgs.add(p);
  }
  return { packages: [...pkgs].sort(), used };
}

// 화면에 보여 줄 목록
const list = () => CATALOG.map(({ id, label, family, major, builtin, coverage, mcdc, note, apt }) => ({ id, label, family, major, builtin: Boolean(builtin), coverage, mcdc, note, package: apt[0] || null }));

module.exports = { CATALOG, DEFAULT, IMAGE_OS, of, probe, resolve, ciPackages, list };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--ci-packages");
  if (i < 0) { console.error("사용법: node tools/project/compilers.js --ci-packages <targets 폴더> [--list]"); process.exitCode = 2; }
  else {
    try {
      const r = ciPackages(args[i + 1] || "targets");
      if (args.includes("--list")) for (const u of r.used) console.error(u);
      process.stdout.write(r.packages.join(" ") + "\n");
    } catch (e) { console.error(e.message); process.exitCode = 2; }
  }
}
