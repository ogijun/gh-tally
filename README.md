# gh-tally

A [GitHub CLI](https://cli.github.com/) extension that gathers your pull requests across every repository for a period and shows, on one screen, where each one stands: state, reviews, CI, conflicts, and stacked parents.

```
$ gh tally --since fri
12 PRs by @me (2026-10-23 00:00 to now)

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
gh tally [--since <when>] [--until <when>] [--by created|updated|merged] [--author <user>] [--repo <owner[/repo]>] [--rerun] [--json]
gh tally <number>... [-R owner/repo]
```

`--by` chooses which date the window applies to: `created` (default), `updated` (anything touched recently, including rebases and reviews), or `merged`. Giving PR numbers skips the date window and looks at those PRs in one repository (default: the current one).

`<when>` is one of:

- a weekday such as `fri` or `mon` — midnight of the most recent such day (today counts)
- `3d` — midnight three days ago
- `today`
- `YYYY-MM-DD`

All in your local timezone. The default is `--since 7d`. `--until` includes the whole day you name (`--until fri` runs to the end of Friday).

With the default `--by created`, a PR opened before `--since` and merged inside the window is not listed; use `--by updated` or `--by merged` for that. GitHub search returns at most 1,000 results; `gh tally` warns when the list is cut short.

`--rerun` re-runs, with `gh run rerun --failed`, only the newest run of each workflow and event on the PR's head commit, and only when that run looks red: it failed or was cancelled while the same workflow succeeded on the same commit, or it was cancelled with no success at all. Older duplicate runs are never re-run. Runs that cannot be re-run are reported, not counted.

## Columns

| Column | Values |
|---|---|
| state | `open` / `draft` / `merged` / `closed` / `error` (the PR could not be fetched) |
| reviews | latest review per reviewer: `approved:N`, `changes:N`, or `-` |
| CI | `✓` green, `✗` failing, `~` looks red (duplicate run cancelled), `…` running, `⊘` cancelled only, `-` none or not checked (merged and closed PRs) |
| extras | `conflict` (open PRs only), `↑#N` stacked on PR #N |

## Development

```
npm test
```

## License

MIT
