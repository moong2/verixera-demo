/* 확장: 빌드·검증에 쓰는 도구(컴파일러, 빌드 도구, 정적 분석기)가 이 PC 에 있는지 보고, 없으면 설치한다.
 *
 * VS Code 의 확장처럼 목록에서 골라 설치한다. 다만 이 앱이 설치하는 것은 아래 목록에 정해 둔 패키지뿐이다
 * (화면이나 요청에서 받은 이름·명령을 실행하지 않는다).
 *  - Windows: winget(Windows 패키지 관리자)으로 설치한다. 설치 프로그램에 따라 Windows 의 권한 확인 창이 뜰 수 있다.
 *  - 그 밖의 OS: 설치하지 않고, 사용자가 터미널에서 실행할 명령을 보여 준다.
 * 설치는 한 번에 하나만 하고, 진행 상태는 이 서버 메모리에만 둔다.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const toolchain = require("./toolchain.js");

const isWin = process.platform === "win32";

// 목록. detect: 이 실행 파일 가운데 하나가 있으면 설치된 것으로 본다(앞의 것의 버전을 읽는다).
const CATALOG = [
  {
    id: "gcc", name: "GCC · make (WinLibs)", category: "컴파일러",
    purpose: "C 컴파일러(gcc), 빌드 도구(make), 커버리지(gcov). '빌드·시험'과 게이트에 필요합니다. gcc 14 이상이면 MC/DC 도 잽니다.",
    detect: ["gcc", "mingw32-make", "make"], versionOf: "gcc",
    winget: "BrechtSanders.WinLibs.POSIX.UCRT", home: "https://winlibs.com/", license: "GCC 등 구성 요소마다 다름(GPL 계열)",
    other: { linux: "sudo apt install build-essential", mac: "xcode-select --install" },
    dirs: () => [],
  },
  {
    id: "cmake", name: "CMake", category: "빌드 도구",
    purpose: "CMakeLists.txt 로 빌드하는 프로젝트에 필요합니다. Makefile 만 쓰면 없어도 됩니다.",
    detect: ["cmake"], versionOf: "cmake",
    winget: "Kitware.CMake", home: "https://cmake.org/", license: "BSD-3-Clause",
    other: { linux: "sudo apt install cmake", mac: "brew install cmake" },
    dirs: (e) => [e.ProgramFiles && path.join(e.ProgramFiles, "CMake", "bin")],
  },
  {
    id: "cppcheck", name: "Cppcheck", category: "정적 분석",
    purpose: "C 코드 정적 분석기. 정적 검증 문서가 정한 검사(초기화 안 된 변수, 범위 밖 접근 등)를 돌리는 데 쓸 수 있습니다.",
    detect: ["cppcheck"], versionOf: "cppcheck",
    winget: "Cppcheck.Cppcheck", home: "https://cppcheck.sourceforge.io/", license: "GPL-3.0",
    other: { linux: "sudo apt install cppcheck", mac: "brew install cppcheck" },
    dirs: (e) => [e.ProgramFiles && path.join(e.ProgramFiles, "Cppcheck")],
  },
  {
    id: "llvm", name: "LLVM (clang · clang-tidy)", category: "컴파일러 · 정적 분석",
    purpose: "두 번째 C 컴파일러(clang)와 정적 분석기(clang-tidy). 다른 컴파일러로도 같은 결과가 나오는지 볼 때 씁니다.",
    detect: ["clang", "clang-tidy"], versionOf: "clang",
    winget: "LLVM.LLVM", home: "https://llvm.org/", license: "Apache-2.0 WITH LLVM-exception",
    other: { linux: "sudo apt install clang clang-tidy", mac: "brew install llvm" },
    dirs: (e) => [e.ProgramFiles && path.join(e.ProgramFiles, "LLVM", "bin")],
  },
];

const exe = (name) => (isWin ? `${name}.exe` : name);

function searchDirs(item, env) {
  const onPath = String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const tc = toolchain.detect(env);
  return [...onPath, ...tc.path, ...item.dirs(env).filter(Boolean)];
}

function firstLine(text) { return String(text || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || ""; }

// 설치되어 있는지와 버전. 버전은 '--version' 의 첫 줄에서 숫자를 뽑는다.
function inspect(item, env) {
  const dirs = searchDirs(item, env);
  const found = [];
  for (const name of item.detect) {
    const dir = dirs.find((d) => { try { return fs.existsSync(path.join(d, exe(name))); } catch (_) { return false; } });
    if (dir) found.push({ name, dir });
  }
  if (!found.length) return { installed: false, version: "", where: "" };
  const main = found.find((f) => f.name === item.versionOf) || found[0];
  let version = "";
  try {
    const r = spawnSync(path.join(main.dir, exe(main.name)), ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    const m = /(\d+\.\d+(?:\.\d+)?)/.exec(firstLine(r.stdout || r.stderr));
    version = m ? m[1] : "";
  } catch (_) { /* 버전을 읽지 못해도 설치된 것으로 본다 */ }
  return { installed: true, version, where: main.dir, tools: found.map((f) => f.name) };
}

