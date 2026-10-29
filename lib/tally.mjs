import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const HELP = `gh tally — 自分の PR を期間で集めて、状態をまとめる

使い方:
  gh tally [--since <いつから>] [--until <いつまで>]

オプション:
  --since <spec>     fri・mon などの曜日（直近のその曜日の 0 時）/ 3d（3 日前の 0 時）/
                     today / YYYY-MM-DD。既定は 7d。時刻は手元のタイムゾーン
  --until <spec>     同じ書き方。その日の終わりまでを含む。既定は今
  --author <user>    既定は @me
  --repo <owner[/repo]>  リポか owner で絞る
  --rerun            workflow・event ごとの最新の run が見かけの赤（同じ workflow に成功がある失敗・取消）か
                     取消だけのとき、その 1 本を再実行する
  --json             JSON で出す

表示の記号:
  CI   ✓ 緑 / ✗ 本当の赤 / ~ 見かけの赤（重複実行の取消など）/ … 実行中 / ⊘ 取消のみ / - なし
  ↑#N  スタックの親（base がその PR の head）
`;

export function parseArgs(argv) {
  const o = { since: "7d", until: null, author: "@me", repo: null, rerun: false, json: false, help: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("-")) throw new Error(`${flag} に値が要る`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") o.since = value(++i, a);
    else if (a === "--until") o.until = value(++i, a);
    else if (a === "--author") o.author = value(++i, a);
    else if (a === "--repo" || a === "-R") o.repo = value(++i, a);
    else if (a === "--rerun") o.rerun = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`知らない引数: ${a}`);
  }
  return o;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function weekday(s) {
  return DAYS.findIndex((d) => s === d || s === d.slice(0, 3));
}

export function parseSince(spec, now = new Date()) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0);
  const s = spec.toLowerCase();
  if (s === "today") return midnight(now);
  const day = weekday(s);
  if (day >= 0) {
    const back = (now.getDay() - day + 7) % 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 0, 0);
  }
  const n = s.match(/^(\d+)d$/);
  if (n) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(n[1]), 0, 0);
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), 0, 0);
    if (d.getMonth() !== Number(ymd[2]) - 1 || d.getDate() !== Number(ymd[3])) throw new Error(`存在しない日付: ${spec}`);
    return d;
  }
  throw new Error(`期間の書き方が分からない: ${spec}`);
}

// --until はその日を含める（翌日 0 時まで）。Nd も同じく「N 日前の日の終わり」
export function parseUntil(spec, now = new Date()) {
  const start = parseSince(spec, now);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0);
}

const BAD = ["failure", "cancelled", "timed_out", "startup_failure"];

// workflow と event の組ごとに最新の run だけを見る。古い重複は判定にも再実行にも使わない
export function classifyRuns(runs) {
  if (!runs.length) return { state: "none", rerunIds: [] };
  const groups = new Map();
  for (const r of runs) {
    const key = `${r.workflow_id}|${r.event ?? ""}`;
    const cur = groups.get(key);
    if (!cur || (r.run_number ?? r.id) > (cur.run_number ?? cur.id)) groups.set(key, r);
  }
  const latest = [...groups.values()];
  const successByWorkflow = new Set(latest.filter((r) => r.conclusion === "success").map((r) => r.workflow_id));
  let pending = false;
  let red = false;
  let stale = false;
  let cancelledOnly = false;
  const rerunIds = [];
  for (const r of latest) {
    if (r.status !== "completed") pending = true;
    else if (!BAD.includes(r.conclusion)) continue;
    else if (successByWorkflow.has(r.workflow_id)) {
      stale = true;
      rerunIds.push(r.id);
    } else if (r.conclusion === "cancelled") {
      cancelledOnly = true;
      rerunIds.push(r.id);
    } else red = true;
  }
  const state = red ? "red" : pending ? "pending" : stale ? "stale-red" : cancelledOnly ? "cancelled" : "green";
  return { state, rerunIds };
}

