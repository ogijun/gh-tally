require "minitest/autorun"
require "tally"

class TallyTest < Minitest::Test
  T = GhTally

  def test_parse_args_defaults_and_flags
    assert_equal(
      { since: "7d", until: nil, author: "@me", repo: nil, rerun: false, json: false, help: false, by: "created", numbers: [] },
      T.parse_args([])
    )
    o = T.parse_args(%w[--since fri --repo o/r --rerun --json])
    assert_equal "fri", o[:since]
    assert_equal "o/r", o[:repo]
    assert_equal true, o[:rerun]
    assert_equal true, o[:json]
  end

  def test_parse_since_weekday_is_midnight_of_most_recent_such_day
    now = Time.local(2026, 10, 29, 15, 0) # 2026-10-29 Thursday 15:00
    assert_equal Time.local(2026, 10, 23, 0, 0), T.parse_since("fri", now)
    assert_equal Time.local(2026, 10, 29, 0, 0), T.parse_since("thu", now)
    assert_equal Time.local(2026, 10, 26, 0, 0), T.parse_since("mon", now)
  end

  def test_parse_since_days_ago_date_and_today
    now = Time.local(2026, 10, 29, 15, 0)
    assert_equal Time.local(2026, 10, 26, 0, 0), T.parse_since("3d", now)
    assert_equal Time.local(2026, 10, 1, 0, 0), T.parse_since("2026-10-01", now)
    assert_equal Time.local(2026, 10, 29, 0, 0), T.parse_since("today", now)
    assert_raises(RuntimeError) { T.parse_since("someday", now) }
  end

  def test_classify_runs_success_in_same_workflow_makes_failure_or_cancel_look_red
    runs = [
      { id: 1, name: "Test", workflow_id: 10, event: "push", status: "completed", conclusion: "cancelled" },
      { id: 2, name: "Test", workflow_id: 10, event: "pull_request", status: "completed", conclusion: "success" },
      { id: 3, name: "Lint", workflow_id: 11, status: "completed", conclusion: "success" }
    ]
    assert_equal({ state: "stale-red", rerunIds: [1] }, T.classify_runs(runs))
  end

  def test_classify_runs_failure_without_success_is_red_running_is_pending
    assert_equal "red", T.classify_runs([{ id: 1, name: "T", workflow_id: 1, status: "completed", conclusion: "failure" }])[:state]
    assert_equal "pending", T.classify_runs([{ id: 1, name: "T", workflow_id: 1, status: "in_progress", conclusion: nil }])[:state]
    assert_equal "none", T.classify_runs([])[:state]
    assert_equal(
      { state: "cancelled", rerunIds: [5] },
      T.classify_runs([{ id: 5, name: "T", workflow_id: 1, status: "completed", conclusion: "cancelled" }])
    )
  end

  def test_review_summary_uses_latest_state_per_reviewer
    reviews = [
      { user: { login: "a" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-01T00:00:00Z" },
      { user: { login: "a" }, state: "APPROVED", submitted_at: "2026-10-02T00:00:00Z" },
      { user: { login: "b" }, state: "COMMENTED", submitted_at: "2026-10-02T00:00:00Z" }
    ]
    assert_equal "approved:1", T.review_summary(reviews)
    assert_equal "-", T.review_summary([])
    assert_equal(
      "changes:1",
      T.review_summary([{ user: { login: "c" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-03T00:00:00Z" }])
    )
  end

  def test_stack_parents_base_that_is_another_prs_head_makes_that_pr_the_parent
    prs = [
      { number: 1, base: "develop", head: "feat/a" },
      { number: 2, base: "feat/a", head: "feat/b" },
      { number: 3, base: "feat/b", head: "feat/c" }
    ]
    assert_equal({ 2 => 1, 3 => 2 }, T.stack_parents(prs))
  end

  def test_duplicate_titles_among_open_prs
    prs = [
      { number: 1, title: "x", state: "open" },
      { number: 2, title: "x", state: "open" },
      { number: 3, title: "x", state: "merged" },
      { number: 4, title: "y", state: "open" }
    ]
    assert_equal [[1, 2]], T.duplicate_titles(prs)
  end

  def test_render_repo_one_line_with_state_review_ci_parent_title
    out = T.render_repo("o/r", [
                          { number: 2, state: "draft", review: "-", ci: "stale-red", conflict: false, parent: 1, title: "B" },
                          { number: 1, state: "open", review: "approved:1", ci: "green", conflict: true, parent: nil, title: "A" }
                        ])
    assert_match(%r{\A## o/r \(2\)}, out)
    assert_match(/#1 +open +approved:1 +✓ +conflict +A/, out)
    assert_match(/#2 +draft +- +~ +↑#1 +B/, out)
  end

  def test_format_local_as_yyyy_mm_dd_hh_mm
    assert_equal "2026-10-23 00:05", T.format_local(Time.local(2026, 10, 23, 0, 5))
  end

  def test_parse_args_flag_needing_a_value_without_one_is_an_error
    assert_raises(RuntimeError) { T.parse_args(["--since"]) }
    assert_raises(RuntimeError) { T.parse_args(%w[--since --json]) }
  end

  def test_parse_since_full_weekday_name_or_three_letters_only_nonexistent_date_is_error
    now = Time.local(2026, 10, 29, 15, 0)
    assert_equal Time.local(2026, 10, 23, 0, 0), T.parse_since("friday", now)
    assert_raises(RuntimeError) { T.parse_since("monkey", now) }
    assert_raises(RuntimeError) { T.parse_since("2026-02-31", now) }
  end

  def test_parse_until_date_weekday_today_is_end_of_that_day
    now = Time.local(2026, 10, 29, 15, 0)
    assert_equal Time.local(2026, 10, 26, 0, 0), T.parse_until("2026-10-25", now)
    assert_equal Time.local(2026, 10, 24, 0, 0), T.parse_until("fri", now)
  end

  def test_classify_runs_only_newest_run_per_workflow_and_event_newest_success_is_green
    runs = [
      { id: 1, workflow_id: 10, event: "pull_request", run_number: 1, status: "completed", conclusion: "failure" },
      { id: 2, workflow_id: 10, event: "pull_request", run_number: 2, status: "completed", conclusion: "success" }
    ]
    assert_equal({ state: "green", rerunIds: [] }, T.classify_runs(runs))
  end

  def test_classify_runs_newest_cancelled_with_success_in_other_event_looks_red_rerun_only_newest
    runs = [
      { id: 1, workflow_id: 10, event: "push", run_number: 1, status: "completed", conclusion: "cancelled" },
      { id: 3, workflow_id: 10, event: "push", run_number: 3, status: "completed", conclusion: "cancelled" },
      { id: 2, workflow_id: 10, event: "pull_request", run_number: 2, status: "completed", conclusion: "success" }
    ]
    assert_equal({ state: "stale-red", rerunIds: [3] }, T.classify_runs(runs))
  end

  def test_stack_parents_fork_head_is_not_a_parent
    prs = [
      { number: 1, base: "main", head: "main", headRepo: "fork/r", baseRepo: "o/r" },
      { number: 2, base: "main", head: "feat", headRepo: "o/r", baseRepo: "o/r" }
    ]
    assert_equal({}, T.stack_parents(prs))
  end

  def test_parse_args_by_selects_date_field_and_numbers_are_pr_numbers
    o = T.parse_args(%w[5249 5250 --by updated -R o/r])
    assert_equal [5249, 5250], o[:numbers]
    assert_equal "updated", o[:by]
    assert_equal "o/r", o[:repo]
    assert_equal "created", T.parse_args([])[:by]
    assert_raises(RuntimeError) { T.parse_args(%w[--by closed]) }
  end

  def test_search_query_by_maps_to_search_qualifier
    since = Time.utc(2026, 10, 26)
    assert_equal "is:pr author:@me updated:>=2026-10-26T00:00:00.000Z", T.search_query("@me", since, nil, nil, "updated")
    assert_equal(
      "is:pr author:@me merged:2026-10-26T00:00:00.000Z..2026-10-27T00:00:00.000Z user:o",
      T.search_query("@me", since, Time.utc(2026, 10, 27), "o", "merged")
    )
  end

  def test_classify_runs_newer_cancelled_with_older_success_looks_red_rerun_the_cancelled_one
    runs = [
      { id: 40_637_690_930, workflow_id: 1, event: "pull_request", run_number: 10, status: "completed", conclusion: "success" },
      { id: 40_637_691_891, workflow_id: 1, event: "pull_request", run_number: 11, status: "completed", conclusion: "cancelled" },
      { id: 9, workflow_id: 2, event: "pull_request", run_number: 3, status: "completed", conclusion: "success" }
    ]
    assert_equal({ state: "stale-red", rerunIds: [40_637_691_891] }, T.classify_runs(runs))
  end

  def test_classify_runs_newest_failure_stays_red_even_if_earlier_run_succeeded
    runs = [
      { id: 1, workflow_id: 1, event: "pull_request", run_number: 1, status: "completed", conclusion: "success" },
      { id: 2, workflow_id: 1, event: "pull_request", run_number: 2, status: "completed", conclusion: "failure" }
    ]
    assert_equal({ state: "red", rerunIds: [] }, T.classify_runs(runs))
  end

  def test_pick_stack_parent_open_pr_in_same_repo_whose_head_is_our_base
    candidates = [
      { number: 9, state: "closed", head: { repo: { full_name: "o/r" } } },
      { number: 7, state: "open", head: { repo: { full_name: "o/r" } } }
    ]
    assert_equal 7, T.pick_stack_parent(candidates, "o/r", 5)
    assert_nil T.pick_stack_parent([], "o/r", 5)
    assert_nil T.pick_stack_parent([{ number: 5, state: "open", head: { repo: { full_name: "o/r" } } }], "o/r", 5)
  end

  def test_leftover_cancelled_runs_older_than_a_success_in_same_workflow_and_event
    runs = [
      { id: 1, workflow_id: 1, event: "pull_request", run_number: 1, status: "completed", conclusion: "cancelled" },
      { id: 2, workflow_id: 1, event: "pull_request", run_number: 2, status: "completed", conclusion: "success" },
      { id: 3, workflow_id: 2, event: "pull_request", run_number: 1, status: "completed", conclusion: "success" }
    ]
    assert_equal [1], T.leftover_cancelled(runs)
  end

  def test_main_help_prints_help_plus_blank_line_and_returns_zero
    out = StringIO.new
    assert_equal 0, T.main(["--help"], out)
    assert_equal "#{T::HELP}\n", out.string
  end
end
