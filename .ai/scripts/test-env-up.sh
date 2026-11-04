#!/bin/sh
# om-prepare-test-env: generated entrypoint (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-11-04 generated (cold 14s incl. pnpm build, warm 0.4s reused; run log 2026-11-04-test-env-scripts)
#
# Starts the built DirectiveBench CLI the way apps/web/playwright.config.ts boots it:
# `pnpm build`, then `directivebench demo` and `directivebench serve` against a fresh data
# directory, on 127.0.0.1 and a fixed port. Mock agent only: the runner registers only the mock
# adapter, and a fake `claude` first on PATH keeps a real Claude Code (and its login) out of the
# Agent Connections checks. All data lives under one directory in /var/tmp, outside every git
# work tree and outside $HOME (.ai/lessons/2026-10-30-keep-heavy-data-off-tmp.md);
# test-env-down.sh stops the server and removes that directory.
#
# Usage: sh .ai/scripts/test-env-up.sh [--force] [--force-rebuild]
#   --force          restart even when a healthy environment is running (fresh demo data)
#   --force-rebuild  ignore the build cache: pnpm install + pnpm build, then restart
# Environment overrides:
#   TEST_ENV_PORT               port on 127.0.0.1 (default 4398; the e2e suite uses 4399)
#   TEST_ENV_ROOT               data root (default /var/tmp/directivebench-test-env-<checkout id>)
#   TEST_ENV_CACHE_TTL_SECONDS  reuse a running environment at most this long (default 3600)
set -eu

# --- project-specific variables ---------------------------------------------------------------
PORT=${TEST_ENV_PORT:-4398}
HOST=127.0.0.1
HEALTH_PATH=/api/health
CACHE_TTL_SECONDS=${TEST_ENV_CACHE_TTL_SECONDS:-3600}
READY_TIMEOUT_SECONDS=120   # matches the e2e webServer timeout
LOCK_WAIT_SECONDS=300       # how long to wait for another bootstrap of this checkout
# Build inputs: every tracked or untracked, not ignored file except .ai/ (run logs, QA state).
BUILD_EXCLUDE_PATHSPEC=':(exclude).ai'
BUILD_ENV_VARS="NODE_ENV"
ARTIFACTS="apps/cli/dist/cli.js apps/cli/dist/web/.next/BUILD_ID"
CLI=apps/cli/dist/cli.js
QA_DIR=.ai/qa
SCRIPTS_DIR=.ai/scripts
BROWSER_PROVIDER=agent-browser
AGENT_BROWSER_VERSION=v0.35.2   # pin in .ai/browsers/agent-browser.md
# ----------------------------------------------------------------------------------------------

FORCE=0
FORCE_REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --force-rebuild) FORCE_REBUILD=1; FORCE=1 ;;
    *) echo "test-env-up: unknown argument: $arg" >&2; exit 64 ;;
  esac
done

die() { echo "test-env-up: $*" >&2; exit 1; }

case "$PORT" in ''|*[!0-9]*) die "TEST_ENV_PORT must be a number, got '$PORT'" ;; esac
case "$CACHE_TTL_SECONDS" in ''|*[!0-9]*) die "TEST_ENV_CACHE_TTL_SECONDS must be a number" ;; esac
command -v node >/dev/null 2>&1 || die "node (>= 22.16) is required"
command -v git >/dev/null 2>&1 || die "git is required"

REPO_ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel) || die "not inside a git checkout"
cd "$REPO_ROOT"
CHECKOUT_ID=$(printf '%s' "$REPO_ROOT" | cksum | awk '{print $1}')
ENV_ROOT=${TEST_ENV_ROOT:-/var/tmp/directivebench-test-env-$CHECKOUT_ID}
DESCRIPTOR="$QA_DIR/test-env.json"
BUILD_CACHE="$QA_DIR/test-env-build-cache.json"
LOCK_DIR="$QA_DIR/test-env.lock"
BASE_URL="http://$HOST:$PORT"

