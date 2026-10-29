import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  parseSince,
  classifyRuns,
  reviewSummary,
  stackParents,
  duplicateTitles,
  renderRepo,
  formatLocal,
} from "../lib/tally.mjs";

test("parseArgs: 既定値とフラグ", () => {
  assert.deepEqual(parseArgs([]), {
    since: "7d",
    until: null,
    author: "@me",
    repo: null,
    rerun: false,
    json: false,
    help: false,
  });
  const o = parseArgs(["--since", "fri", "--repo", "o/r", "--rerun", "--json"]);
  assert.equal(o.since, "fri");
  assert.equal(o.repo, "o/r");
  assert.equal(o.rerun, true);
  assert.equal(o.json, true);
});

test("parseSince: 曜日は直近のその曜日の 0 時（手元の時刻）", () => {
  const now = new Date(2026, 9, 29, 15, 0); // 2026-10-29 木曜 15:00
  assert.deepEqual(parseSince("fri", now), new Date(2026, 9, 23, 0, 0));
  assert.deepEqual(parseSince("thu", now), new Date(2026, 9, 29, 0, 0));
  assert.deepEqual(parseSince("mon", now), new Date(2026, 9, 26, 0, 0));
});

test("parseSince: N 日前・日付・today", () => {
  const now = new Date(2026, 9, 29, 15, 0);
  assert.deepEqual(parseSince("3d", now), new Date(2026, 9, 26, 0, 0));
  assert.deepEqual(parseSince("2026-10-01", now), new Date(2026, 9, 1, 0, 0));
  assert.deepEqual(parseSince("today", now), new Date(2026, 9, 29, 0, 0));
  assert.throws(() => parseSince("someday", now));
});

test("classifyRuns: 同じ workflow に成功があれば、失敗・取消は見かけの赤", () => {
  const runs = [
    { id: 1, name: "Test", workflow_id: 10, status: "completed", conclusion: "failure" },
    { id: 2, name: "Test", workflow_id: 10, status: "completed", conclusion: "success" },
    { id: 3, name: "Lint", workflow_id: 11, status: "completed", conclusion: "success" },
  ];
  assert.deepEqual(classifyRuns(runs), { state: "stale-red", rerunIds: [1] });
});

test("classifyRuns: 成功の無い失敗は本当の赤、実行中は pending", () => {
  assert.equal(
    classifyRuns([{ id: 1, name: "T", workflow_id: 1, status: "completed", conclusion: "failure" }]).state,
    "red",
  );
  assert.equal(classifyRuns([{ id: 1, name: "T", workflow_id: 1, status: "in_progress", conclusion: null }]).state, "pending");
  assert.equal(classifyRuns([]).state, "none");
  assert.deepEqual(
    classifyRuns([{ id: 5, name: "T", workflow_id: 1, status: "completed", conclusion: "cancelled" }]),
    { state: "cancelled", rerunIds: [5] },
  );
});

test("reviewSummary: レビュアーごとの最新の状態でまとめる", () => {
  const reviews = [
    { user: { login: "a" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-01T00:00:00Z" },
    { user: { login: "a" }, state: "APPROVED", submitted_at: "2026-10-02T00:00:00Z" },
    { user: { login: "b" }, state: "COMMENTED", submitted_at: "2026-10-02T00:00:00Z" },
  ];
  assert.equal(reviewSummary(reviews), "approved:1");
  assert.equal(reviewSummary([]), "-");
  assert.equal(
    reviewSummary([{ user: { login: "c" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-03T00:00:00Z" }]),
    "changes:1",
  );
});

test("stackParents: base が別の PR の head なら、その PR が親", () => {
  const prs = [
    { number: 1, base: "develop", head: "feat/a" },
    { number: 2, base: "feat/a", head: "feat/b" },
    { number: 3, base: "feat/b", head: "feat/c" },
  ];
  assert.deepEqual(stackParents(prs), { 2: 1, 3: 2 });
});

test("duplicateTitles: open の PR で題名が同じもの", () => {
  const prs = [
    { number: 1, title: "x", state: "open" },
    { number: 2, title: "x", state: "open" },
    { number: 3, title: "x", state: "merged" },
    { number: 4, title: "y", state: "open" },
  ];
  assert.deepEqual(duplicateTitles(prs), [[1, 2]]);
});

test("renderRepo: 1 行に状態・レビュー・CI・親・題名", () => {
  const out = renderRepo("o/r", [
    { number: 2, state: "draft", review: "-", ci: "stale-red", conflict: false, parent: 1, title: "B" },
    { number: 1, state: "open", review: "approved:1", ci: "green", conflict: true, parent: null, title: "A" },
  ]);
  assert.match(out, /^## o\/r \(2\)/);
  assert.match(out, /#1 +open +approved:1 +✓ +conflict +A/);
  assert.match(out, /#2 +draft +- +~ +↑#1 +B/);
});

test("formatLocal: 手元の時刻を YYYY-MM-DD HH:MM で", () => {
  assert.equal(formatLocal(new Date(2026, 9, 23, 0, 5)), "2026-10-23 00:05");
});