export function reviewSummary(reviews) {
  const latest = new Map();
  const at = (r) => r.submitted_at ?? "";
  for (const r of [...reviews].sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0))) {
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
  // fork からの PR の head は、同じリポのブランチではないので親にしない
  const key = (repo, ref) => `${repo ?? ""}:${ref}`;
  const byHead = new Map(prs.filter((p) => !p.headRepo || p.headRepo === p.baseRepo).map((p) => [key(p.baseRepo, p.head), p.number]));
  const out = {};
  for (const p of prs) {
    const parent = byHead.get(key(p.baseRepo, p.base));
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

async function paged(path, pick, maxPages = 10) {
  const items = [];
  let last = null;
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    last = await api(`${path}${sep}per_page=100&page=${page}`);
    const batch = pick(last);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return { items, last };
}

async function searchPrs(author, since, until, repo) {
  const range = until ? `${since.toISOString()}..${until.toISOString()}` : `>=${since.toISOString()}`;
  let q = `is:pr author:${author} created:${range}`;
  if (repo) q += repo.includes("/") ? ` repo:${repo}` : ` user:${repo}`;
  const { items, last } = await paged(`search/issues?q=${encodeURIComponent(q)}`, (r) => r.items);
  const truncated = (last?.total_count ?? 0) > items.length || last?.incomplete_results === true;
  return { found: items.map((it) => ({ repo: it.repository_url.replace(/^.*\/repos\//, ""), number: it.number })), truncated, total: last?.total_count ?? items.length };
}

async function detail({ repo, number }) {
  try {
    let pr = await api(`repos/${repo}/pulls/${number}`);
    const state = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
    const live = state === "open" || state === "draft";
    // mergeable は初回の取得では計算中（null）のことがあるので、1 回だけ取り直す
    if (live && pr.mergeable === null) pr = await api(`repos/${repo}/pulls/${number}`);
    const { items: reviews } = await paged(`repos/${repo}/pulls/${number}/reviews`, (r) => r);
    let ci = { state: "none", rerunIds: [] };
    if (live) {
      const { items: runs } = await paged(`repos/${repo}/actions/runs?head_sha=${pr.head.sha}`, (r) => r.workflow_runs, 5);
      ci = classifyRuns(runs);
    }
    return {
      repo,
      number,
      title: pr.title,
      url: pr.html_url,
      state,
      base: pr.base.ref,
      head: pr.head.ref,
      baseRepo: pr.base.repo?.full_name ?? repo,
      headRepo: pr.head.repo?.full_name ?? null,
      createdAt: pr.created_at,
      review: reviewSummary(reviews),
      ci: ci.state,
      rerunIds: ci.rerunIds,
      conflict: live && pr.mergeable === false,
    };
  } catch (e) {
    // 1 本の取得に失敗しても全体は出す
    return { repo, number, title: `(取得に失敗: ${String(e.message).split("\n")[0]})`, state: "error", review: "-", ci: "none", rerunIds: [], conflict: false, base: null, head: null };
  }
}

export async function main(argv, out = console) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out.log(HELP);
    return 0;
  }
  const now = new Date();
  const since = parseSince(opts.since, now);
  const until = opts.until ? parseUntil(opts.until, now) : null;
  const { found, truncated, total } = await searchPrs(opts.author, since, until, opts.repo);
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
  const rerunErrors = [];
  if (opts.rerun) {
    for (const p of prs) {
      for (const id of p.rerunIds) {
        try {
          await gh(["run", "rerun", String(id), "--failed", "-R", p.repo]);
          reruns.push({ repo: p.repo, pr: p.number, run: id });
        } catch (e) {
          rerunErrors.push({ repo: p.repo, pr: p.number, run: id, error: String(e.stderr || e.message).trim().split("\n")[0] });
        }
      }
    }
  }

  const dups = [...byRepo.entries()].flatMap(([repo, list]) => duplicateTitles(list).map((g) => ({ repo, numbers: g })));

  if (opts.json) {
    out.log(JSON.stringify({ since: since.toISOString(), until: until?.toISOString() ?? null, prs, duplicateTitles: dups, reruns, rerunErrors, truncated, total }, null, 2));
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
  for (const r of rerunErrors) out.log(`再実行できなかった run: ${r.repo}#${r.pr} run ${r.run}（${r.error}）`);
  if (truncated) out.log(`注意: 検索の上限で ${total} 本のうち ${prs.length} 本だけを表示した。--since を狭めてください`);
  return 0;
}