# The data root is removed by test-env-down.sh, so it must be ours: absolute, a recognisable
# name, outside $HOME and outside every git work tree (TMPDIR inside one breaks the app's
# workspace checks and the e2e suite).
case "$ENV_ROOT" in /*) ;; *) die "TEST_ENV_ROOT must be an absolute path" ;; esac
case "$(basename "$ENV_ROOT")" in
  directivebench-test-env-*) ;;
  *) die "the basename of TEST_ENV_ROOT must start with directivebench-test-env-" ;;
esac
ENV_PARENT=$(dirname "$ENV_ROOT")
[ -d "$ENV_PARENT" ] || die "parent of the data root does not exist: $ENV_PARENT"
case "$(cd "$ENV_PARENT" && pwd -P)/" in "$(cd "$HOME" && pwd -P)/"*) die "the data root must be outside \$HOME" ;; esac
if git -C "$ENV_PARENT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "the data root must be outside every git work tree: $ENV_PARENT"
fi

mkdir -p "$QA_DIR"

# --- helpers ----------------------------------------------------------------------------------
now() { date +%s; }

# HTTP probe without curl: exit 0 when GET <url> answers 2xx within 5 s.
probe() {
  node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "$1"
}

# Exit 0 when something accepts TCP connections on HOST:PORT.
port_busy() {
  node -e 'const s=require("net").connect(+process.argv[2],process.argv[1]);s.setTimeout(2000);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))' "$HOST" "$PORT"
}

# Read one top-level or dotted field of the descriptor ("" when missing).
descriptor_field() {
  [ -f "$DESCRIPTOR" ] || return 0
  node -e 'try{let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of process.argv[2].split("."))v=v==null?undefined:v[k];if(v!==undefined&&v!==null)process.stdout.write(String(v))}catch{}' "$DESCRIPTOR" "$1"
}

# True when <pid> is this checkout's `directivebench serve` for this data root.
is_our_server() {
  args=$(ps -ww -p "$1" -o args= 2>/dev/null) || return 1
  case "$args" in *"$REPO_ROOT/$CLI --data-dir $ENV_ROOT/data serve"*) return 0 ;; esac
  return 1
}

stat_list() {
  if stat -c '%n' . >/dev/null 2>&1; then xargs -0 stat -c '%n:%s:%Y' 2>/dev/null
  else xargs -0 stat -f '%N:%z:%m' 2>/dev/null
  fi
}

# path:size:mtime of every build input, the build-shaping env vars and the Node.js version.
fingerprint() {
  {
    git ls-files -z -co --exclude-standard -- . "$BUILD_EXCLUDE_PATHSPEC" | stat_list || true
    for v in $BUILD_ENV_VARS; do eval "printf 'env:%s=%s\n' \"$v\" \"\${$v:-}\""; done
    printf 'node:%s\n' "$(node --version)"
  } | LC_ALL=C sort | cksum | awk '{print $1"-"$2}'
}

build_needed() {
  [ "$FORCE_REBUILD" = 1 ] && return 0
  [ -f "$BUILD_CACHE" ] || return 0
  [ -d node_modules ] || return 0
  cached_fp=$(sed -n 's/.*"sourceFingerprint": *"\([^"]*\)".*/\1/p' "$BUILD_CACHE")
  cached_root=$(sed -n 's/.*"projectRoot": *"\([^"]*\)".*/\1/p' "$BUILD_CACHE")
  [ "$cached_fp" = "$CURRENT_FP" ] || return 0
  [ "$cached_root" = "$REPO_ROOT" ] || return 0   # a worktree never inherits another's cache
  for a in $ARTIFACTS; do [ -s "$a" ] || return 0; done
  return 1
}

resolve_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then PNPM=pnpm
  elif [ -x "$HOME/.local/share/pnpm/bin/pnpm" ]; then PNPM="$HOME/.local/share/pnpm/bin/pnpm"
  elif command -v corepack >/dev/null 2>&1; then PNPM="corepack pnpm"
  else die "pnpm is required (corepack or ~/.local/share/pnpm/bin, see AGENTS.md section 6)"
  fi
}

