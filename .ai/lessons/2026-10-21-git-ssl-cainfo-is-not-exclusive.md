---
title: GIT_SSL_CAINFO is not an exclusive trust store — libcurl may keep its compiled-in CA directory
date: 2026-10-21
tags: [git, tls, security, testing]
source: .ai/runs/2026-10-21-issue-61-hosted-fetch-deviations.md
---

# GIT_SSL_CAINFO is not an exclusive trust store — libcurl may keep its compiled-in CA directory

## Context

Issue #61 added forwarding of an explicit CA bundle (`GIT_SSL_CAINFO`) to hosted git. The spec
first said the bundle "replaces git's default one". The manual check with the built CLI against
github.com and `GIT_SSL_CAINFO` naming an unrelated self-signed CA still registered the
repository. `GIT_CURL_VERBOSE=1` showed why: Ubuntu's git 2.53 (libcurl on GnuTLS) reports
`CAfile: 1 certificates in <bundle>` **and** `CApath: 398 certificates in /etc/ssl/certs` — the
variable replaces only the CA *file*; the build's compiled-in CA directory is still trusted.
The offline loopback test could not show it: its self-signed server certificate is in neither.

## Lesson

What `GIT_SSL_CAINFO` (`http.sslCAInfo`) trusts depends on the libcurl build and TLS backend
(OpenSSL, GnuTLS, Schannel, Secure Transport). Never document it as exclusive, and never rely on
it to *narrow* trust. It is safe to forward for *adding* a proxy CA: verification stays on.

## How to apply

- Check trust behaviour with `GIT_CURL_VERBOSE=1 git ls-remote https://github.com/<o>/<r> HEAD`
  and read the `CAfile`/`CApath` lines; record the git version and TLS backend in the run log.
- Test that an unknown CA fails against a loopback HTTPS server with a self-signed certificate
  (`packages/runner/test/hosted-repository-tls.test.ts`), not against github.com, whose CA is in the
  system store.
