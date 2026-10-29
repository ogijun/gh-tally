import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const HELP = `gh tally — 自分の PR を期間で集めて、状態をまとめる

使い方:
  gh tally [--since <いつから>] [--until <いつまで>]

オプション:
  --since <spec>     fri・mon などの曜日（直近のその曜日の 0 時）/ 3d（3 日前の 0 時）/
                     today / YYYY-MM-DD。既定は 7d。時刻は手元のタイムゾーン
  --until <spec>     同じ書き方。既定は今
  --author <user>    既定は @me
  --repo <owner[/repo]>  リポか owner で絞る
  --rerun            見かけの赤（同じ workflow に成功がある失敗・取消）と取消だけの実行を再実行する
  --json             JSON で出す

表示の記号:
  CI   ✓ 緑 / ✗ 本当の赤 / ~ 見かけの赤（重複実行の取消など）/ … 実行中 / ⊘ 取消のみ / - なし
  ↑#N  スタックの親（base がその PR の head）
`;

export function parseArgs(argv) {
  const o = { since: "7d", until: null, author: "@me", repo: null, rerun: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") o.since = argv[++i];
    else if (a === "--until") o.until = argv[++i];
    else if (a === "--author") o.author = argv[++i];
    else if (a === "--repo" || a === "-R") o.repo = argv[++i];
    else if (a === "--rerun") o.rerun = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`知らない引数: ${a}`);
  }
  return o;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseSince(spec, now = new Date()) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0);
  const s = spec.toLowerCase();
  if (s === "today") return midnight(now);
  const day = DAYS.indexOf(s.slice(0, 3));
  if (day >= 0 && DAYS.some((d) => s.startsWith(d))) {
    const back = (now.getDay() - day + 7) % 7;
    return midnight(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
  }
  const n = s.match(/^(\d+)d$/);
  if (n) return midnight(new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(n[1])));
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 0, 0);
  throw new Error(`期間の書き方が分からない: ${spec}`);
}

export function classifyRuns(runs) {
  if (!runs.length) return { state: "none", rerunIds: [] };
  const byWorkflow = new Map();
  for (const r of runs) {
    if (!byWorkflow.has(r.workflow_id)) byWorkflow.set(r.workflow_id, []);
    byWorkflow.get(r.workflow_id).push(r);
  }
  let pending = false;
  let red = false;
  let stale = false;
  let cancelledOnly = false;
  const rerunIds = [];
  for (const list of byWorkflow.values()) {
    if (list.some((r) => r.status !== "completed")) {
      pending = true;
      continue;
    }
    const bad = list.filter((r) => ["failure", "cancelled", "timed_out", "startup_failure"].includes(r.conclusion));
    const ok = list.some((r) => r.conclusion === "success");
    if (!bad.length) continue;
    if (ok) {
      stale = true;
      rerunIds.push(...bad.map((r) => r.id));
    } else if (bad.every((r) => r.conclusion === "cancelled")) {
      cancelledOnly = true;
      rerunIds.push(...bad.map((r) => r.id));
    } else red = true;
  }
  const state = red ? "red" : pending ? "pending" : stale ? "stale-red" : cancelledOnly ? "cancelled" : "green";
  return { state, rerunIds };
}

export function reviewSummary(reviews) {
  const latest = new Map();
  for (const r of [...reviews].sort((a, b) => (a.submitted_at < b.submitted_at ? -1 : 1))) {
    if (r.state === "COMMENTED" || r.state === "PENDING") continue;
    latest.set(r.user?.login, r.state);
  }
  const count = (s) => [...latest.values()].filter((v) => v === s).length;
  const parts = [];
  if (count("APPROVED")) parts.push(`approved:${count("APPROVED")}`);
  if (count("CHANGES_REQUESTED")) parts.push(`changes:${count("CHANGES_REQUESTED")}`);
  return parts.join(",") || "-";
}

export function stackParents(prs) {
  const byHead = new Map(prs.map((p) => [p.head, p.number]));
  const out = {};
  for (const p of prs) {
    const parent = byHead.get(p.base);
    if (parent && parent !== p.number) out[p.number] = parent;
  }
  return out;
}

export function duplicateTitles(prs) {
  const groups = new Map();
  for (const p of prs.filter((p) => p.state === "open" || p.state === "draft")) {
    if (!groups.has(p.title)) groups.set(p.title, []);
    groups.get(p.title).push(p.number);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a - b));
}