# Records the agent-browser state verified at generation time; never installs it (that is
# om-prepare-test-env step 2.4 through .ai/browsers/agent-browser.md).
resolve_browser() {
  BROWSER_INSTALLED=0; BROWSER_COMMAND=""; BROWSER_VERSION=""
  BROWSER_NOTES="agent-browser not found: run the ensure-installed operation of .ai/browsers/agent-browser.md"
  if command -v agent-browser >/dev/null 2>&1; then
    BROWSER_COMMAND=$(command -v agent-browser)
  else
    for f in "${XDG_CACHE_HOME:-$HOME/.cache}/agent-tools/agent-browser/$AGENT_BROWSER_VERSION"/agent-browser-*; do
      case "$f" in *.tmp.*) continue ;; esac
      [ -x "$f" ] && BROWSER_COMMAND=$f && break
    done
  fi
  if [ -n "$BROWSER_COMMAND" ]; then
    BROWSER_INSTALLED=1
    BROWSER_VERSION=$("$BROWSER_COMMAND" --version 2>/dev/null || echo unknown)
    BROWSER_NOTES="use a unique --session per QA run; run doctor --json if a launch fails"
  fi
}

print_result() {
  echo "TEST_ENV_STATUS=running"
  echo "TEST_ENV_BASE_URL=$BASE_URL"
  echo "TEST_ENV_DESCRIPTOR=$DESCRIPTOR"
  echo "TEST_ENV_REUSED=$1"
  echo "BROWSER_PROVIDER=$BROWSER_PROVIDER"
  echo "BROWSER_INSTALLED=$BROWSER_INSTALLED"
}

# --- 1. lock: one bootstrap of this checkout at a time ----------------------------------------
waited=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  owner=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$LOCK_DIR/owner.json" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    echo "test-env-up: removing the stale lock of dead pid $owner" >&2
    rm -rf "$LOCK_DIR"; continue
  fi
  if [ -z "$owner" ] && [ "$waited" -ge 10 ]; then
    echo "test-env-up: removing a lock without an owner" >&2
    rm -rf "$LOCK_DIR"; continue
  fi
  [ "$waited" -ge "$LOCK_WAIT_SECONDS" ] && die "another bootstrap (pid $owner) still holds $LOCK_DIR"
  [ "$waited" = 0 ] && echo "test-env-up: waiting for another bootstrap (pid ${owner:-unknown})" >&2
  sleep 1; waited=$((waited + 1))
done
trap 'rm -rf "$LOCK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '{ "pid": %s, "source": "%s", "acquiredAt": "%s" }\n' \
  "$$" "$SCRIPTS_DIR/test-env-up.sh" "$(date -u +%FT%TZ)" > "$LOCK_DIR/owner.json"

START_TIME=$(now)
CURRENT_FP=$(fingerprint)
resolve_browser

# --- 2. reuse check: attach, do not reboot ----------------------------------------------------
if [ "$FORCE" = 0 ] && [ "$(descriptor_field status)" = running ]; then
  reason=""
  pid=$(descriptor_field app.pid)
  started_epoch=$(descriptor_field startedAtEpoch)
  if [ -z "$pid" ] || ! is_our_server "$pid"; then reason="the recorded server process is gone"
  elif [ "$(descriptor_field baseUrl)" != "$BASE_URL" ]; then reason="the port changed"
  elif ! probe "$BASE_URL$HEALTH_PATH"; then reason="$HEALTH_PATH does not answer"
  elif ! probe "$BASE_URL/"; then reason="the home page does not answer"
  elif [ -z "$started_epoch" ] || [ $(( $(now) - started_epoch )) -gt "$CACHE_TTL_SECONDS" ]; then
    reason="older than ${CACHE_TTL_SECONDS}s"
  elif [ "$(descriptor_field sourceFingerprint)" != "$CURRENT_FP" ]; then
    reason="source files changed since it started"
  fi
  if [ -z "$reason" ]; then
    echo "test-env-up: reusing the running environment ($(descriptor_field runId))" >&2
    print_result 1
    exit 0
  fi
  echo "test-env-up: not reusing the recorded environment: $reason" >&2
fi

# Anything this checkout started before (running, stale or crashed) goes first.
if [ -f "$DESCRIPTOR" ] || [ -e "$ENV_ROOT" ]; then
  TEST_ENV_LOCK_HELD=1 TEST_ENV_ROOT="$ENV_ROOT" sh "$SCRIPTS_DIR/test-env-down.sh" >&2
