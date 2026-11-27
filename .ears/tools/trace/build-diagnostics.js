"use strict";

// 컴파일러·링커의 첫 원인부터 남긴다. make의 마지막 종료 줄만으로는 실패한 파일을 알 수 없다.
module.exports = function buildDiagnostics(output) {
  const diagnostics = [];
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!/\berror\b|undefined reference|multiple definition|unresolved external|duplicate symbol|no rule to make target|:\s*\*\*\*|오류\s*[:：]/i.test(line)) continue;
    diagnostics.push(line.slice(0, 300));
    if (diagnostics.length === 20) break;
  }
  return diagnostics;
};
