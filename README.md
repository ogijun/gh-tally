# gh-tally

A [GitHub CLI](https://cli.github.com/) extension that gathers your pull requests across every repository for a period and shows, on one screen, where each one stands: state, reviews, CI, conflicts, and stacked parents.

```
$ gh tally --since fri
@me の PR: 12 本（2026-10-23 00:00 〜 今）

## owner/api (3)
  #101    merged  approved:1   -  Add retry to the webhook handler
  #104    open    approved:2   ✓  Validate the token audience
  #105    draft   -            ~  ↑#104  Report every failure in a test shard
```

## Why

- `gh search prs` takes dates in UTC, so "since Friday" quietly drops the first hours of Friday in your timezone. `gh tally` uses your local timezone.
- A red check on a stacked PR is often not a failing test: a duplicate run of the same workflow was cancelled while another run on the same commit succeeded. `gh tally` tells these apart and can re-run them.
- Stacked PRs (a PR whose base branch is another PR's head) are shown with their parent, and open PRs with identical titles are flagged.

## Install

```
gh extension install ogijun/gh-tally
```

Requires Node.js 20 or later.

## Usage

```
gh tally [--since <when>] [--until <when>] [--author <user>] [--repo <owner[/repo]>] [--rerun] [--json]
```

`<when>` is one of:

- a weekday such as `fri` or `mon` — midnight of the most recent such day (today counts)
- `3d` — midnight three days ago
- `today`
- `YYYY-MM-DD`

All in your local timezone. The default is `--since 7d`.

`--rerun` re-runs, with `gh run rerun --failed`, the runs that only look red (a failed or cancelled run of a workflow that also has a successful run on the same commit) and runs that were only cancelled.

## Columns

| Column | Values |
|---|---|
| state | `open` / `draft` / `merged` / `closed` |
| reviews | latest review per reviewer: `approved:N`, `changes:N`, or `-` |
| CI | `✓` green, `✗` failing, `~` looks red (duplicate run cancelled), `…` running, `⊘` cancelled only, `-` none or not checked (merged and closed PRs) |
| extras | `conflict` (open PRs only), `↑#N` stacked on PR #N |

## Development

```
npm test
```

## License

MIT