// options.run(cmd, args) → Promise<{ code, output }> (시험에서 가짜로 바꾼다), options.platform, options.env, options.wingetAvailable
function createExtensions(options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  const env = () => opts.env || process.env;
  const run = opts.run || ((cmd, args) => new Promise((resolve) => {
    let output = "";
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, env: env() }); } catch (e) { resolve({ code: -1, output: e.message }); return; }
    const keep = (c) => { output = (output + c).slice(-20000); };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* 이미 끝남 */ } }, 30 * 60 * 1000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, output: output + e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  }));
  let wingetChecked = opts.wingetAvailable;
  const hasWinget = () => {
    if (platform !== "win32") return false;
    if (wingetChecked === undefined) {
      try { wingetChecked = spawnSync("winget", ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true }).status === 0; } catch (_) { wingetChecked = false; }
    }
    return wingetChecked;
  };
  const inspectFn = opts.inspect || inspect;
  let job = null;   // { id, state: "running"|"done"|"failed", started_at, finished_at, code, log }
  const listeners = [];

  function list() {
    const e = env();
    const canInstall = hasWinget();
    return {
      platform, can_install: canInstall,
      installer: platform === "win32" ? (canInstall ? "winget" : "winget 없음") : "직접 설치",
      items: CATALOG.map((item) => {
        const s = inspectFn(item, e);
        const command = platform === "win32" ? `winget install --id ${item.winget} -e` : platform === "darwin" ? item.other.mac : item.other.linux;
        return {
          id: item.id, name: item.name, category: item.category, purpose: item.purpose, home: item.home, license: item.license,
          installed: s.installed, version: s.version, where: s.where, tools: s.tools || [], command,
          job: job && job.id === item.id ? { state: job.state, started_at: job.started_at, finished_at: job.finished_at || null, code: job.code === undefined ? null : job.code, log: job.log || "" } : null,
        };
      }),
      busy: Boolean(job && job.state === "running"),
    };
  }

  // 설치를 시작한다(끝날 때까지 기다리지 않는다). 상태는 list() 의 job 으로 본다.
  function install(id) {
    const item = CATALOG.find((x) => x.id === id);
    if (!item) return { error: "목록에 없는 확장입니다.", status: 404 };
    if (platform !== "win32") return { error: `이 OS 에서는 앱이 설치하지 않습니다. 터미널에서 실행하세요: ${platform === "darwin" ? item.other.mac : item.other.linux}`, status: 501 };
    if (!hasWinget()) return { error: "winget(Windows 패키지 관리자)이 없어 설치할 수 없습니다. Microsoft Store 의 '앱 설치 관리자'를 설치하거나, 제작처 사이트에서 직접 설치하세요.", status: 501 };
    if (job && job.state === "running") return { error: `${job.id} 설치가 진행 중입니다. 끝난 뒤 다시 시도하세요.`, status: 409 };
    job = { id, state: "running", started_at: new Date().toISOString(), log: "" };
    const mine = job;
    const args = ["install", "--id", item.winget, "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"];
    Promise.resolve().then(() => run("winget", args)).then((r) => r, (e) => ({ code: -1, output: e.message })).then((r) => {
      mine.code = r.code;
      // winget 의 진행 표시(돌아가는 막대)는 지우고 마지막 몇 줄만 남긴다.
      mine.log = String(r.output || "").replace(/\r/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l && !/^[\s\-\\|/█▒░]+$/.test(l)).slice(-12).join("\n");
      mine.state = r.code === 0 ? "done" : "failed";
      mine.finished_at = new Date().toISOString();
      for (const f of listeners) { try { f(mine); } catch (_) { /* 알림 실패는 무시 */ } }
    });
    return { started: true, id, command: `winget ${args.join(" ")}` };
  }

  return { list, install, onFinished: (f) => listeners.push(f) };
}

module.exports = { CATALOG, createExtensions, inspect };
