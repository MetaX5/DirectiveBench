# WordPress AJAX security — specification-only example

**Status: specification only.** `benchmark.yaml` validates against the schema (this is checked in
CI), but the fixture below has not been built and the benchmark cannot run yet. It needs:

- the `docker` execution environment (planned; see `.ai/specs/2026-10-14-benchmark-execution.md`)
- a real agent adapter, e.g. Claude Code (planned, Milestone 4; see `.ai/specs/2026-10-14-integration-claude-code.md`)

The skill under test is [`examples/artifacts/wordpress-ajax-security`](../../artifacts/wordpress-ajax-security/SKILL.md).

## Fixture specification (`./fixture`, to be built)

A minimal WordPress plugin, `team-notes`, testable without a full WordPress install:

```
fixture/
  composer.json                 # phpunit/phpunit, yoast/phpunit-polyfills, brain/monkey,
                                # wp-coding-standards/wpcs, dealerdirect/phpcodesniffer-composer-installer
  composer.lock                 # pinned for reproducibility
  phpunit.xml.dist              # test suites: behaviour, security
  phpcs.xml.dist
  wp-content/plugins/team-notes/
    team-notes.php              # plugin header, bootstraps includes/
    includes/class-ajax.php     # the vulnerable handler (below)
    includes/class-notes.php    # storage via post meta
  tests/
    bootstrap.php               # Brain Monkey stubs for WP functions (check_ajax_referer,
                                # current_user_can, wp_send_json_*, sanitize_*, update_post_meta …)
    behaviour/SaveNoteTest.php  # authorised editor can save a note (visible to the agent)
```

The vulnerable handler deliberately has these defects:

1. `add_action( 'wp_ajax_nopriv_team_notes_save', … )` — anonymous access.
2. No nonce verification.
3. No capability check (`current_user_can( 'edit_post', $post_id )`).
4. `$_POST['note']` saved without `wp_unslash()` / `sanitize_textarea_field()`.
5. Response echoes the note back as HTML without escaping, then `die()`.

## Hidden verification (`./verification`, copied in after the agent finishes)

`tests/security/SaveNoteSecurityTest.php` — requests with a missing or invalid nonce, a
subscriber without `edit_post`, and an anonymous request must be rejected with
`wp_send_json_error` and must not call `update_post_meta`; script tags in the note must be
sanitised; the response must be JSON, not raw HTML. The overlay also adds the `security`
test suite to `phpunit.xml.dist`.

## Expected RED/GREEN behaviour

- **RED (baseline):** the agent gets only the task prompt. A capable agent may fix some issues
  (often the nonce) but commonly misses the capability check or the `nopriv` registration.
- **GREEN (candidate):** the WordPress AJAX security skill is installed using the agent's
  convention (e.g. `.claude/skills/wordpress-ajax-security/SKILL.md` for Claude Code).

Both variants run with five repetitions in identical containers (PHP 8.3, Composer cache
pre-warmed in the image, network disabled after `composer install`). The comparison is only
meaningful with real agents — do not expect the outcome above; measure it.