fi
if port_busy; then
  die "port $PORT on $HOST is in use by a process this script did not start; stop it or set TEST_ENV_PORT"
fi

# --- 3. build cache: pnpm install + pnpm build only when an input changed ---------------------
REBUILT=0
if build_needed; then
  resolve_pnpm
  echo "test-env-up: building (pnpm install --frozen-lockfile && pnpm build)" >&2
  $PNPM install --frozen-lockfile >&2
  $PNPM build >&2
  for a in $ARTIFACTS; do [ -s "$a" ] || die "the build did not produce $a"; done
  CURRENT_FP=$(fingerprint)
  printf '{ "builtAt": "%s", "sourceFingerprint": "%s", "projectRoot": "%s", "artifactPaths": "%s" }\n' \
    "$(date -u +%FT%TZ)" "$CURRENT_FP" "$REPO_ROOT" "$ARTIFACTS" > "$BUILD_CACHE"
  REBUILT=1
else
  echo "test-env-up: build cache is valid, skipping pnpm install and pnpm build" >&2
fi

# --- 4. fresh data directory, demo seed, fake claude ------------------------------------------
[ -e "$ENV_ROOT" ] && die "$ENV_ROOT exists and is not this checkout's data root (no ownership marker); remove it or set TEST_ENV_ROOT"
umask 077
mkdir "$ENV_ROOT"
printf '%s\n' "$REPO_ROOT" > "$ENV_ROOT/.om-test-env"   # ownership marker read by test-env-down.sh
mkdir "$ENV_ROOT/bin" "$ENV_ROOT/tmp"
# Same fake as apps/web/playwright.config.ts: installed, supported version, logged in.
cat > "$ENV_ROOT/bin/claude" <<'EOF'
#!/bin/sh
if [ "$1" = --setting-sources ]; then shift 2; fi
case "$1" in
  --version) echo "2.1.302 (Claude Code)" ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}' ;;
  *) echo "fake claude: unsupported arguments" >&2; exit 64 ;;
esac
EOF
chmod 755 "$ENV_ROOT/bin/claude"
umask 022

DATA_DIR="$ENV_ROOT/data"
LOG_FILE="$ENV_ROOT/serve.log"
export PATH="$ENV_ROOT/bin:$PATH" TMPDIR="$ENV_ROOT/tmp" ANTHROPIC_API_KEY=""
node "$REPO_ROOT/$CLI" --data-dir "$DATA_DIR" demo >&2

# --- 5. app start + health wait ---------------------------------------------------------------
# A new session makes the server its own process group, so test-env-down.sh can also stop its
# next-server child if the CLI dies first. macOS has no setsid: the CLI stops its child itself.
if command -v setsid >/dev/null 2>&1; then
  setsid node "$REPO_ROOT/$CLI" --data-dir "$DATA_DIR" serve --no-open --port "$PORT" \
    </dev/null >"$LOG_FILE" 2>&1 &
  PROCESS_GROUP=1
else
  node "$REPO_ROOT/$CLI" --data-dir "$DATA_DIR" serve --no-open --port "$PORT" \
    </dev/null >"$LOG_FILE" 2>&1 &
  PROCESS_GROUP=0
fi
APP_PID=$!
deadline=$(( $(now) + READY_TIMEOUT_SECONDS ))
until probe "$BASE_URL$HEALTH_PATH"; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    tail -n 20 "$LOG_FILE" >&2 || true
    die "directivebench serve exited before it was ready (log: $LOG_FILE)"
  fi
  [ "$(now)" -ge "$deadline" ] && die "not ready after ${READY_TIMEOUT_SECONDS}s (log: $LOG_FILE)"
  sleep 1
done
# The health check only proves that some server answers (lesson 2026-10-30-restart-a-served-
# build-by-port): make sure it is the process started here.
is_our_server "$APP_PID" || die "pid $APP_PID is not the server this script started (log: $LOG_FILE)"
probe "$BASE_URL/" || die "the home page does not answer (log: $LOG_FILE)"

