#!/bin/sh
# om-prepare-test-env: generated teardown (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-11-04 generated together with test-env-up.sh
#
# Stops exactly what test-env-up.sh started for this checkout and removes its data root:
# the `directivebench serve` process recorded in .ai/qa/test-env.json (only after checking its
# command line names this checkout's CLI and data directory), its process group when it has
# one, and the /var/tmp data root carrying this checkout's ownership marker. Safe to run twice
# and when nothing is running. Never stops a server it did not start.
#
# Usage: sh .ai/scripts/test-env-down.sh
#   TEST_ENV_ROOT  the same override given to test-env-up.sh, if any
set -eu

STOP_TIMEOUT_SECONDS=20   # serve's own shutdown stops the runner and next-server first
LOCK_WAIT_SECONDS=300
CLI=apps/cli/dist/cli.js
QA_DIR=.ai/qa
SCRIPTS_DIR=.ai/scripts

die() { echo "test-env-down: $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die "node is required"

REPO_ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel) || die "not inside a git checkout"
cd "$REPO_ROOT"
CHECKOUT_ID=$(printf '%s' "$REPO_ROOT" | cksum | awk '{print $1}')
DESCRIPTOR="$QA_DIR/test-env.json"
LOCK_DIR="$QA_DIR/test-env.lock"

descriptor_field() {
  [ -f "$DESCRIPTOR" ] || return 0
  node -e 'try{let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of process.argv[2].split("."))v=v==null?undefined:v[k];if(v!==undefined&&v!==null)process.stdout.write(String(v))}catch{}' "$DESCRIPTOR" "$1"
}

# The data root recorded by the up script wins; otherwise the same default it computes.
ENV_ROOT=$(descriptor_field dataRoot)
[ -n "$ENV_ROOT" ] || ENV_ROOT=${TEST_ENV_ROOT:-/var/tmp/directivebench-test-env-$CHECKOUT_ID}

is_our_server() {
  args=$(ps -ww -p "$1" -o args= 2>/dev/null) || return 1
  case "$args" in *"$REPO_ROOT/$CLI --data-dir $ENV_ROOT/data serve"*) return 0 ;; esac
  return 1
}

# test-env-up.sh calls this script while it holds the lock itself.
if [ "${TEST_ENV_LOCK_HELD:-0}" != 1 ]; then
  mkdir -p "$QA_DIR"
  waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    owner=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$LOCK_DIR/owner.json" 2>/dev/null || true)
    if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } || { [ -z "$owner" ] && [ "$waited" -ge 10 ]; }; then
      rm -rf "$LOCK_DIR"; continue
    fi
    [ "$waited" -ge "$LOCK_WAIT_SECONDS" ] && die "a bootstrap (pid $owner) still holds $LOCK_DIR"
    sleep 1; waited=$((waited + 1))
  done
  trap 'rm -rf "$LOCK_DIR"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '{ "pid": %s, "source": "%s", "acquiredAt": "%s" }\n' \
    "$$" "$SCRIPTS_DIR/test-env-down.sh" "$(date -u +%FT%TZ)" > "$LOCK_DIR/owner.json"
fi

# --- stop the server ---------------------------------------------------------------------------
PID=$(descriptor_field app.pid)
case "$PID" in *[!0-9]*) PID="" ;; esac
GROUP=$(descriptor_field app.processGroup)
STOPPED=""
if [ -n "$PID" ] && [ "$PID" -gt 1 ] && is_our_server "$PID"; then
  kill -TERM "$PID" 2>/dev/null || true
  waited=0
  while kill -0 "$PID" 2>/dev/null && [ "$waited" -lt "$STOP_TIMEOUT_SECONDS" ]; do
    sleep 1; waited=$((waited + 1))
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "test-env-down: pid $PID ignored SIGTERM for ${STOP_TIMEOUT_SECONDS}s, sending SIGKILL" >&2
    kill -KILL "$PID" 2>/dev/null || true
  fi
  STOPPED="pid $PID"
elif [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  echo "test-env-down: pid $PID is not this checkout's server any more; leaving it alone" >&2
fi
# The group id is the server's pid (setsid). A member left behind (a next-server whose parent
# was killed) keeps it; it is signalled only when its environment names this data directory,
# because a dead group id can be reused. Linux only (/proc); without setsid there is no group.
our_group_members() {
  for m in $(pgrep -g "$PID" 2>/dev/null || true); do
    if tr '\0' '\n' < "/proc/$m/environ" 2>/dev/null | grep -qxF "DIRECTIVEBENCH_DATA_DIR=$ENV_ROOT/data"; then
      echo "$m"
    fi
  done
}
if [ "$GROUP" = true ] && [ -n "$PID" ] && [ "$PID" -gt 1 ]; then
  MEMBERS=$(our_group_members)
  if [ -n "$MEMBERS" ]; then
    # shellcheck disable=SC2086 # one pid per word
    kill -TERM $MEMBERS 2>/dev/null || true
    waited=0
    while [ -n "$(our_group_members)" ] && [ "$waited" -lt "$STOP_TIMEOUT_SECONDS" ]; do
      sleep 1; waited=$((waited + 1))
    done
    MEMBERS=$(our_group_members)
    # shellcheck disable=SC2086
    [ -z "$MEMBERS" ] || kill -KILL $MEMBERS 2>/dev/null || true
    STOPPED="${STOPPED:+$STOPPED and }left-behind members of process group $PID"
  fi
fi

# --- remove the data root (only with this checkout's marker) -----------------------------------
REMOVED=""
case "$(basename "$ENV_ROOT")" in
  directivebench-test-env-*)
    if [ -d "$ENV_ROOT" ]; then
      if [ "$(cat "$ENV_ROOT/.om-test-env" 2>/dev/null || true)" = "$REPO_ROOT" ]; then
        rm -rf "$ENV_ROOT"
        REMOVED=$ENV_ROOT
      else
        echo "test-env-down: $ENV_ROOT has no ownership marker of this checkout; not removing it" >&2
      fi
    fi
    ;;
  *) echo "test-env-down: refusing to remove unexpected data root '$ENV_ROOT'" >&2 ;;
esac

# --- mark the descriptor stopped ---------------------------------------------------------------
if [ -f "$DESCRIPTOR" ]; then
  node -e '
const fs = require("fs");
const file = process.argv[1];
let d;
try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch { d = { version: 1 }; }
d.status = "stopped";
d.stoppedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
' "$DESCRIPTOR"
fi

echo "test-env-down: stopped ${STOPPED:-nothing (no server of this checkout was running)}; removed ${REMOVED:-no data root}" >&2
echo "TEST_ENV_STATUS=stopped"