export function formatLocal(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

const CI_MARK = { green: "✓", red: "✗", "stale-red": "~", pending: "…", cancelled: "⊘", none: "-" };

export function renderRepo(repo, rows) {
  const sorted = [...rows].sort((a, b) => a.number - b.number);
  const lines = [`## ${repo} (${rows.length})`];
  for (const r of sorted) {
    const cols = [
      `#${r.number}`.padEnd(7),
      r.state.padEnd(6),
      r.review.padEnd(11),
      CI_MARK[r.ci] ?? "?",
      r.conflict ? "conflict" : "",
      r.parent ? `↑#${r.parent}` : "",
      r.title,
    ].filter((c, i) => i < 4 || c !== "");
    lines.push("  " + cols.join("  "));
  }
  return lines.join("\n");
}

// ---- 以下は gh を呼ぶ部分 ----

async function gh(args) {
  const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function api(path) {
  return JSON.parse(await gh(["api", path]));
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function searchPrs(author, since, until, repo) {
  const range = until ? `${since.toISOString()}..${until.toISOString()}` : `>=${since.toISOString()}`;
  let q = `is:pr author:${author} created:${range}`;
  if (repo) q += repo.includes("/") ? ` repo:${repo}` : ` user:${repo}`;
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const res = await api(`search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
    items.push(...res.items);
    if (res.items.length < 100) break;
  }
  return items.map((it) => ({ repo: it.repository_url.replace(/^.*\/repos\//, ""), number: it.number }));
}

async function detail({ repo, number }) {
  const pr = await api(`repos/${repo}/pulls/${number}`);
  const state = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
  const reviews = await api(`repos/${repo}/pulls/${number}/reviews?per_page=100`);
  let ci = { state: "none", rerunIds: [] };
  if (state === "open" || state === "draft") {
    const runs = await api(`repos/${repo}/actions/runs?head_sha=${pr.head.sha}&per_page=100`);
    ci = classifyRuns(runs.workflow_runs);
  }
  return {
    repo,
    number,
    title: pr.title,
    url: pr.html_url,
    state,
    base: pr.base.ref,
    head: pr.head.ref,
    createdAt: pr.created_at,
    review: reviewSummary(reviews),
    ci: ci.state,
    rerunIds: ci.rerunIds,
    conflict: (state === "open" || state === "draft") && pr.mergeable === false,
  };
}

export async function main(argv, out = console) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out.log(HELP);
    return 0;
  }
  const now = new Date();
  const since = parseSince(opts.since, now);
  const until = opts.until ? parseSince(opts.until, now) : null;
  const found = await searchPrs(opts.author, since, until, opts.repo);
  const prs = await pool(found, 6, detail);

  const byRepo = new Map();
  for (const p of prs) {
    if (!byRepo.has(p.repo)) byRepo.set(p.repo, []);
    byRepo.get(p.repo).push(p);
  }
  for (const list of byRepo.values()) {
    const parents = stackParents(list);
    for (const p of list) p.parent = parents[p.number] ?? null;
  }

  const reruns = [];
  if (opts.rerun) {
    for (const p of prs) {
      for (const id of p.rerunIds) {
        await gh(["run", "rerun", String(id), "--failed", "-R", p.repo]).catch(() => null);
        reruns.push({ repo: p.repo, pr: p.number, run: id });
      }
    }
  }

  const dups = [...byRepo.entries()].flatMap(([repo, list]) => duplicateTitles(list).map((g) => ({ repo, numbers: g })));

  if (opts.json) {
    out.log(JSON.stringify({ since: since.toISOString(), until: until?.toISOString() ?? null, prs, duplicateTitles: dups, reruns }, null, 2));
    return 0;
  }
  const span = `${formatLocal(since)} 〜 ${until ? formatLocal(until) : "今"}`;
  out.log(`${opts.author} の PR: ${prs.length} 本（${span}）\n`);
  const repos = [...byRepo.keys()].sort((a, b) => byRepo.get(b).length - byRepo.get(a).length || a.localeCompare(b));
  for (const repo of repos) out.log(renderRepo(repo, byRepo.get(repo)) + "\n");
  for (const d of dups) out.log(`題名が同じ open の PR: ${d.repo} ${d.numbers.map((n) => "#" + n).join(" ")}`);
  const stale = prs.filter((p) => p.ci === "stale-red" || p.ci === "cancelled");
  if (stale.length && !opts.rerun) out.log(`見かけの赤・取消: ${stale.map((p) => `${p.repo}#${p.number}`).join(" ")}（--rerun で再実行）`);
  if (reruns.length) out.log(`再実行した run: ${reruns.length} 本`);
  return 0;
}
