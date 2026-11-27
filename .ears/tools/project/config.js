/* 프로젝트 설정(도메인·안전 등급·빌드 옵션·코딩 규칙·시험 도출 방법·커버리지 기준).
 *
 * 대상 프로젝트마다 targets/<이름>/project.json 하나를 두고, 같은 설정을 세 곳에서 쓴다.
 *  - AI 에이전트: 코드 에이전트는 코딩 규칙을, 시험 에이전트는 시험 도출 방법을 지시로 받는다
 *  - 빌드: 게이트가 컴파일 옵션을 CC·CFLAGS 환경변수로 시험 명령(make)에 넘긴다
 *  - 게이트: 코딩 규칙 점검, 시험 도출 방법 표기 점검, 커버리지 기준 판정
 *
 * 등급(level): "required" 는 어기면 게이트 실패, "recommended" 는 경고, "off" 는 적용하지 않음.
 *
 * 도메인(자동차·항공우주·철도·의료기기·산업제어·일반)마다 표준과 등급 체계가 다르다. 등급별 초기값은 각 표준을 참고해
 * 잡은 것이며 표준 원문과 대조해 확인한 값이 아니다. 프로젝트의 안전 계획에 맞게 고쳐서 쓴다.
 * 도메인 사이의 등급(ASIL·DAL·SIL·Class)은 서로 환산하지 않는다. 도메인을 바꾸면 그 도메인의 초기값으로 다시 시작한다.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = "project-config/v1";
const FILE = "project.json";
const LEVELS = ["required", "recommended", "off"];
const ASILS = ["QM", "A", "B", "C", "D"];
const C_STANDARDS = ["c99", "c11", "c17"];
// 작업 모드(D-009): 설계 승인과 게이트를 등급이 아니라 이것으로 정한다.
//  prototype   설계 승인 선택, 코드는 초안만, 정식 검증·릴리스 불가
//  engineering 승인된 설계 Baseline(DBL)이 있어야 정식 코드·시험 생성, 게이트 T13~T17 적용
//  safety      engineering + 도메인 추가 조건(차후)
//  legacy      예전 방식(T0~T12 만). design_policy 가 없는 기존 프로젝트만 이것으로 본다
// 새로 만드는 프로젝트(defaultConfig)는 engineering. 저장할 때 값이 빠져 있으면 파일의 값을 지킨다(생략으로 낮아지지 않게).
const DESIGN_POLICIES = ["prototype", "engineering", "safety", "legacy"];
const DESIGN_POLICY_LABELS = { prototype: "프로토타입", engineering: "엔지니어링", safety: "안전", legacy: "레거시" };
const NEW_PROJECT_POLICY = "engineering";
const policyOf = (config) => (config && DESIGN_POLICIES.includes(config.design_policy) ? config.design_policy : "legacy");
const designRequired = (policy) => policy === "engineering" || policy === "safety";
// 코드 에이전트에 적용하는 C 코딩 스킬(docs/coding-rules/<이름>/SKILL.md). 도메인마다 고른다.
// 항공우주와 산업·철도·의료 스킬은 자동차 스킬의 생성 제약(G01–G15)과 코드 계약 템플릿을 함께 쓰라고 하므로 둘을 같이 준다.
// 도메인 설정이 없거나 '일반'이면 도메인 미지정 기본 프로파일(GEN-BASE).
const SKILLS_DIR = "docs/coding-rules";
const SKILLS_BY_DOMAIN = {
  automotive: ["automotive-c-coding-rules"],
  aerospace: ["aerospace-space-c-coding-rules", "automotive-c-coding-rules"],
  railway: ["industrial-rail-medical-c-coding-rules", "automotive-c-coding-rules"],
  medical: ["industrial-rail-medical-c-coding-rules", "automotive-c-coding-rules"],
  industrial: ["industrial-rail-medical-c-coding-rules", "automotive-c-coding-rules"],
  general: ["general-c-coding-rules"],
};
const skillsFor = (config) => SKILLS_BY_DOMAIN[config && config.domain] || SKILLS_BY_DOMAIN.general;

// 정적 분석: 어느 심각도부터 지적으로 셀지(tools/project/static-analysis.js).
const STATIC_FAIL_ON = ["error", "warning", "style"];
const BASIS = "ISO 26262-6:2018 권고표를 바탕으로 한 초기값 — 표준 원문과 프로젝트 안전 계획으로 확인 필요";

// check: 이 도구가 지키는지 확인하는 방법. source = 소스 점검기, compiler = 컴파일 경고(오류 처리), review = 자동 확인 없음(AI 지시와 사람 검토).
const CODING_RULES = [
  { id: "single_exit", label: "함수의 출구는 하나", check: "source", prompt: "함수마다 return 문은 끝에 하나만 둔다." },
  { id: "no_dynamic_memory", label: "동적 메모리 금지", check: "source", prompt: "malloc·calloc·realloc·free 등 동적 메모리를 쓰지 않는다." },
  { id: "initialize_variables", label: "변수 초기화", check: "compiler", flags: ["-Wuninitialized"], prompt: "모든 변수는 선언하면서 초기화한다." },
  { id: "no_duplicate_names", label: "같은 이름 겹쳐 쓰기 금지", check: "compiler", flags: ["-Wshadow"], prompt: "바깥 범위의 이름을 안쪽에서 다시 선언하지 않는다." },
  { id: "limit_globals", label: "전역 변수 제한", check: "source", prompt: "전역 변수(상수 제외)를 만들지 않는다. 꼭 필요하면 설계 문서에 이유를 적는다." },
  { id: "restrict_pointers", label: "포인터 사용 제한", check: "review", prompt: "포인터는 인터페이스에 꼭 필요한 곳에만 쓰고 포인터 연산은 하지 않는다." },
  { id: "no_implicit_conversion", label: "암시적 형 변환 금지", check: "compiler", flags: ["-Wconversion", "-Wsign-conversion"], prompt: "크기나 부호가 다른 형 사이의 변환은 명시적 캐스트로 쓰고, 범위를 먼저 확인한다." },
  { id: "no_hidden_flow", label: "숨은 데이터·제어 흐름 금지", check: "review", prompt: "매크로로 흐름을 숨기지 않고, 함수는 인자와 반환값으로만 주고받는다." },
  { id: "no_goto", label: "goto·비지역 분기 금지", check: "source", prompt: "goto, setjmp, longjmp 를 쓰지 않는다." },
  { id: "no_recursion", label: "재귀 금지", check: "source", prompt: "재귀 호출을 쓰지 않는다." },
  { id: "misra_c_2012", label: "MISRA C:2012", check: "review", prompt: "MISRA C:2012 지침을 따른다(고정 폭 정수형 사용, 부작용 있는 식을 조건에 쓰지 않기, 모든 switch 에 default 등)." },
];

// tag: 시험 주석의 @method 값.
const TEST_METHODS = [
  { id: "requirements_analysis", tag: "requirement", label: "요구사항 분석", prompt: "수용 기준마다 그 기준을 직접 확인하는 시험을 만든다." },
  { id: "equivalence_classes", tag: "equivalence", label: "동등 분할", prompt: "입력을 동작이 같은 구간(유효·무효 포함)으로 나누고, 구간마다 대표값 하나로 시험한다." },
  { id: "boundary_values", tag: "boundary", label: "경계값 분석", prompt: "임계값마다 경계 바로 아래·경계·경계 바로 위를 시험하고, 자료형의 최소·최대값도 시험한다." },
  { id: "error_guessing", tag: "error-guessing", label: "오류 추정", prompt: "틀리기 쉬운 경우(무효 입력, 0, 음수, 범위 초과, 상태가 뒤바뀐 순서)를 시험한다." },
  { id: "interface_test", tag: "interface", label: "인터페이스 시험", prompt: "헤더에 선언된 인자·반환값의 범위와 무효 인자에 대한 동작을 시험한다." },
  { id: "fault_injection", tag: "fault-injection", label: "결함 주입", prompt: "오류 상태(센서 무효, 통신 끊김 등)를 입력으로 넣어 안전 쪽 동작을 확인한다." },
];

const COVERAGE_METRICS = [
  { id: "statement", label: "구문 커버리지" },
  { id: "branch", label: "분기 커버리지" },
  { id: "mcdc", label: "MC/DC" },
];

// ASIL A·B·C·D 순서의 초기 등급. R = required, r = recommended, - = off.
const PROFILE = {
  coding_rules: {
    single_exit: "RRRR", no_dynamic_memory: "rRRR", initialize_variables: "RRRR", no_duplicate_names: "RRRR", limit_globals: "rrRR",
    restrict_pointers: "rRRR", no_implicit_conversion: "rRRR", no_hidden_flow: "rRRR", no_goto: "RRRR", no_recursion: "rrRR", misra_c_2012: "RRRR",
  },
  test_design: { requirements_analysis: "RRRR", equivalence_classes: "rRRR", boundary_values: "rRRR", error_guessing: "rrrr", interface_test: "RRRR", fault_injection: "rrrR" },
  coverage: { statement: "RRrr", branch: "rRRR", mcdc: "rrrR" },
};
// 도메인: 표준, 등급 체계, 등급별 초기값, AI 에게 주는 도메인 지침.
//  defaults[등급] = [코딩 규칙·시험 도출 방법의 초기값 묶음(0~4), 커버리지 초기값(구문·분기·MC/DC 순서, R/r/-)]
//  초기값 묶음 0 은 '모두 권장', 1~4 는 위 PROFILE 의 네 열이다. 묶음 번호가 같다고 해서 등급이 같다는 뜻은 아니다.
const basisOf = (standard) => `${standard} 을 참고해 잡은 초기값 — 표준 원문과 프로젝트의 안전·인증 계획으로 확인 필요. 다른 도메인의 등급과 환산한 값이 아님`;
const DOMAINS = {
  automotive: {
    label: "자동차", standard: "ISO 26262-6:2018", level_name: "ASIL", default_level: "B", basis: BASIS,
    levels: [["QM", "QM"], ["A", "ASIL A"], ["B", "ASIL B"], ["C", "ASIL C"], ["D", "ASIL D"]],
    defaults: { QM: [0, "---"], A: [1, "Rrr"], B: [2, "RRr"], C: [3, "rRr"], D: [4, "rRR"] },
    notes: {
      code: ["안전 요구사항을 구현한 함수는 입력의 유효 범위를 먼저 확인하고, 유효하지 않으면 요구사항이 정한 안전 쪽 동작을 한다.", "안전 등급이 다른 기능을 한 함수에 섞지 않는다. 섞어야 하면 설계 문서에 이유를 적는다."],
      test: ["안전 요구사항마다 고장 상태(무효 입력, 범위 초과)에서 안전 쪽 동작으로 가는지 확인하는 시험을 둔다."],
    },
  },
  aerospace: {
    label: "항공우주", standard: "DO-178C", level_name: "DAL", default_level: "C", basis: basisOf("DO-178C"),
    levels: [["E", "DAL E"], ["D", "DAL D"], ["C", "DAL C"], ["B", "DAL B"], ["A", "DAL A"]],
    defaults: { E: [0, "---"], D: [1, "---"], C: [2, "R--"], B: [3, "RR-"], A: [4, "RRR"] },
    notes: {
      code: ["모든 코드는 요구사항에서 나와야 한다. 요구사항에 없는 기능, 실행될 수 없는 코드(dead code), 쓰지 않는 분기를 만들지 않는다.", "쓰지 않고 남겨 둔 코드(deactivated code)가 필요하면 설계 문서에 그 이유와 비활성 조건을 적는다.", "실행 순서와 자원 사용이 예측 가능해야 한다. 동적 메모리, 재귀, 무한 반복을 쓰지 않는다."],
      test: ["시험은 요구사항에서 도출한다. 정상 범위 시험과 강건성 시험(범위 밖 값, 무효 입력, 비정상 상태)을 구분해 둘 다 만든다.", "구조적 커버리지는 요구사항 기반 시험으로 채운다. 커버리지를 채우려고 코드 구조에서 시험을 만들지 않는다. 덮이지 않는 코드는 빠진 요구사항이나 불필요한 코드일 수 있으므로 질문으로 돌려준다."],
    },
  },
  railway: {
    label: "철도", standard: "EN 50716:2023", level_name: "SIL", default_level: "2", basis: basisOf("EN 50716:2023"),
    levels: [["basic", "Basic Integrity"], ["1", "SIL 1"], ["2", "SIL 2"], ["3", "SIL 3"], ["4", "SIL 4"]],
    defaults: { basic: [0, "---"], 1: [1, "Rr-"], 2: [2, "Rr-"], 3: [3, "RRr"], 4: [4, "RRr"] },
    notes: {
      code: ["방어적으로 작성한다. 입력과 중간 결과의 범위를 확인하고, 확인에 실패하면 요구사항이 정한 안전 쪽(fail-safe) 상태로 간다.", "구조적 프로그래밍을 따른다. 모듈은 작게, 인터페이스는 명시적으로 두고, 모듈 사이의 숨은 결합을 만들지 않는다."],
      test: ["경계값과 동등 분할로 입력 공간을 나누어 시험하고, 고장 입력에서 안전 쪽 상태로 가는지 확인한다."],
    },
  },
  medical: {
    label: "의료기기", standard: "IEC 62304:2006+A1:2015", level_name: "Class", default_level: "B", basis: basisOf("IEC 62304") + ". 이 표준은 구조적 커버리지 수치를 정하지 않으므로 커버리지 기준은 제조자의 정책으로 정한다",
    levels: [["A", "Class A"], ["B", "Class B"], ["C", "Class C"]],
    defaults: { A: [0, "---"], B: [2, "rr-"], C: [3, "Rr-"] },
    notes: {
      code: ["위험 통제 수단을 구현하는 함수는 설계 문서의 그 설계 항목에 '위험 통제'라고 적고, 어떤 위해 상황을 막는지 함께 적는다.", "외부에서 가져온 소프트웨어(SOUP)를 새로 끌어들이지 않는다. 표준 라이브러리 밖의 것이 필요하면 구현하지 말고 질문으로 돌려준다."],
      test: ["위험 통제 수단마다 그것이 동작하는지 확인하는 시험을 둔다. 경고·차단·정지 같은 보호 동작은 걸리는 조건과 걸리지 않는 조건을 모두 시험한다."],
    },
  },
  industrial: {
    label: "산업제어·로봇", standard: "IEC 61508-3:2010", level_name: "SIL", default_level: "2", basis: basisOf("IEC 61508-3:2010"),
    levels: [["1", "SIL 1"], ["2", "SIL 2"], ["3", "SIL 3"], ["4", "SIL 4"]],
    defaults: { 1: [1, "rrr"], 2: [2, "Rrr"], 3: [3, "RRr"], 4: [4, "RRR"] },
    notes: {
      code: ["안전 기능은 방어적으로 작성한다. 입력의 유효성과 범위를 확인하고, 고장을 감지하면 요구사항이 정한 안전 상태로 간다.", "언어의 제한된 부분집합만 쓴다. 정의되지 않은 동작이나 구현에 따라 달라지는 동작에 기대지 않는다."],
      test: ["안전 기능마다 요구된 동작과 고장 시 동작을 모두 시험한다. 경계값과 고장 입력을 포함한다."],
    },
  },
  general: {
    label: "일반 (안전 표준 없음)", standard: "", level_name: "엄격도", default_level: "medium", basis: "특정 안전 표준을 따르지 않는 프로젝트의 초기값 — 팀의 개발 규칙에 맞게 고쳐서 쓴다",
    levels: [["low", "엄격도 낮음"], ["medium", "엄격도 보통"], ["high", "엄격도 높음"]],
    defaults: { low: [0, "---"], medium: [1, "r--"], high: [3, "RR-"] },
    notes: { code: [], test: [] },
  },
};
const domainOf = (id) => (typeof id === "string" && Object.prototype.hasOwnProperty.call(DOMAINS, id) ? DOMAINS[id] : null);
const hasLevel = (d, level) => typeof level === "string" && d.levels.some(([id]) => id === level);
// 설정의 등급을 사람이 읽는 말로: "ASIL B", "DAL A", "SIL 3", "Class C".
function levelText(config) {
  const d = domainOf(config.domain) || DOMAINS.automotive;
  const id = config.level !== undefined ? config.level : config.asil;
  const found = d.levels.find(([x]) => x === id);
  return found ? found[1] : String(id || "");
}

const compilers = require("./compilers.js");

const BASE_WARNINGS = ["-Wall", "-Wextra", "-Wpedantic", "-Wstrict-prototypes", "-Wmissing-prototypes", "-Wundef"];
const levelOf = (code) => ({ R: "required", r: "recommended", "-": "off" }[code]);

// 그 도메인·등급의 초기 설정. 도메인을 주지 않으면 자동차(이전 형식과 같다). 모르는 등급은 그 도메인의 기본 등급으로 본다.
function defaultConfig(level, domain) {
  const dom = domainOf(domain) ? domain : "automotive";
  const d = DOMAINS[dom];
  const lv = hasLevel(d, level) ? level : d.default_level;
  const [preset, cov] = d.defaults[lv];
  const pick = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, preset === 0 ? "recommended" : levelOf(v[preset - 1])]));
  const coverage = Object.fromEntries(COVERAGE_METRICS.map((m, i) => [m.id, { level: levelOf(cov[i]), min: 100 }]));
  const test = pick(PROFILE.test_design);
  if (preset === 0) { test.requirements_analysis = "required"; test.fault_injection = "off"; }
  return Object.assign(
    { schema: SCHEMA, domain: dom, standard: d.standard, level: lv, design_policy: NEW_PROJECT_POLICY },
    dom === "automotive" ? { asil: lv } : {}, // 자동차는 이전 형식의 asil 도 함께 둔다
    { basis: d.basis, build: { compiler: compilers.DEFAULT, c_standard: "c11", warnings_as_errors: true, optimization: "-O0", extra_flags: [] }, coding_rules: pick(PROFILE.coding_rules), test_design: test, coverage,
      // 정적 분석은 기본으로 '권장'(경고만)이다. 도구가 없는 환경(CI 등)에서 게이트가 막히지 않게 하고, 필요하면 '필수'로 올린다.
      static_analysis: { level: "recommended", tool: "cppcheck", fail_on: "warning" }, timing: { call_period_ms: null },
      // 설계 규칙 프로파일(D-012) 기본값: 도메인의 첫 세부 프로파일과 그 표준, Embedded C, 등급 지정됨
      design_profile: (() => { const s = (require("./design-rules.js").SUBDOMAINS[dom] || [])[0]; return { subdomain: s ? s.id : "general-software", standards: s ? s.standards.slice() : [], environment: "embedded-c", level_status: "assigned" }; })() },
  );
}

// 추가 컴파일 옵션은 허용 목록에 맞는 것만 받는다. 이 값은 make 를 거쳐 셸 명령의 일부가 되므로
// 셸 문자나 출력 경로·플러그인·포함 경로를 바꾸는 옵션은 받지 않는다.
const FLAG_RE = /^(?:-W[a-z0-9][a-z0-9=+-]*|-f[a-z][a-z0-9=-]*|-O[0-3sg]|-g[0-3]?|-pedantic(?:-errors)?|-D[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z0-9_.]+)?)$/;
const FLAG_BLOCK = /^-f(?:plugin|profile-use|profile-generate|diagnostics-|dump|aux|pre-include|debug-prefix|file-prefix|macro-prefix)/;
const flagOk = (f) => typeof f === "string" && f.length <= 80 && FLAG_RE.test(f) && !FLAG_BLOCK.test(f) && !f.startsWith("-Wl,") && !f.startsWith("-Wa,") && !f.startsWith("-Wp,");

// 받은 값을 검사하고 정해진 형태로 다시 만든다. 모르는 항목은 버린다.
function validate(input) {
  const errors = [];
  const src = input && typeof input === "object" ? input : {};
  if (src.schema !== undefined && src.schema !== SCHEMA) errors.push(`지원하지 않는 형식입니다: ${src.schema}`);
  // 도메인이 없으면 자동차(이전 형식). 자동차는 asil 로도 등급을 받는다.
  const domainId = src.domain === undefined ? "automotive" : src.domain;
  if (!domainOf(domainId)) errors.push(`도메인(domain)은 ${Object.keys(DOMAINS).join(", ")} 중 하나여야 합니다.`);
  const dom = domainOf(domainId) ? domainId : "automotive";
  const d = DOMAINS[dom];
  const given = dom === "automotive" && src.asil !== undefined ? src.asil : src.level;
  if (!hasLevel(d, given)) {
    errors.push(dom === "automotive" ? `안전 등급(asil)은 ${ASILS.join(", ")} 중 하나여야 합니다.` : `${d.label} 도메인의 등급(level)은 ${d.levels.map(([id]) => id).join(", ")} 중 하나여야 합니다.`);
  }
  const base = defaultConfig(hasLevel(d, given) ? given : d.default_level, dom);
  const out = Object.assign({}, base);

  const b = src.build && typeof src.build === "object" ? src.build : {};
  const std = b.c_standard === undefined ? base.build.c_standard : b.c_standard;
  if (!C_STANDARDS.includes(std)) errors.push(`C 표준은 ${C_STANDARDS.join(", ")} 중 하나여야 합니다.`);
  const opt = b.optimization === undefined ? base.build.optimization : b.optimization;
  if (!/^-O[0-3sg]$/.test(String(opt))) errors.push("최적화 옵션은 -O0, -O1, -O2, -O3, -Os, -Og 중 하나여야 합니다.");
  const extra = Array.isArray(b.extra_flags) ? b.extra_flags : b.extra_flags === undefined ? [] : null;
  if (extra === null || extra.length > 30) errors.push("추가 컴파일 옵션은 30개 이하의 목록이어야 합니다.");
  const bad = (extra || []).filter((f) => !flagOk(f));
  if (bad.length) errors.push(`받을 수 없는 컴파일 옵션: ${bad.map(String).join(" ")} — 경고(-W…), 기능(-f…), 최적화(-O…), 디버그(-g), 매크로 정의(-D이름[=값])만 쓸 수 있습니다.`);
  // 검증 환경의 컴파일러(CI 가 이 값대로 설치·사용한다). 없으면 기본(CI 이미지 내장 gcc 14).
  const comp = b.compiler === undefined || b.compiler === null || b.compiler === "" ? compilers.DEFAULT : b.compiler;
  if (!compilers.of(comp)) errors.push(`컴파일러는 ${compilers.CATALOG.map((x) => x.id).join(", ")} 중 하나여야 합니다.`);
  out.build = { compiler: compilers.of(comp) ? comp : compilers.DEFAULT, c_standard: std, warnings_as_errors: b.warnings_as_errors === undefined ? true : Boolean(b.warnings_as_errors), optimization: String(opt), extra_flags: [...new Set((extra || []).filter(flagOk))] };

  const levels = (key, defs) => {
    const given = src[key] && typeof src[key] === "object" ? src[key] : {};
    const res = {};
    for (const d of defs) {
      const v = given[d.id] === undefined ? base[key][d.id] : given[d.id];
      if (!LEVELS.includes(v)) errors.push(`${d.label}: 등급은 ${LEVELS.join(", ")} 중 하나여야 합니다.`);
      res[d.id] = LEVELS.includes(v) ? v : "off";
    }
    return res;
  };
  out.coding_rules = levels("coding_rules", CODING_RULES);
  out.test_design = levels("test_design", TEST_METHODS);

  const cov = src.coverage && typeof src.coverage === "object" ? src.coverage : {};
  out.coverage = {};
  for (const m of COVERAGE_METRICS) {
    const g = cov[m.id] && typeof cov[m.id] === "object" ? cov[m.id] : base.coverage[m.id];
    const min = Number(g.min === undefined ? 100 : g.min);
    if (!LEVELS.includes(g.level)) errors.push(`${m.label}: 등급은 ${LEVELS.join(", ")} 중 하나여야 합니다.`);
    if (!(min >= 0 && min <= 100)) errors.push(`${m.label}: 기준은 0~100 사이여야 합니다.`);
    out.coverage[m.id] = { level: LEVELS.includes(g.level) ? g.level : "off", min: min >= 0 && min <= 100 ? Math.round(min * 10) / 10 : 100 };
  }
  const sa = src.static_analysis && typeof src.static_analysis === "object" ? src.static_analysis : base.static_analysis;
  const saLevel = sa.level === undefined ? base.static_analysis.level : sa.level;
  const saFail = sa.fail_on === undefined ? base.static_analysis.fail_on : sa.fail_on;
  if (!LEVELS.includes(saLevel)) errors.push(`정적 분석: 등급은 ${LEVELS.join(", ")} 중 하나여야 합니다.`);
  if (!STATIC_FAIL_ON.includes(saFail)) errors.push(`정적 분석: 기준 심각도는 ${STATIC_FAIL_ON.join(", ")} 중 하나여야 합니다.`);
  if (sa.tool !== undefined && sa.tool !== "cppcheck") errors.push("정적 분석: 도구는 지금 cppcheck 만 쓸 수 있습니다.");
  out.static_analysis = { level: LEVELS.includes(saLevel) ? saLevel : "off", tool: "cppcheck", fail_on: STATIC_FAIL_ON.includes(saFail) ? saFail : "warning" };
  // 호출 주기: 시간 대신 호출을 차례로 하는 시험(호출 순서)을 ms 로 보여 줄 때 한 호출의 간격. 비우면(0·null) 정하지 않음.
  const tm = src.timing && typeof src.timing === "object" ? src.timing : {};
  const per = tm.call_period_ms === undefined || tm.call_period_ms === null || tm.call_period_ms === "" || Number(tm.call_period_ms) === 0 ? null : Number(tm.call_period_ms);
  if (per !== null && !(per > 0 && per <= 600000)) errors.push("호출 주기는 0 보다 크고 600000 ms 이하인 수여야 합니다(비우면 정하지 않음).");
  // 작업 모드: 값이 없으면 legacy(이 값이 생기기 전의 프로젝트). 새 프로젝트는 defaultConfig 가 engineering 을 넣는다.
  const policy = src.design_policy === undefined || src.design_policy === null ? "legacy" : src.design_policy;
  if (!DESIGN_POLICIES.includes(policy)) errors.push(`작업 모드(design_policy)는 ${DESIGN_POLICIES.join(", ")} 중 하나여야 합니다.`);
  out.design_policy = DESIGN_POLICIES.includes(policy) ? policy : "legacy";
  // 설계 규칙 프로파일(D-012): 세부 프로파일·적용 표준(복수)·개발 환경·안전등급 지정 여부·조건부 승인 허용. 없으면 도메인 기본값.
  const dpIn = src.design_profile && typeof src.design_profile === "object" ? src.design_profile : {};
  const rules = require("./design-rules.js");
  const subs = rules.SUBDOMAINS[dom] || rules.SUBDOMAINS.general;
  if (dpIn.subdomain !== undefined && !subs.some((x) => x.id === dpIn.subdomain)) errors.push(`세부 프로파일(design_profile.subdomain)은 ${subs.map((x) => x.id).join(", ")} 중 하나여야 합니다.`);
  if (dpIn.environment !== undefined && !rules.ENVIRONMENTS.some((x) => x.id === dpIn.environment)) errors.push(`개발 환경(design_profile.environment)은 ${rules.ENVIRONMENTS.map((x) => x.id).join(", ")} 중 하나여야 합니다.`);
  if (dpIn.standards !== undefined && (!Array.isArray(dpIn.standards) || dpIn.standards.length > 10 || dpIn.standards.some((x) => typeof x !== "string" || !x.trim() || x.length > 80))) errors.push("적용 표준(design_profile.standards)은 80자 이하 글 10개 이하의 목록이어야 합니다.");
  if (dpIn.level_status !== undefined && !["assigned", "unassigned"].includes(dpIn.level_status)) errors.push("안전등급 지정 여부(design_profile.level_status)는 assigned 또는 unassigned 여야 합니다.");
  const sub = subs.find((x) => x.id === dpIn.subdomain) || subs[0];
  out.design_profile = {
    subdomain: sub.id,
    standards: Array.isArray(dpIn.standards) && dpIn.standards.length ? [...new Set(dpIn.standards.map((x) => String(x).trim()).filter(Boolean))].slice(0, 10) : sub.standards.slice(),
    environment: rules.ENVIRONMENTS.some((x) => x.id === dpIn.environment) ? dpIn.environment : "embedded-c",
    level_status: dpIn.level_status === "unassigned" ? "unassigned" : "assigned",
  };
  // 조건부 승인 허용: 정한 때만 남긴다. 정하지 않으면 쓰는 곳에서 작업 모드로 정한다(safety 는 불허, 그 밖은 허용).
  if (dpIn.allow_conditional !== undefined) out.design_profile.allow_conditional = Boolean(dpIn.allow_conditional);
  // 설계 선호 기준의 기본 가중치(종류마다 0~100). 후보 비교 전에 프로젝트에서 정한다 — 정한 때만 남긴다(없으면 PREFERENCE_DEFAULTS).
  if (dpIn.preference_weights !== undefined) {
    const pw = dpIn.preference_weights;
    if (!pw || typeof pw !== "object" || Array.isArray(pw)) errors.push("설계 선호 기본 가중치(design_profile.preference_weights)는 {종류: 0~100} 이어야 합니다.");
    else {
      const ok = {};
      for (const [k, v] of Object.entries(pw)) {
        const n = Number(v);
        if (!PREFERENCE_KINDS.includes(k)) errors.push(`설계 선호 종류 ${k} 는 ${PREFERENCE_KINDS.join(", ")} 중 하나여야 합니다.`);
        else if (!Number.isFinite(n) || n < 0 || n > 100) errors.push(`설계 선호 ${k} 의 가중치는 0~100 이어야 합니다.`);
        else ok[k] = Math.round(n);
      }
      out.design_profile.preference_weights = ok;
    }
  }
  out.timing = { call_period_ms: per !== null && per > 0 && per <= 600000 ? Math.round(per * 1000) / 1000 : null };
  return { ok: errors.length === 0, errors, config: out };
}

function load(root) {
  const file = path.join(root, FILE);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { invalid: true, errors: [`${FILE} 을 읽을 수 없음: ${e.message}`], config: null }; }
  const v = validate(raw);
  return v.ok ? { invalid: false, errors: [], config: v.config } : { invalid: true, errors: v.errors, config: null };
}

function save(root, input) {
  // 화면 등이 design_policy 를 빼고 보내면 파일에 있던 값을 지킨다(빠뜨린 것만으로 legacy 로 내려가 게이트를 우회하지 않게).
  let src = input;
  if (input && typeof input === "object" && input.design_policy === undefined) {
    const before = load(root);
    if (before && before.config && before.config.design_policy) src = Object.assign({}, input, { design_policy: before.config.design_policy });
  }
  // 설계 규칙 프로파일도 빠뜨리면 파일 값을 지킨다(등급 미정 표시 등이 생략으로 사라지지 않게).
  if (src && typeof src === "object" && src.design_profile === undefined) {
    const before = load(root);
    if (before && before.config && before.config.design_profile) src = Object.assign({}, src, { design_profile: before.config.design_profile });
  }
  const v = validate(src);
  if (!v.ok) return v;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, FILE), JSON.stringify(v.config, null, 2) + "\n");
  return v;
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value === undefined ? null : value);
}
const hash = (config) => "sha256:" + crypto.createHash("sha256").update(canonical(config), "utf8").digest("hex");

const on = (level) => level === "required" || level === "recommended";
const measured = (config) => COVERAGE_METRICS.some((m) => m.id !== "mcdc" && on(config.coverage[m.id].level));

// 게이트가 make 에 넘기는 컴파일 옵션. 커버리지를 재는 경우 계측 옵션을 붙이고 최적화를 끈다.
function cflags(config, options) {
  const cover = measured(config);
  const flags = [`-std=${config.build.c_standard}`, ...BASE_WARNINGS];
  for (const r of CODING_RULES) if (r.flags && on(config.coding_rules[r.id])) flags.push(...r.flags);
  if (config.build.warnings_as_errors) flags.push("-Werror");
  flags.push(cover ? "-O0" : config.build.optimization);
  flags.push(...config.build.extra_flags);
  if (cover) flags.push("--coverage");
  // 조건 커버리지(MC/DC) 계측. 컴파일러가 지원할 때만 게이트가 켠다.
  if (cover && options && options.mcdc) flags.push("-fcondition-coverage");
  return [...new Set(flags)];
}

const LEVEL_TEXT = { required: "필수", recommended: "권장" };

const headLine = (config) => {
  const d = domainOf(config.domain) || DOMAINS.automotive;
  return `[프로젝트 설정] 도메인: ${d.label}, 표준: ${config.standard || "없음"}, 안전 등급: ${levelText(config)}`;
};
// 도메인 지침. 표준의 요약이며 표준 원문을 대신하지 않는다.
function domainNotes(config, kind) {
  const d = domainOf(config.domain) || DOMAINS.automotive;
  const notes = d.notes[kind] || [];
  if (!notes.length) return [];
  return ["", `[도메인 지침 — ${d.label}${config.standard ? `, ${config.standard}` : ""}] 아래는 이 도메인에서 지켜야 할 것의 요약이다. 요구사항 문장과 충돌하면 요구사항을 따르고 questions 에 적는다.`, ...notes.map((n) => `- ${n}`)];
}

// AI 에이전트에게 주는 지시. 코드 에이전트는 빌드·코딩 규칙을, 시험 에이전트는 시험 도출 방법과 커버리지 기준을 받는다.
function promptSection(config, role) {
  const comp = compilers.of(config.build.compiler) || compilers.of(compilers.DEFAULT);
  const lines = [headLine(config), `컴파일러: ${comp.label} (${comp.cc}). C 표준: ${config.build.c_standard}. 컴파일 옵션: ${cflags(config).join(" ")}`];
  if (role === "test") {
    lines.push("", "[시험 도출 방법] 아래 방법으로 시험을 도출한다. '필수' 방법은 요구사항마다 적용하고, 적용할 수 없으면 보고의 not_tested 가 아니라 시험 파일에 사유를 남긴다.");
    for (const m of TEST_METHODS) if (on(config.test_design[m.id])) lines.push(`- (${LEVEL_TEXT[config.test_design[m.id]]}) ${m.label} — @method ${m.tag}: ${m.prompt}`);
    lines.push(
      "시험마다 주석에 도출 방법을 적는다: `@method <값>` (여러 개면 쉼표로 구분). 값: " + TEST_METHODS.filter((m) => on(config.test_design[m.id])).map((m) => m.tag).join(", "),
      "어떤 요구사항에 필수 방법을 적용할 수 없으면 시험 파일에 `@no-method <값> <요구사항 ID>: <사유>` 주석을 남긴다 (예: @no-method boundary REQ-A-2: 수치 경계가 없는 논리 조건).",
    );
    const cov = COVERAGE_METRICS.filter((m) => on(config.coverage[m.id].level)).map((m) => `${m.label} ${config.coverage[m.id].min}% (${LEVEL_TEXT[config.coverage[m.id].level]})`);
    if (cov.length) lines.push("", `[커버리지 기준] ${cov.join(", ")}. 구현을 보지 않고 요구사항과 인터페이스에서 도출한 시험으로 이 기준에 닿도록, 요구사항의 조건 조합을 빠짐없이 시험한다.`);
  } else {
    lines.push("", "[코딩 규칙] 아래 규칙을 지킨다. '필수' 규칙을 어기면 게이트가 실패한다.");
    for (const r of CODING_RULES) if (on(config.coding_rules[r.id])) lines.push(`- (${LEVEL_TEXT[config.coding_rules[r.id]]}) ${r.label}: ${r.prompt}`);
    if (config.static_analysis && on(config.static_analysis.level)) lines.push(`[정적 분석] 게이트가 Cppcheck(--enable=warning,style,performance,portability)로 src/ 를 검사한다. ${config.static_analysis.fail_on} 이상의 지적이 나오지 않는 코드를 쓴다(${LEVEL_TEXT[config.static_analysis.level]}). 초기화하지 않은 변수, 범위 밖 접근, 쓰지 않는 값, 부호 섞인 비교 등을 피한다.`);
    lines.push("Makefile 은 `CC ?= cc`, `CFLAGS ?= …` 로 정의하고 컴파일·링크 명령 모두에 $(CFLAGS) 를 넣는다. 게이트가 위 컴파일 옵션을 CFLAGS 환경변수로 넘긴다.");
  }
  lines.push(...domainNotes(config, role === "test" ? "test" : "code"));
  return lines.join("\n");
}

// 대화로 만드는 명세 수준 테스트케이스(ears_test_cases)에 주는 지시. 켜진 도출 방법이 없으면 빈 문자열.
function specPromptSection(config) {
  const methods = TEST_METHODS.filter((m) => on(config.test_design[m.id]));
  if (!methods.length) return "";
  return [
    headLine(config),
    "[테스트케이스 도출 방법] 사용자가 TC 생성을 요청하면 아래 방법으로 도출한다. 이 설정은 '기본: happy + no-trigger 만 생성' 규칙보다 우선한다.",
    ...methods.map((m) => `- (${LEVEL_TEXT[config.test_design[m.id]]}) ${m.label} — method "${m.tag}": ${m.prompt}`),
    "규칙:",
    `- ears_test_cases 의 항목마다 "method" 필드에 그 TC 를 도출한 방법의 값을 배열로 적는다. 쓸 수 있는 값: ${methods.map((m) => m.tag).join(", ")}`,
    "- '필수' 방법은 TC 를 만드는 요구사항마다 적어도 하나의 TC 로 적용한다. '권장' 방법은 해당하는 경우에 적용한다.",
    "- 어떤 요구사항에 필수 방법을 적용할 수 없으면(예: 수치 경계가 없는 논리 조건) TC 를 억지로 만들지 말고, 답변에 'REQ-ID: <방법> 미적용 — <사유>' 한 줄을 남긴다.",
    "- 답변의 요약 줄에 어떤 방법으로 몇 개를 만들었는지 적는다. TC 생성 요청이 아닌 메시지에서는 이 설정을 언급하지 않는다.",
    ...domainNotes(config, "test"),
  ].join("\n");
}

// 화면에 보여 줄 항목 정의.
// 설계 선호 기준(아키텍처 결정 요인 중 '선호')의 종류와 기본 가중치. 안전·기능은 보통 필수 제약이라 넣지 않는다.
const PREFERENCE_KINDS = ["maintainability", "testability", "performance", "resource", "reusability", "modifiability", "scalability", "reliability", "security", "complexity", "other"];
const PREFERENCE_LABELS = { maintainability: "유지보수", testability: "검증 용이성", performance: "성능", resource: "자원", reusability: "재사용", modifiability: "변경 용이성", scalability: "확장", reliability: "신뢰성", security: "보안", complexity: "복잡도(낮을수록 좋음)", other: "기타" };
const PREFERENCE_DESCS = {
  maintainability: "코드를 읽고 고치기 쉬운 구조 — 책임이 분명하고 크기가 알맞은 구성요소",
  testability: "기능별로 독립적인 시험을 할 수 있는 구조 — 입력을 넣고 출력을 볼 수 있는 경계",
  performance: "실행 시간·응답 시간에 여유가 있는 구조 — 불필요한 호출·복사 줄이기",
  resource: "메모리·스택·CPU 를 적게 쓰는 구조",
  reusability: "다른 프로젝트·제품에서 다시 쓸 수 있는 구성요소",
  modifiability: "기능을 바꿀 때 다른 구성요소에 주는 영향이 작은 구조",
  scalability: "기능·신호가 늘어나도 구조를 크게 바꾸지 않아도 되는 구조",
  reliability: "고장·잘못된 입력에도 안전하게 동작을 이어 가는 구조",
  security: "외부 입력·통신으로부터 보호하기 쉬운 구조",
  complexity: "구성요소 수·연결 수가 적은 단순한 구조",
  other: "위에 없는 선호 조건",
};
const PREFERENCE_DEFAULTS = { maintainability: 25, testability: 25, performance: 20, resource: 15, reusability: 15, modifiability: 10, scalability: 5, reliability: 20, security: 10, complexity: 10, other: 10 };
// 이 프로젝트의 기본 가중치(설정에 적은 값이 우선, 없는 종류는 기본값)
const preferenceWeightsOf = (config) => Object.assign({}, PREFERENCE_DEFAULTS, (config && config.design_profile && config.design_profile.preference_weights) || {});

function catalog() {
  return {
    preference_kinds: PREFERENCE_KINDS.map((id) => ({ id, label: PREFERENCE_LABELS[id], description: PREFERENCE_DESCS[id], default: PREFERENCE_DEFAULTS[id] })),
    asils: ASILS, levels: LEVELS, c_standards: C_STANDARDS, basis: BASIS,
    domains: Object.entries(DOMAINS).map(([id, d]) => ({ id, label: d.label, standard: d.standard, level_name: d.level_name, default_level: d.default_level, basis: d.basis, levels: d.levels.map(([lid, label]) => ({ id: lid, label })), notes: d.notes })),
    coding_rules: CODING_RULES.map(({ id, label, check, prompt }) => ({ id, label, check, prompt })),
    test_methods: TEST_METHODS.map(({ id, tag, label, prompt }) => ({ id, tag, label, prompt })),
    coverage: COVERAGE_METRICS,
    static_fail_on: STATIC_FAIL_ON,
    compilers: compilers.list(), compiler_os: compilers.IMAGE_OS,
    coding_skills: SKILLS_BY_DOMAIN,
  };
}

module.exports = { PREFERENCE_KINDS, PREFERENCE_DEFAULTS, preferenceWeightsOf, DESIGN_POLICIES, DESIGN_POLICY_LABELS, NEW_PROJECT_POLICY, policyOf, designRequired, SKILLS_DIR, SKILLS_BY_DOMAIN, skillsFor, DOMAINS, levelText, SCHEMA, FILE, LEVELS, ASILS, CODING_RULES, TEST_METHODS, COVERAGE_METRICS, defaultConfig, validate, load, save, hash, cflags, measured, promptSection, specPromptSection, catalog, on };
