"use strict";

const path = require("node:path");
const { blankNonCode } = require("./trace-check.js");

// 비교 대상은 최상위의 스칼라 함수 서명이다. 전처리 조건이 결정되지 않은 선언은 사용하지 않는다.
function declarations(file, source) {
  const uncommented = blankNonCode(source, true);
  const clean = uncommented.split("\n");
  const lines = source.split("\n");
  const guard = /^\s*#\s*ifndef\s+(\w+)[ \t\r]*\n\s*#\s*define\s+\1\b/.exec(uncommented);
  const header = path.posix.basename(file).toUpperCase().replace(/\W/g, "_");
  const guardName = guard && guard[1].toUpperCase().replace(/^_+|_+$/g, "");
  const headerGuard = /\.h$/i.test(file) && guardName && (guardName === header || guardName.endsWith("_" + header));
  const guardLine = headerGuard && /#\s*endif\s*$/.test(uncommented) ? clean.findIndex(line => line.trim()) : -1;
  const includes = [];
  const conditions = [];
  let continued = false;
  for (let i = 0; i < lines.length; i++) {
    const directive = /^\s*#\s*(\w+)\b/.exec(clean[i]);
    if (continued) {
      continued = /\\\r?$/.test(lines[i]);
      clean[i] = "";
      continue;
    }
    if (directive) {
      const op = directive[1];
      if (/^if(?:n?def)?$/.test(op)) conditions.push(i !== guardLine);
      else if (op === "endif") conditions.pop();
      else if ((op === "else" || op === "elif") && conditions.length) conditions[conditions.length - 1] = true;
      else if (!conditions.includes(true) && op === "include") {
        const quoted = lines[i].slice(directive[0].length).trim().match(/^"([^"]+)"/);
        if (quoted) includes.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), quoted[1])));
      }
      continued = /\\\r?$/.test(lines[i]);
    }
    if (directive || conditions.includes(true)) clean[i] = "";
  }
  const code = clean.join("\n");
  const functions = [];
  const aliases = new Map();
  const duplicates = new Set();
  let start = 0, level = 0, bodyStart = 0, definition = null;
  for (const token of code.matchAll(/[;{}]/g)) {
    const at = token.index, symbol = token[0];
    if (!level && (symbol === ";" || symbol === "{")) {
      const segment = code.slice(start, at);
      const alias = /^\s*typedef\s+([\w\s]+?)\s+(\w+)\s*$/.exec(segment);
      if (alias && symbol === ";") {
        if (aliases.has(alias[2]) && aliases.get(alias[2]) !== alias[1]) duplicates.add(alias[2]);
        aliases.set(alias[2], alias[1]);
      }
      const sig = /^\s*([\w\s*]+?[\s*])([A-Za-z_]\w*)\s*\(([^()]*)\)\s*$/.exec(segment);
      if (sig && !/^\s*typedef\b/.test(segment)) {
        const args = sig[3].split(",").map(arg => {
          const named = /^\s*([\w\s*]+?[\s*])([A-Za-z_]\w*)\s*$/.exec(arg);
          return named && { type: named[1], name: named[2] };
        });
        const line = code.slice(0, start + segment.search(/\S/)).split("\n").length;
        const fn = { name: sig[2], result: sig[1], args, file, line, definition: symbol === "{", returned: "" };
        functions.push(fn);
        if (fn.definition) { definition = fn; bodyStart = at + 1; }
      }
      start = at + 1;
    }
    if (symbol === "{") level++;
    if (symbol === "}" && --level === 0) {
      if (definition) {
        const returns = [...code.slice(bodyStart, at).matchAll(/\breturn\b([^;]*);/g)].map(m => m[1].trim());
        if (returns.length && /^[A-Za-z_]\w*$/.test(returns[0]) && returns.every(r => r === returns[0])) definition.returned = returns[0];
        definition = null;
      }
      start = at + 1;
    }
  }
  for (const name of duplicates) aliases.set(name, null);
  return { includes, functions, aliases };
}

