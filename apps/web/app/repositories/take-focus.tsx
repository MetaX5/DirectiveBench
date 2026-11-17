'use client';

import { useEffect } from 'react';

/**
 * Moves focus to the element with id `target` when it appears, and again when `state` changes,
 * but only while focus is on the page body (issue 243). Every form on /repositories posts to a
 * server action that redirects back with new search params, which re-mounts the page, and a
 * job's result arrives by re-render (`AutoRefresh`); either way the control that was used is gone
 * or disabled and focus drops to <body>. Next.js only scrolls to a fragment, it never focuses
 * (lesson 2026-11-16). Focus the user moved elsewhere meanwhile stays where it is, as on the
 * category and artifact forms. The target is a `role="status"`/`"alert"` line with
 * `tabIndex={-1}`, a confirmation panel or an invalid field, so focusing it announces the result.
 */
export function TakeFocus({ target, state }: { target: string; state?: string }) {
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.getElementById(target)?.focus();
  }, [target, state]);
  return null;
}
