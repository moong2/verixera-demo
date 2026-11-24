#!/usr/bin/env node
/* 릴리스 발행(CD): make-release.js 가 만든 묶음을 GitHub Release 로 올린다. CI 안에서만 쓴다.
 *
 * 필요한 환경변수: GITHUB_TOKEN(워크플로가 자동으로 주는 토큰), GITHUB_REPOSITORY(소유자/저장소).
 * 사용법: node tools/release/publish.js --tag <태그> [--dir release-out]
 * 같은 태그의 릴리스가 이미 있으면 새로 만들지 않고, 없는 파일만 올린다(같은 이름의 파일은 바꾸지 않는다).
 * 종료 코드: 0 발행, 1 발행 실패, 2 실행 조건 오류.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

class PublishError extends Error {}

const ASSETS = [
  ["release-manifest.json", "application/json"],
  ["trace-matrix.md", "text/markdown; charset=utf-8"],
];

async function publish(options) {
  const { tag, dir, repo, token } = options;
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!tag || !dir || !repo || !token) throw new PublishError("태그, 폴더, 저장소, 토큰이 모두 필요함");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new PublishError(`저장소 이름 형식이 아님: ${repo}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "release-manifest.json"), "utf8"));
  if (manifest.tag !== tag) throw new PublishError(`묶음의 태그(${manifest.tag})가 발행하려는 태그(${tag})와 다름`);
  if (manifest.gate !== "pass") throw new PublishError("게이트를 통과한 묶음이 아님");
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ears-traceability-release" };
  const call = async (url, init) => {
    const res = await fetchImpl(url, Object.assign({ headers }, init, { headers: Object.assign({}, headers, (init && init.headers) || {}) }));
    return res;
  };

  const api = `https://api.github.com/repos/${repo}`;
  let res = await call(`${api}/releases/tags/${tag.split("/").map(encodeURIComponent).join("/")}`);
  let release;
  if (res.status === 200) release = await res.json();
  else if (res.status === 404) {
    res = await call(`${api}/releases`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag_name: tag, name: `${manifest.target} v${manifest.version}`, body: fs.readFileSync(path.join(dir, "release-notes.md"), "utf8"), draft: false, prerelease: false }),
    });
    if (res.status !== 201) throw new PublishError(`릴리스를 만들지 못함 (${res.status})`);
    release = await res.json();
  } else throw new PublishError(`릴리스 조회 실패 (${res.status})`);

  const existing = new Set((release.assets || []).map((a) => a.name));
  const uploaded = [];
  for (const [name, type] of [[manifest.bundle.name, "application/gzip"], ...ASSETS]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || existing.has(name)) continue;
    const data = fs.readFileSync(file);
    res = await call(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { "content-type": type, "content-length": String(data.length) }, body: data,
    });
    if (res.status !== 201) throw new PublishError(`${name} 을 올리지 못함 (${res.status})`);
    uploaded.push(name);
  }
  return { url: release.html_url, id: release.id, uploaded, skipped: [...existing] };
}

module.exports = { publish, PublishError };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const tag = arg("--tag", null);
  if (!tag || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
    console.error("사용법: GITHUB_TOKEN, GITHUB_REPOSITORY 환경변수와 함께 node tools/release/publish.js --tag <태그> [--dir release-out]");
    process.exitCode = 2;
  } else {
    publish({ tag, dir: path.resolve(arg("--dir", "release-out")), repo: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN }).then(
      (r) => { console.log(`릴리스 발행: ${r.url} — 올린 파일 ${r.uploaded.join(", ") || "없음"}${r.skipped.length ? `, 이미 있던 파일 ${r.skipped.join(", ")}` : ""}`); },
      (e) => { console.error(e instanceof PublishError ? e.message : e); process.exitCode = 1; }
    );
  }
}
