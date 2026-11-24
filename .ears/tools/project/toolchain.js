/* 빌드 도구 찾기: make, C 컴파일러, gcov, 그리고 Makefile 의 명령을 실행할 셸.
 *
 * CI 컨테이너(Linux)에는 make·cc 가 PATH 에 있으므로 아무것도 바꾸지 않는다.
 * Windows PC 에서는 이름과 위치가 다르다(mingw32-make, gcc, 셸 없음). 그래서 다음 순서로 찾아,
 * 이 프로세스가 띄우는 빌드 명령의 PATH 에만 더한다(시스템이나 사용자의 PATH 설정은 바꾸지 않는다).
 *   1. TOOLCHAIN_PATH 환경변수(.env 에 적을 수 있다. 폴더 여러 개는 ; 로 구분)
 *   2. 이미 PATH 에 있는 것
 *   3. winget 으로 설치한 WinLibs(GCC), Git 에 들어 있는 셸(sh)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const isWin = process.platform === "win32";
const exe = (name) => (isWin ? `${name}.exe` : name);

function findIn(dirs, name) {
  for (const d of dirs) { if (d && fs.existsSync(path.join(d, exe(name)))) return d; }
  return null;
}

function candidateDirs(env) {
  const dirs = [];
  if (env.TOOLCHAIN_PATH) dirs.push(...String(env.TOOLCHAIN_PATH).split(path.delimiter).map((s) => s.trim()).filter(Boolean));
  if (!isWin) return dirs;
  const local = env.LOCALAPPDATA;
  if (local) {
    const pk = path.join(local, "Microsoft", "WinGet", "Packages");
    try {
      for (const d of fs.readdirSync(pk).filter((n) => /winlibs/i.test(n)).sort().reverse()) dirs.push(path.join(pk, d, "mingw64", "bin"));
    } catch (_) { /* winget 패키지 폴더가 없음 */ }
  }
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], local && path.join(local, "Programs")]) if (base) dirs.push(path.join(base, "Git", "usr", "bin"));
  return dirs;
}

let cached = null;

// 찾은 도구. make·cc 는 명령 이름(없으면 null), path 는 빌드 명령의 PATH 앞에 더할 폴더들.
function detect(env) {
  const e = env || process.env;
  if (!env && cached) return cached;
  const onPath = String(e.PATH || e.Path || "").split(path.delimiter).filter(Boolean);
  const extra = candidateDirs(e);
  const add = [];
  const pick = (names) => {
    for (const n of names) {
      if (findIn(onPath, n)) return n;
      const d = findIn(extra, n);
      if (d) { if (!add.includes(d)) add.push(d); return n; }
    }
    return null;
  };
  const make = pick(["make", "mingw32-make"]);
  const cc = pick(["cc", "gcc", "clang"]);
  const gcov = pick(["gcov"]);
  const sh = isWin ? pick(["sh"]) : "sh";
  const out = { make, cc, gcov, sh, path: add, missing: [make ? null : "make", cc ? null : "C 컴파일러(cc)", sh ? null : "셸(sh)"].filter(Boolean) };
  out.available = out.missing.length === 0;
  out.env = (base) => {
    const b = Object.assign({}, base || process.env);
    if (add.length) { const key = Object.keys(b).find((k) => k.toUpperCase() === "PATH") || "PATH"; b[key] = [...add, b[key] || ""].join(path.delimiter); }
    // make 의 기본 CC 는 cc 다. cc 라는 이름의 컴파일러가 없으면 찾은 컴파일러를 쓰게 한다.
    if (cc && cc !== "cc" && !b.CC) b.CC = cc;
    return b;
  };
  // 컴파일러의 주 버전(조건 커버리지 지원 여부 판단용). 알 수 없으면 0.
  out.ccMajor = () => {
    if (!cc) return 0;
    try {
      const r = spawnSync(cc, ["-dumpversion"], { env: out.env(e), encoding: "utf8", timeout: 10000 });
      return r.status === 0 ? parseInt(String(r.stdout).trim(), 10) || 0 : 0;
    } catch (_) { return 0; }
  };
  if (!env) cached = out;
  return out;
}

// 도구를 새로 설치한 뒤 다시 찾게 한다.
function reset() { cached = null; }

module.exports = { detect, reset };
