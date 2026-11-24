/* 파일 내용 보관(내용 해시로 찾는 사본).
 *
 * 커밋하지 않은 코드에서도 "사람이 고치기 전 내용"과 비교할 수 있게, 다음 때 파일 내용을 남긴다.
 *  - AI 생성 결과를 적용할 때(생성본)
 *  - 편집기에서 저장할 때(저장 전·후), 지울 때(지우기 전)
 * 생성 기록(agent-log/GEN-*.json)과 사람 수정 기록(agent-log/manual-edits.jsonl)에는 해시만 있으므로, 그 해시로 이 사본을 찾는다.
 * 대상 프로젝트 trace-out/snapshots/<해시>.txt (trace-out 은 Git 에 올리지 않는다 — 이 PC 의 검토용)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DIR = "trace-out/snapshots";
const normalize = (t) => String(t).replace(/\r\n?/g, "\n");
const sha256 = (t) => "sha256:" + crypto.createHash("sha256").update(normalize(t), "utf8").digest("hex");
const fileOf = (root, sha) => {
  const m = /^sha256:([0-9a-f]{64})$/.exec(String(sha || ""));
  return m ? path.join(root, ...DIR.split("/"), `${m[1]}.txt`) : null;
};

// 내용을 남기고 해시를 돌려준다. 이미 있으면 다시 쓰지 않는다.
function put(root, text) {
  if (typeof text !== "string") return null;
  const sha = sha256(text);
  const f = fileOf(root, sha);
  if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, normalize(text)); }
  return sha;
}

// 해시로 내용을 찾는다. 없거나 내용이 해시와 맞지 않으면 null.
function get(root, sha) {
  const f = fileOf(root, sha);
  if (!f || !fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, "utf8");
  return sha256(t) === sha ? t : null;
}

module.exports = { DIR, put, get, sha256 };