const qualifiers = /\b(?:extern|static|inline|const|volatile|restrict|register)\b/g;
function scalar(type, aliases, design = false, seen = new Set()) {
  const name = type.replace(qualifiers, " ").trim().replace(/\s+/g, " ");
  if (design) {
    if (name === "bool" || name === "_Bool" || name === "boolean") return "bool";
    if (/^u?int(?:8|16|32|64)(?:_t)?$/.test(name)) return name.replace(/_t$/, "");
    if (/^float(?:32|64)$/.test(name)) return name;
  }
  if (aliases.has(name)) {
    if (seen.has(name) || !aliases.get(name)) return null;
    return scalar(aliases.get(name), aliases, false, seen.add(name));
  }
  if (name === "bool" || name === "_Bool") return "bool";
  if (/^u?int(?:8|16|32|64)_t$/.test(name)) return name.slice(0, -2);
  if (/^(?:(?:signed|unsigned) )?(?:char|short(?: int)?|int|long(?: long)?(?: int)?)$/.test(name) || /^(?:signed|unsigned)$/.test(name)) return "native-integer";
  if (/^(?:float|double|long double)$/.test(name)) return "native-float";
  return null;
}

function compatible(expected, actual) {
  if (!expected || !actual) return null;
  if (expected === actual) return expected.startsWith("native-") ? null : true;
  // int/long/float의 비트 폭은 대상 ABI에 달려 있다.
  if ((expected === "native-integer" && /^(?:u?int|native-integer)/.test(actual))
    || (actual === "native-integer" && /^u?int/.test(expected))
    || (expected === "native-float" && /^float/.test(actual))
    || (actual === "native-float" && /^float/.test(expected))) return null;
  return false;
}

function checkInterfaces(files, unitOfFunc, design, dictionary) {
  const parsed = new Map(files.map(({file, source}) => [file, declarations(file, source)]));
  const errors = [], examined = new Set();
  const ports = design.connections.flatMap(c => c.accesses.filter(a => design.units.some(u => u.id === a.by)).map(a => ({
    name: c.signal, type: dictionary.get(c.signal)?.type || "", unit: a.by, mode: a.mode, fn: a.function,
  })));
  function imports(file, included = new Set()) {
    if (!parsed.has(file) || included.has(file)) return included;
    included.add(file);
    for (const header of parsed.get(file).includes) imports(header, included);
    return included;
  }
  const allFunctions = [...parsed.values()].flatMap(p => p.functions);
  const definitions = new Map();
  for (const fn of allFunctions.filter(f => f.definition)) definitions.set(fn.name, definitions.has(fn.name) ? null : fn);
  for (const [fnName, unit] of unitOfFunc) {
    const definition = definitions.get(fnName);
    if (!definition) continue;
    const visible = imports(definition.file);
    const localPorts = ports.filter(p => p.unit === unit && (!p.fn || p.fn === fnName));
    for (const fn of allFunctions.filter(f => f.name === fnName && visible.has(f.file))) {
      const aliases = new Map();
      for (const file of imports(fn.file)) for (const [name, type] of parsed.get(file).aliases) {
        aliases.set(name, aliases.has(name) && type !== aliases.get(name) ? null : type);
      }
      function compare(port, declared, label) {
        const expected = scalar(port.type, aliases, true), actual = scalar(declared, aliases);
        const matches = compatible(expected, actual);
        if (matches === null) return;
        examined.add(port);
        if (!matches) {
          const name = declared.trim();
          const cType = aliases.has(name) ? name + " = " + aliases.get(name) : name;
          errors.push({ message: unit + " " + fnName + "(): " + port.name + " " + label
            + " 자료형이 승인 설계와 다름 (설계 " + port.type + ", C " + cType + ")", where: fn.file + ":" + fn.line });
        }
      }
      for (const port of localPorts) {
        const arg = fn.args.find(a => a && a.name === port.name);
        if (arg) {
          const parts = arg.type.split("*");
          if (parts.length === 1 && port.mode === "READ") compare(port, parts[0], "인수");
          else if (parts.length === 2 && !parts[1].replace(qualifiers, "").trim()) compare(port, parts[0], "포인터 인수");
        }
        if (port.mode !== "READ" && definition.returned === port.name) compare(port, fn.result, "반환");
      }
    }
  }
  const unverified = ports.filter(p => !examined.has(p)).map(p => p.unit + (p.fn ? "/" + p.fn : "") + "." + p.name);
  return { errors, unverified };
}

module.exports = { checkInterfaces };
