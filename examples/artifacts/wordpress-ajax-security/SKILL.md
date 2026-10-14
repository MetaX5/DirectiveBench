---
name: wordpress-ajax-security
description: Use when adding or changing WordPress AJAX handlers (wp_ajax_* / wp_ajax_nopriv_* actions) or admin-post endpoints. Covers nonces, capability checks, sanitisation, escaping and safe responses.
---

# Secure WordPress AJAX handlers

Apply every rule below to each `wp_ajax_*` and `wp_ajax_nopriv_*` handler you write or modify.

## 1. Verify intent with a nonce

- Create the nonce where the request originates: `wp_create_nonce( 'myplugin_save_note' )`.
- Verify it first thing in the handler: `check_ajax_referer( 'myplugin_save_note', 'nonce' );`
- Use one action string per operation; never reuse a generic nonce.

## 2. Check capabilities

- Nonces are not authorisation. Call `current_user_can()` with the narrowest capability
  (e.g. `edit_post`, with the object ID) before reading or changing data.
- Only register `wp_ajax_nopriv_*` when anonymous access is an explicit requirement.

## 3. Validate and sanitise input

- Read input through `wp_unslash()` and sanitise for its type: `absint()`, `sanitize_text_field()`,
  `sanitize_key()`, `sanitize_textarea_field()`, `wp_kses_post()`.
- Validate against allowed values; reject unexpected input with `wp_send_json_error( …, 400 )`.

## 4. Use safe data access

- Use `$wpdb->prepare()` for every query with variables; prefer WordPress APIs
  (`update_post_meta`, `get_posts`) over raw SQL.

## 5. Escape output and respond correctly

- Return data with `wp_send_json_success()` / `wp_send_json_error()` and proper HTTP status codes.
- Escape any HTML you build with `esc_html()`, `esc_attr()`, `esc_url()` or `wp_kses()`.

## 6. Stay in scope

- Change only the files needed for the task; do not modify tests, vendor code or unrelated plugins.
