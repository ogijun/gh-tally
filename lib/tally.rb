require "date"
require "json"
require "open3"
require "time"

module GhTally
  HELP = <<~'HELP'
    gh tally — tally your pull requests for a period and show where each one stands

    Usage:
      gh tally [--since <when>] [--until <when>] [--by created|updated|merged]
      gh tally <number>... [-R owner/repo]     specific PRs, no date window

    Options:
      --since <when>     a weekday such as fri or mon (midnight of the most recent one) / 3d (midnight 3 days ago) /
                         today / YYYY-MM-DD. Default 7d. Local timezone
      --until <when>     same forms; the named day is included. Default: now
      --by <field>       which date the window applies to: created (default), updated, or merged
      --author <user>    default @me
      --repo <owner[/repo]>  limit to a repository or an owner
      --rerun            re-run the newest run of each workflow and event when it was cancelled
                         (whether or not the same workflow also succeeded on the commit)
      --json             JSON output

    Marks:
      CI   ✓ green / ✗ failing / ~ looks red (e.g. a cancelled duplicate run) / … running / ⊘ cancelled only /
           - no runs, or not checked (merged and closed PRs)
      ↑#N  stacked on PR #N (its base is that PR's head; looked up even when #N is not listed)
  HELP

  # Raised when a gh invocation fails. Mirrors Node's execFile error: message is
  # "Command failed: <cmd>\n<stderr>" and stderr is kept separately.
  class GhError < StandardError
    attr_reader :stderr

    def initialize(message, stderr)
      super(message)
      @stderr = stderr
    end
  end

  module_function

  def parse_args(argv)
    o = { since: "7d", until: nil, author: "@me", repo: nil, rerun: false, json: false, help: false, by: "created", numbers: [] }
    value = lambda do |i, flag|
      v = argv[i]
      raise "#{flag} needs a value" if v.nil? || v.start_with?("-")

      v
    end
    i = 0
    while i < argv.length
      a = argv[i]
      case a
      when "--since" then o[:since] = value.call(i += 1, a)
      when "--until" then o[:until] = value.call(i += 1, a)
      when "--author" then o[:author] = value.call(i += 1, a)
      when "--repo", "-R" then o[:repo] = value.call(i += 1, a)
      when "--rerun" then o[:rerun] = true
      when "--json" then o[:json] = true
      when "--by"
        o[:by] = value.call(i += 1, a)
        raise "--by must be created, updated, or merged: #{o[:by]}" unless %w[created updated merged].include?(o[:by])
      when "-h", "--help" then o[:help] = true
      when /\A#?\d+\z/ then o[:numbers] << a.delete("#").to_i
      else raise "unknown argument: #{a}"
      end
      i += 1
    end
    o
  end

  DAYS = %w[sunday monday tuesday wednesday thursday friday saturday].freeze

  def weekday(s)
    DAYS.index { |d| s == d || s == d[0, 3] } || -1
  end

  # Local midnight of the given calendar date, offset by `days` (calendar arithmetic, DST-safe)
  def local_midnight(y, m, d, days = 0)
    date = Date.new(y, m, d) + days
    Time.local(date.year, date.month, date.day, 0, 0)
  end

  def parse_since(spec, now = Time.now)
    s = spec.downcase
    return local_midnight(now.year, now.month, now.day) if s == "today"

    day = weekday(s)
    return local_midnight(now.year, now.month, now.day, -((now.wday - day + 7) % 7)) if day >= 0

    if (n = s.match(/\A(\d+)d\z/))
      return local_midnight(now.year, now.month, now.day, -n[1].to_i)
    end
    if (ymd = s.match(/\A(\d{4})-(\d{2})-(\d{2})\z/))
      y, m, d = ymd[1].to_i, ymd[2].to_i, ymd[3].to_i
      raise "no such date: #{spec}" unless Date.valid_date?(y, m, d)

      return local_midnight(y, m, d)
    end
    raise "cannot parse date: #{spec}"
  end

  # --until includes the named day (up to midnight of the next day); Nd likewise means the end of that day
  def parse_until(spec, now = Time.now)
    start = parse_since(spec, now)
    local_midnight(start.year, start.month, start.day, 1)
  end

  BAD = %w[failure cancelled timed_out startup_failure].freeze

  def run_order(r)
    r[:run_number] || r[:id]
  end

  def run_key(r)
    "#{r[:workflow_id]}|#{r[:event]}"
  end

  def newest_runs(runs)
    runs.each_with_object({}) do |r, groups|
      key = run_key(r)
      cur = groups[key]
      groups[key] = r if cur.nil? || run_order(r) > run_order(cur) || (run_order(r) == run_order(cur) && r[:id] > cur[:id])
    end
  end

  # Judge the newest run per (workflow, event). A newest run that was cancelled while the same
  # workflow has a successful run on this commit only looks red: typically a duplicate run started
  # at the same moment and cancelled by concurrency. A newest failure is always treated as real.
  def classify_runs(runs)
    return { state: "none", rerunIds: [] } if runs.empty?

    succeeded = runs.select { |r| r[:conclusion] == "success" }.map { |r| r[:workflow_id] }.uniq
    pending = false
    red = false
    stale = false
    cancelled_only = false
    rerun_ids = []
    newest_runs(runs).each_value do |r|
      if r[:status] != "completed"
        pending = true
      elsif !BAD.include?(r[:conclusion])
        next
      elsif r[:conclusion] == "cancelled" && succeeded.include?(r[:workflow_id])
        stale = true
        rerun_ids << r[:id]
      elsif r[:conclusion] == "cancelled"
        cancelled_only = true
        rerun_ids << r[:id]
      else
        red = true
      end
    end
    state = if red then "red"
            elsif pending then "pending"
            elsif stale then "stale-red"
            elsif cancelled_only then "cancelled"
            else "green"
            end
    { state: state, rerunIds: rerun_ids }
  end

  # Cancelled runs that are not the newest of their (workflow, event) group while that group's newest
  # run succeeded. They are not re-run, but GitHub still shows them grey on the PR page.
  def leftover_cancelled(runs)
    newest = newest_runs(runs)
    runs
      .select { |r| r[:conclusion] == "cancelled" }
      .select do |r|
        n = newest[run_key(r)]
        n[:id] != r[:id] && n[:conclusion] == "success"
      end
      .map { |r| r[:id] }
  end

  # A stack parent outside the listed PRs: an open PR in the same repository whose head is our base
  def pick_stack_parent(candidates, repo, self_number)
    hit = candidates.find do |c|
      c[:state] == "open" && c[:number] != self_number && (c.dig(:head, :repo, :full_name) || repo) == repo
    end
    hit && hit[:number]
  end

  def review_summary(reviews)
    at = ->(r) { r[:submitted_at] || "" }
    latest = {}
    reviews.each_with_index.sort_by { |r, i| [at.call(r), i] }.each do |r, _|
      next if %w[COMMENTED PENDING].include?(r[:state])

      latest[r.dig(:user, :login)] = r[:state]
    end
    count = ->(s) { latest.values.count(s) }
    parts = []
    parts << "approved:#{count.call("APPROVED")}" if count.call("APPROVED").positive?
    parts << "changes:#{count.call("CHANGES_REQUESTED")}" if count.call("CHANGES_REQUESTED").positive?
    parts.empty? ? "-" : parts.join(",")
  end

  def stack_parents(prs)
    # A fork's head branch is not a branch of this repository, so it is never a stack parent.
    # (A nil ref renders as "null", as a JS template literal would.)
    key = ->(repo, ref) { "#{repo}:#{ref.nil? ? "null" : ref}" }
    by_head = prs
              .select { |p| !p[:headRepo] || p[:headRepo] == p[:baseRepo] }
              .to_h { |p| [key.call(p[:baseRepo], p[:head]), p[:number]] }
    prs.each_with_object({}) do |p, out|
      parent = by_head[key.call(p[:baseRepo], p[:base])]
      out[p[:number]] = parent if parent && parent != p[:number]
    end
  end

  def duplicate_titles(prs)
    prs
      .select { |p| p[:state] == "open" || p[:state] == "draft" }
      .group_by { |p| p[:title] }
      .values
      .map { |g| g.map { |p| p[:number] } }
      .select { |g| g.length > 1 }
      .map(&:sort)
  end

  def format_local(t)
    t.strftime("%Y-%m-%d %H:%M")
  end

  CI_MARK = { "green" => "✓", "red" => "✗", "stale-red" => "~", "pending" => "…", "cancelled" => "⊘", "none" => "-" }.freeze

  def render_repo(repo, rows)
    lines = ["## #{repo} (#{rows.length})"]
    rows.sort_by { |r| r[:number] }.each do |r|
      cols = [
        "##{r[:number]}".ljust(7),
        r[:state].ljust(6),
        r[:review].ljust(11),
        CI_MARK[r[:ci]] || "?",
        r[:conflict] ? "conflict" : "",
        r[:parent] ? "↑##{r[:parent]}" : "",
        r[:title]
      ].each_with_index.select { |c, i| i < 4 || c != "" }.map(&:first)
      lines << "  #{cols.join("  ")}"
    end
    lines.join("\n")
  end

  # ---- gh I/O below ----

  def gh(args)
    stdout, stderr, status = Open3.capture3("gh", *args)
    stdout.force_encoding("UTF-8")
    stderr.force_encoding("UTF-8")
    raise GhError.new("Command failed: gh #{args.join(" ")}\n#{stderr}", stderr) unless status.success?

    stdout
  rescue Errno::ENOENT
    raise GhError.new("spawn gh ENOENT", "")
  end

  def api(path)
    JSON.parse(gh(["api", path]), symbolize_names: true)
  end

  def current_repo
    gh(%w[repo view --json nameWithOwner --jq .nameWithOwner]).strip
  end

  # Like encodeURIComponent
  def encode_component(s)
    s.to_s.b.gsub(/[^A-Za-z0-9\-_.!~*'()]/) { |c| format("%%%02X", c.ord) }
  end

  def pool(items, size, &fn)
    out = Array.new(items.length)
    queue = Queue.new
    items.each_index { |i| queue << i }
    workers = Array.new([size, items.length].min) do
      Thread.new do
        loop do
          k = begin
            queue.pop(true)
          rescue ThreadError
            break
          end
          out[k] = fn.call(items[k])
        end
      end
    end
    workers.each(&:join)
    out
  end

  def paged(path, pick, max_pages = 10)
    items = []
    last = nil
    (1..max_pages).each do |page|
      sep = path.include?("?") ? "&" : "?"
      last = api("#{path}#{sep}per_page=100&page=#{page}")
      batch = pick.call(last)
      items.concat(batch)
      break if batch.length < 100
    end
    [items, last]
  end

  def iso(t)
    t.getutc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
  end

  def search_query(author, since, until_time, repo, by = "created")
    range = until_time ? "#{iso(since)}..#{iso(until_time)}" : ">=#{iso(since)}"
    q = "is:pr author:#{author} #{by}:#{range}"
    q += repo.include?("/") ? " repo:#{repo}" : " user:#{repo}" if repo
    q
  end

  def search_prs(author, since, until_time, repo, by)
    q = search_query(author, since, until_time, repo, by)
    items, last = paged("search/issues?q=#{encode_component(q)}", ->(r) { r[:items] })
    total_count = last.is_a?(Hash) ? last[:total_count] : nil
    truncated = (total_count || 0) > items.length || (last.is_a?(Hash) && last[:incomplete_results] == true)
    found = items.map { |it| { repo: it[:repository_url].sub(%r{\A.*/repos/}, ""), number: it[:number] } }
    [found, truncated, total_count || items.length]
  end

  def detail(repo:, number:)
    pr = api("repos/#{repo}/pulls/#{number}")
    state = if pr[:merged_at] then "merged"
            elsif pr[:state] == "closed" then "closed"
            elsif pr[:draft] then "draft"
            else "open"
            end
    live = state == "open" || state == "draft"
    # mergeable can be null while GitHub computes it; fetch once more
    pr = api("repos/#{repo}/pulls/#{number}") if live && pr[:mergeable].nil?
    reviews, = paged("repos/#{repo}/pulls/#{number}/reviews", ->(r) { r })
    ci = { state: "none", rerunIds: [] }
    leftovers = []
    if live
      runs, = paged("repos/#{repo}/actions/runs?head_sha=#{pr[:head][:sha]}", ->(r) { r[:workflow_runs] }, 5)
      ci = classify_runs(runs)
      leftovers = leftover_cancelled(runs)
    end
    {
      repo: repo,
      number: number,
      title: pr[:title],
      url: pr[:html_url],
      state: state,
      base: pr[:base][:ref],
      head: pr[:head][:ref],
      baseRepo: pr.dig(:base, :repo, :full_name) || repo,
      headRepo: pr.dig(:head, :repo, :full_name),
      createdAt: pr[:created_at],
      review: review_summary(reviews),
      ci: ci[:state],
      rerunIds: ci[:rerunIds],
      leftovers: leftovers,
      live: live,
      conflict: live && pr[:mergeable] == false
    }
  rescue StandardError => e
    # One failed PR should not hide the rest
    { repo: repo, number: number, title: "(failed to fetch: #{first_line(e.message)})", state: "error", review: "-", ci: "none", rerunIds: [], conflict: false, base: nil, head: nil }
  end

  def first_line(s)
    s.to_s.split("\n", 2)[0] || ""
  end

  # Approximates String#localeCompare for repository names
  def locale_key(s)
    [s.downcase.tr("_-", "\x01\x02"), s.swapcase]
  end

  def main(argv, out = $stdout)
    log = ->(s) { out.write("#{s}\n") }
    opts = parse_args(argv)
    if opts[:help]
      log.call(HELP)
      return 0
    end
    now = Time.now
    since = parse_since(opts[:since], now)
    until_time = opts[:until] ? parse_until(opts[:until], now) : nil
    truncated = false
    if opts[:numbers].any?
      # PR numbers given directly: no date window, one repository
      repo = opts[:repo]&.include?("/") ? opts[:repo] : current_repo
      found = opts[:numbers].map { |number| { repo: repo, number: number } }
      total = found.length
    else
      found, truncated, total = search_prs(opts[:author], since, until_time, opts[:repo], opts[:by])
    end
    prs = pool(found, 6) { |f| detail(**f) }

    by_repo = prs.group_by { |p| p[:repo] }
    protected_cache = {}
    is_protected = lambda do |repo, branch|
      protected_cache.fetch("#{repo}:#{branch}") do
        protected_cache["#{repo}:#{branch}"] =
          begin
            api("repos/#{repo}/branches/#{encode_component(branch)}")[:protected] == true
          rescue StandardError
            true
          end
      end
    end
    parents_by_repo = by_repo.transform_values { |list| stack_parents(list) }
    prs = prs.map do |p|
      parent = parents_by_repo[p[:repo]][p[:number]]
      # Look outside the listed PRs, but never treat a protected branch (develop, main, ...) as a stack
      unless parent || !p[:live] || !p[:base] || is_protected.call(p[:repo], p[:base])
        owner = p[:repo].split("/")[0]
        candidates = begin
          api("repos/#{p[:repo]}/pulls?state=open&head=#{encode_component("#{owner}:#{p[:base]}")}&per_page=10")
        rescue StandardError
          []
        end
        parent = pick_stack_parent(candidates, p[:repo], p[:number])
      end
      p.merge(parent: parent)
    end
    by_repo = prs.group_by { |p| p[:repo] }

    reruns = []
    rerun_errors = []
    if opts[:rerun]
      prs.each do |p|
        p[:rerunIds].each do |id|
          gh(["run", "rerun", id.to_s, "--failed", "-R", p[:repo]])
          reruns << { repo: p[:repo], pr: p[:number], run: id }
        rescue StandardError => e
          msg = e.respond_to?(:stderr) && !e.stderr.to_s.empty? ? e.stderr : e.message
          rerun_errors << { repo: p[:repo], pr: p[:number], run: id, error: first_line(msg.to_s.strip) }
        end
      end
    end

    dups = by_repo.flat_map { |repo, list| duplicate_titles(list).map { |g| { repo: repo, numbers: g } } }

    if opts[:json]
      log.call(JSON.pretty_generate(since: iso(since), until: until_time && iso(until_time), prs: prs, duplicateTitles: dups, reruns: reruns, rerunErrors: rerun_errors, truncated: truncated, total: total))
      return 0
    end
    if opts[:numbers].any?
      log.call("#{prs.length} PRs given by number\n")
    else
      span = "#{format_local(since)} to #{until_time ? format_local(until_time) : "now"}"
      log.call("#{prs.length} PRs by #{opts[:author]}, #{opts[:by]} #{span}\n")
    end
    repos = by_repo.keys.sort do |a, b|
      c = by_repo[b].length <=> by_repo[a].length
      c.zero? ? locale_key(a) <=> locale_key(b) : c
    end
    repos.each { |repo| log.call("#{render_repo(repo, by_repo[repo])}\n") }
    dups.each { |d| log.call("Open PRs with the same title: #{d[:repo]} #{d[:numbers].map { |n| "##{n}" }.join(" ")}") }
    stale = prs.select { |p| %w[stale-red cancelled].include?(p[:ci]) }
    log.call("Looks red or cancelled: #{stale.map { |p| "#{p[:repo]}##{p[:number]}" }.join(" ")} (use --rerun to re-run)") if stale.any? && !opts[:rerun]
    log.call("Re-ran #{reruns.length} run(s)") if reruns.any?
    left = prs.select { |p| p[:leftovers] && !p[:leftovers].empty? }
    if left.any?
      log.call("Not re-run, still grey on the PR page: older cancelled runs whose workflow then succeeded (#{left.map { |p| "#{p[:repo]}##{p[:number]}" }.join(" ")})")
    end
    rerun_errors.each { |r| log.call("Could not re-run: #{r[:repo]}##{r[:pr]} run #{r[:run]} (#{r[:error]})") }
    log.call("Note: search returned only #{prs.length} of #{total} PRs (the 1,000-result limit). Narrow --since.") if truncated
    0
  end
end