# --- 6. descriptor -----------------------------------------------------------------------------
ELAPSED=$(( $(now) - START_TIME ))
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
PLATFORM=$(uname -s 2>/dev/null || echo unknown)
case "$PLATFORM" in
  Linux*) if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then PLATFORM=wsl2; else PLATFORM=linux; fi ;;
  Darwin*) PLATFORM=darwin ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=win32 ;;
  *) PLATFORM=unknown ;;
esac
# shellcheck disable=SC2016 # the single-quoted program is JavaScript with its own templates
RUN_ID=$RUN_ID STARTED_AT=$(date -u +%FT%TZ) STARTED_EPOCH=$(now) BASE_URL=$BASE_URL PORT=$PORT \
APP_PID=$APP_PID PROCESS_GROUP=$PROCESS_GROUP HEALTH_PATH=$HEALTH_PATH ENV_ROOT=$ENV_ROOT \
DATA_DIR=$DATA_DIR LOG_FILE=$LOG_FILE CURRENT_FP=$CURRENT_FP PLATFORM=$PLATFORM \
REBUILT=$REBUILT ELAPSED=$ELAPSED SCRIPTS_DIR=$SCRIPTS_DIR CLI=$CLI \
BROWSER_PROVIDER=$BROWSER_PROVIDER BROWSER_INSTALLED=$BROWSER_INSTALLED \
BROWSER_COMMAND=$BROWSER_COMMAND BROWSER_VERSION=$BROWSER_VERSION BROWSER_NOTES=$BROWSER_NOTES \
node -e '
const e = process.env;
const d = {
  version: 1,
  runId: e.RUN_ID,
  status: "running",
  mode: "prod",
  baseUrl: e.BASE_URL,
  startedByThisRepo: true,
  startScript: `${e.SCRIPTS_DIR}/test-env-up.sh`,
  stopScript: `${e.SCRIPTS_DIR}/test-env-down.sh`,
  app: {
    startCommand: `node ${e.CLI} --data-dir <dataDir> demo && node ${e.CLI} --data-dir <dataDir> serve --no-open --port ${e.PORT}`,
    port: Number(e.PORT),
    healthPath: e.HEALTH_PATH,
    pid: Number(e.APP_PID),
    processGroup: e.PROCESS_GROUP === "1",
  },
  services: [],
  credentials: [],
  dataRoot: e.ENV_ROOT,
  dataDir: e.DATA_DIR,
  logs: { serve: e.LOG_FILE, web: `${e.DATA_DIR}/logs/web.log`, runner: `${e.DATA_DIR}/logs/runner.log` },
  sourceFingerprint: e.CURRENT_FP,
  browser: {
    provider: e.BROWSER_PROVIDER,
    installed: e.BROWSER_INSTALLED === "1",
    command: e.BROWSER_COMMAND,
    version: e.BROWSER_VERSION,
    descriptor: `.ai/browsers/${e.BROWSER_PROVIDER}.md`,
    notes: e.BROWSER_NOTES,
  },
  testRunner: { name: "playwright", config: "apps/web/playwright.config.ts" },
  platform: e.PLATFORM,
  startedAt: e.STARTED_AT,
  startedAtEpoch: Number(e.STARTED_EPOCH),
  notes: [
    `Built CLI with the demo data (mock agent only, labelled as a mock); a fake claude on PATH, ANTHROPIC_API_KEY empty.`,
    `This boot: ${e.ELAPSED}s, ${e.REBUILT === "1" ? "rebuilt (pnpm install + pnpm build)" : "build cache reused"}.`,
    `A warm run reuses a healthy server until the TTL passes or a build input changes; --force restarts with fresh demo data.`,
    `Stop with sh ${e.SCRIPTS_DIR}/test-env-down.sh (removes dataRoot). No authentication: the app binds to 127.0.0.1 only.`,
  ].join(" "),
};
require("fs").writeFileSync(process.argv[1], JSON.stringify(d, null, 2) + "\n");
' "$DESCRIPTOR"

echo "test-env-up: started $BASE_URL in ${ELAPSED}s (pid $APP_PID, data $DATA_DIR)" >&2
print_result 0
