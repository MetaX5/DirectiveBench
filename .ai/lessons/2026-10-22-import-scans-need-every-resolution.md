---
title: An import scan must be O(1) per token start and check every way a path can resolve
date: 2026-10-22
tags: [security, performance, claude-code, paths]
source: .ai/runs/2026-10-22-issue-99-claude-code-builders.md
---

# An import scan must be O(1) per token start and check every way a path can resolve

## Context

SPEC-118 FR-118-27 treats every `@` as the start of an import token running to the next
whitespace. Implementing it (issue #99) showed three traps. A word made of many `@` (`@@@@…`,
`@/@/@/…`) has one token per `@`, each a suffix of the word, so slicing or normalising every token
is quadratic. A token can resolve differently lexically (`path.resolve`, which drops `link/..`)
and physically (`realpath`, which follows the link first), and a file reached through an inside
symbolic link resolves its relative `..` from the link's shallower place. And `setup` commands run
before the artifact install, so a planted `.claude` link would have redirected the install onto a
host directory before the pre-spawn check ran.

## Lesson

A scan over untrusted text must decide in O(1) per token start whether a token needs work (process
the word right to left, carrying "a `..` / shortening sequence follows" flags), bound the work it
does do with named limits that fail closed, and resolve each candidate lexically, physically and
from every place the file can be read from. Writes into a workspace after `setup` must refuse
links and hard links themselves, not rely on a later check.

## How to apply

- Count resolved candidates per occurrence against a named limit; cap token length by `PATH_MAX`
  but refuse (not skip) an over-long token that normalisation could shorten.
- Check `realpath` of both the lexical and the raw joined path; when the workspace has a link,
  refuse relative tokens that climb above their own directory.
- In any writer that runs after untrusted commands, never write through workspace paths after
  checking them (a surviving process can re-link an ancestor in between — the Codex review of PR
  #108 reproduced it): build the result in a private `mkdtemp` directory on the same file system
  and `rename` each top-level entry in, then `lstat` what landed; read existing files with
  `O_NOFOLLOW` plus an `fstat`/`lstat` identity check. And kill the untrusted command's process
  group when it ends. Pin the workspace itself (device, inode, canonical path) before untrusted
  commands run and re-check the pin around every read, write and scan: a command can replace the
  workspace path with a link, and `rename`/`realpath` follow it (Codex round 2 on PR #108).
- Model the consumer's parser, not a regex in isolation: Claude Code lexes memory files as
  Markdown and matches imports per text piece (so `@/etc/hostname*x*` imports `/etc/hostname`),
  and accepts `--- ` as a frontmatter opener that the core parser ignores. Review round 1 of PR
  #108 found both by reading the installed binary's patterns; check prefixes at every lexer split
  character and fail closed when a file starts a block the parser did not read.
- Test linear time with a size ratio on adversarial inputs (lesson 2026-10-21 on timing tests).
