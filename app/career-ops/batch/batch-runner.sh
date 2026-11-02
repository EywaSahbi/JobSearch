#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$BATCH_DIR/batch-prompt.md"
PROFILE_FILE="$PROJECT_DIR/config/profile.yml"
LOGS_DIR="$BATCH_DIR/logs"
DISCARD_LOG="$LOGS_DIR/discard.log"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
PAUSE_FILE="$BATCH_DIR/batch-runner.paused"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
RESUME_PAUSED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0
SKIP_PDF=false
MODEL=""
RESOLVED_MODEL=""
RESOLVED_SPEND_TIER=""
CLI=claude
RATE_LIMIT_SLEEP=300
BATCH_PAUSED=false
STATUS_ONLY=false
WATCH_MODE=false
LIMIT=0

is_decimal_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]
}

usage() {
  cat <<'USAGE'
career-ops batch runner — process job offers in batch via headless agent workers
Defaults to claude; other CLIs via --cli. For claude the model is resolved from
spend_tier in config/profile.yml unless --model overrides it.

Usage: batch-runner.sh [OPTIONS]

Options:
  --cli NAME           Agent CLI to use: claude (default), opencode, gemini, qwen
  --model NAME         Model for the CLI (e.g. qwen2.5:32b for opencode/ollama).
                       For claude, overrides the tier-resolved model (otherwise
                       config/profile.yml spend_tier: economy/standard/premium;
                       default standard).
  --parallel N         Number of parallel workers (default: 1; claude only)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry offers marked as "failed" in state
  --resume-paused      Resume offers paused by a Claude session/rate limit
  --start-from N       Start from offer ID N (skip earlier IDs)
  --limit N            Max offers: positive integer; omit for no limit
  --max-retries N      Max retry attempts per offer (default: 2)
  --min-score N        Skip PDF/tracker for offers scoring below N (default: 0 = off)
  --skip-pdf           Skip PDF generation entirely (write ❌ in tracker PDF column)
  --rate-limit-sleep N Maximum adaptive retry delay in seconds; 0 pauses immediately
                       (default: 300; range: 0–2147483647; claude only)
  --status             Show batch progress and a per-job table, then exit
  --watch              Live-refresh progress until the run completes
  -h, --help           Show this help

Files:
  batch-input.tsv      Input offers (id, url, source, notes)
  batch-state.tsv      Processing state (auto-managed)
  batch-prompt.md      Prompt template for workers
  logs/                Per-offer logs
  tracker-additions/   Tracker lines for post-batch merge

Examples:
  # Dry run to see pending offers
  ./batch-runner.sh --dry-run

  # Process all pending
  ./batch-runner.sh

  # Retry only failed offers
  ./batch-runner.sh --retry-failed

  # Process 2 at a time starting from ID 10 (claude only)
  ./batch-runner.sh --parallel 2 --start-from 10

  # Local LLM via OpenCode (free, runs sequentially)
  ./batch-runner.sh --cli opencode --model qwen2.5:32b
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cli) CLI="$2"; shift 2 ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --resume-paused) RESUME_PAUSED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --limit)
      if [[ $# -lt 2 ]] || ! [[ "$2" =~ ^[0-9]+$ ]] || [[ "$2" =~ ^0+$ ]]; then
        echo "ERROR: --limit must be a positive integer; omit --limit for no limit."
        exit 1
      fi
      LIMIT="${2#"${2%%[!0]*}"}"
      if [[ ${#LIMIT} -gt 19 ]] || { [[ ${#LIMIT} -eq 19 ]] && [[ "$LIMIT" > 9223372036854775807 ]]; }; then
        echo "ERROR: --limit must be at most 9223372036854775807; omit --limit for no limit."
        exit 1
      fi
      shift 2
      ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --skip-pdf) SKIP_PDF=true; shift ;;
    --rate-limit-sleep)
      [[ $# -ge 2 ]] || { echo "ERROR: --rate-limit-sleep requires an argument"; exit 1; }
      RATE_LIMIT_SLEEP="$2"
      shift 2
      ;;
    --model) MODEL="$2"; shift 2 ;;
    --status) STATUS_ONLY=true; shift ;;
    --watch) WATCH_MODE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if ! [[ "$RATE_LIMIT_SLEEP" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --rate-limit-sleep must be a non-negative integer (seconds)."
  exit 1
fi
RATE_LIMIT_SLEEP=$(printf '%s' "$RATE_LIMIT_SLEEP" | sed 's/^0*//')
RATE_LIMIT_SLEEP=${RATE_LIMIT_SLEEP:-0}
if [[ ${#RATE_LIMIT_SLEEP} -gt 10 ]] || { [[ ${#RATE_LIMIT_SLEEP} -eq 10 ]] && [[ "$RATE_LIMIT_SLEEP" > 2147483647 ]]; }; then
  echo "ERROR: --rate-limit-sleep must not exceed 2147483647 seconds."
  exit 1
fi

if ! is_decimal_number "$MIN_SCORE"; then
  echo "ERROR: --min-score must be a non-negative number."
  exit 1
fi

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE"
}

trap release_lock EXIT

check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi

  local cli_cmd
  case "$CLI" in
    claude)   cli_cmd="claude" ;;
    opencode) command -v opencode &>/dev/null && cli_cmd="opencode" || cli_cmd="ollama" ;;
    gemini)   cli_cmd="gemini" ;;
    qwen)     cli_cmd="qwen" ;;
    *) echo "ERROR: Unknown --cli '$CLI'. Supported: claude, opencode, gemini, qwen"; exit 1 ;;
  esac

  if ! command -v "$cli_cmd" &>/dev/null; then
    echo "ERROR: '$cli_cmd' not found in PATH (required for --cli $CLI)."
    if [[ "$CLI" == "opencode" ]]; then
      echo "       Install opencode (https://opencode.ai) or Ollama (https://ollama.ai) with an opencode model."
    fi
    exit 1
  fi

  if [[ "$CLI" != "claude" && "$PARALLEL" -gt 1 ]]; then
    echo "WARN: --parallel >1 is not supported for --cli $CLI (local models run sequentially). Resetting to 1."
    PARALLEL=1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"
}

check_status_prerequisites() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    exit 0
  fi
}

init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

STATE_LOCK_STALE_AGE_SECONDS=15

acquire_state_lock() {
  if [[ "${STATE_LOCK_DISABLED:-0}" -eq 1 ]]; then
    return 0
  fi

  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\t%s\n' "${BASHPID:-$$}" "$(date +%s)" > "$STATE_LOCK_PID_FILE"; then
        STATE_LOCK_OWNED=1
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR" >&2
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      if (( PARALLEL <= 1 )); then
        echo "WARN: State lock creation failed. Falling back to lock-free operation (single-worker mode)." >&2
        STATE_LOCK_DISABLED=1
        STATE_LOCK_OWNED=0
        return 0
      fi
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR" >&2
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid lock_epoch
      lock_pid=$(cut -f1 "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      lock_epoch=$(cut -f2 "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      local stale=false
      local stale_reason=""

      local pid_confirmed_alive=false
      if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
        pid_confirmed_alive=true
      fi

      if [[ "$pid_confirmed_alive" == "false" ]]; then
        if [[ -n "$lock_pid" ]]; then
          stale=true
          stale_reason="PID $lock_pid not running"
        elif [[ "$lock_epoch" =~ ^[0-9]+$ ]]; then
          local now age
          now=$(date +%s)
          age=$((now - lock_epoch))
          if (( age >= STATE_LOCK_STALE_AGE_SECONDS )); then
            stale=true
            stale_reason="lock age ${age}s >= ${STATE_LOCK_STALE_AGE_SECONDS}s (no PID recorded to check liveness against)"
          fi
        fi
      fi

      if [[ "$stale" == "true" ]]; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock ($stale_reason)." >&2
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR" >&2
      echo "If no batch-runner worker is active, remove the stale lock directory." >&2
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  if [[ "${STATE_LOCK_OWNED:-0}" -ne 1 ]]; then
    return
  fi
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
  STATE_LOCK_OWNED=0
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

read_spend_tier() {
  local raw=""

  if [[ -f "$PROFILE_FILE" ]]; then
    raw=$(
      awk -F: '
        /^[[:space:]]*spend_tier[[:space:]]*:/ {
          value = substr($0, index($0, ":") + 1)
          print value
          exit
        }
      ' "$PROFILE_FILE"
    )
    raw="${raw%%#*}"
    raw="${raw//$'\r'/}"
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    case "$raw" in
      \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
      \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
    esac
    raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  fi

  case "$raw" in
    economy|standard|premium)
      printf '%s\n' "$raw"
      ;;
    "")
      printf '%s\n' "standard"
      ;;
    *)
      echo "WARN: Invalid spend_tier \"$raw\" in ${PROFILE_FILE#"$PROJECT_DIR/"}; falling back to standard." >&2
      printf '%s\n' "standard"
      ;;
  esac
}

spend_tier_to_model() {
  case "$1" in
    economy) echo "claude-haiku-4-5" ;;
    premium) echo "claude-opus-5-5" ;;
    standard|*) echo "claude-sonnet-5-5" ;;
  esac
}

resolve_worker_model() {
  if [[ -n "$MODEL" ]]; then
    RESOLVED_MODEL="$MODEL"
    RESOLVED_SPEND_TIER="override"
    return 0
  fi

  if [[ "$CLI" != "claude" ]]; then
    RESOLVED_MODEL=""
    RESOLVED_SPEND_TIER="cli-default"
    return 0
  fi

  RESOLVED_SPEND_TIER="$(read_spend_tier)"
  RESOLVED_MODEL="$(spend_tier_to_model "$RESOLVED_SPEND_TIER")"
}

log_discard() {
  local id="$1" url="$2" reason="$3"
  mkdir -p "$LOGS_DIR"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\t%s\t%s\t%s\n' "$ts" "$id" "$url" "$reason" >> "$DISCARD_LOG"
}


update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  error=${error//$'\r'/ }
  error=${error//$'\n'/ }
  error=${error//$'\t'/ }

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local found=false

  head -1 "$STATE_FILE" > "$tmp"

  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

RECOVERY_DIR="$BATCH_DIR/batch-state-recovery.d"

append_recovery_record() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"
  error=${error//$'\r'/ }
  error=${error//$'\n'/ }
  error=${error//$'\t'/ }
  error=${error//$'\x1f'/ }
  mkdir -p "$RECOVERY_DIR" || return 1
  local rec
  rec=$(mktemp "$RECOVERY_DIR/rec-XXXXXX") || return 1
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" > "$rec"
}

recovery_record_is_superseded() {
  local current="$1"
  [[ "$current" == "completed" || "$current" == "skipped" || "$current" == "needs_confirmation" ]]
}

reconcile_one_unlocked() {
  local id="$1"
  local current
  current=$(get_status "$id")
  if recovery_record_is_superseded "$current"; then
    echo "    Superseded: offer id=$id already '$current' in state — discarding stale recovery record (would have rolled it back to '$3')."
    return 3
  fi
  update_state_unlocked "$@"
}

reconcile_one() {
  run_with_state_lock reconcile_one_unlocked "$@"
}

reconcile_recovery_records() {
  [[ -d "$RECOVERY_DIR" ]] || return 0

  local -a rec_files=()
  local f
  for f in "$RECOVERY_DIR"/rec-*; do
    [[ -f "$f" ]] || continue
    rec_files+=("$f")
  done
  if (( ${#rec_files[@]} == 0 )); then
    rmdir "$RECOVERY_DIR" 2>/dev/null || true
    return 0
  fi

  echo "=== Reconciling ${#rec_files[@]} recovery record(s) from a prior interrupted run ==="
  local merged=0 superseded=0 still_failed=0
  local rid rurl rstatus rstarted rcompleted rreport rscore rerror rretries
  local rline
  local rc
  for f in "${rec_files[@]}"; do
    rline=""
    IFS= read -r rline < "$f" || true
    IFS=$'\x1f' read -r rid rurl rstatus rstarted rcompleted rreport rscore rerror rretries <<< "${rline//$'\t'/$'\x1f'}"
    if [[ -z "$rid" ]]; then
      echo "    WARN: discarding unreadable recovery record $f" >&2
      rm -f "$f"
      continue
    fi
    rc=0
    reconcile_one "$rid" "$rurl" "$rstatus" "$rstarted" "$rcompleted" "$rreport" "$rscore" "$rerror" "$rretries" || rc=$?
    if (( rc == 0 )); then
      rm -f "$f"
      merged=$((merged + 1))
    elif (( rc == 3 )); then
      rm -f "$f"
      superseded=$((superseded + 1))
    else
      still_failed=$((still_failed + 1))
    fi
  done

  echo "    Merged: $merged | Superseded: $superseded | Still unrecovered: $still_failed"
  if (( still_failed > 0 )); then
    echo "    WARN: $still_failed record(s) could not be merged even single-threaded — check $STATE_LOCK_DIR for a genuinely stuck lock. Unmerged records remain in $RECOVERY_DIR." >&2
  else
    rmdir "$RECOVERY_DIR" 2>/dev/null || true
  fi
}

update_state_retrying() {
  local attempt=0
  local max_attempts=3
  while (( attempt < max_attempts )); do
    if update_state "$@"; then
      return 0
    fi
    attempt=$((attempt + 1))
    if (( attempt < max_attempts )); then
      echo "    ⚠️  State update failed (attempt $attempt/$max_attempts), retrying in 2s..." >&2
      sleep 2
    fi
  done
  if append_recovery_record "$@"; then
    echo "    ⚠️  State update failed after $max_attempts attempts — offer id=$1 status=$3 recorded to $RECOVERY_DIR for reconciliation on next run." >&2
  else
    echo "    ❌ State update failed after $max_attempts attempts AND recovery-record write also failed — offer id=$1 status=$3 was NOT recorded anywhere. It will be retried as pending next run." >&2
    return 2
  fi
  return 1
}

is_rate_limit_log() {
  local log_file="$1"
  grep -Eiq '(rate limit|rate_limit|too many requests|429|quota exceeded|try again later|temporarily unavailable)' "$log_file"
}

is_session_limit_log() {
  local log_file="$1"
  grep -Eiq '(session limit|resets [0-9:]+[ap]m|usage limit|limit[[:space:]]+reached)' "$log_file"
}

rate_limit_delay() {
  local log_file="$1" retry="$2" base delay hint step
  if (( RATE_LIMIT_SLEEP == 0 )); then
    echo pause
    return
  fi
  base=30
  (( base <= RATE_LIMIT_SLEEP )) || base=$RATE_LIMIT_SLEEP
  hint=""
  [[ -e "$log_file" && ! -s "$log_file" ]] || hint=$(LC_ALL=C awk -v cap="$RATE_LIMIT_SLEEP" '
    tolower($0) ~ /^[[:space:]]*retry-after:[[:space:]]*[0-9]+[[:space:]]*$/ {
      value=$0
      sub(/^[^:]*:[[:space:]]*/, "", value)
      if (value + 0 > cap) over=1
      if (value + 0 > largest) largest=value + 0
      found=1
    }
    END {
      if (over) print "pause"
      else if (found) printf "%.0f\n", largest
    }
  ' "$log_file")
  if [[ "$hint" == pause ]]; then
    echo pause
    return
  fi
  delay=$base
  if [[ -n "$hint" ]]; then
    (( hint <= delay )) || delay=$hint
  else
    for (( step=0; step<retry && delay<RATE_LIMIT_SLEEP; step++ )); do
      if (( delay > RATE_LIMIT_SLEEP / 2 )); then
        delay=$RATE_LIMIT_SLEEP
      else
        delay=$((delay * 2))
      fi
    done
  fi
  delay=$((delay + delay * (RANDOM % 21) / 100))
  (( delay <= RATE_LIMIT_SLEEP )) || delay=$RATE_LIMIT_SLEEP
  echo "$delay"
}

mark_paused_rate_limit() {
  local id="$1" url="$2" started_at="$3" report_num="$4" retries="$5" log_file="$6"
  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local error_msg
  error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "session/rate limit reached")
  update_state_retrying "$id" "$url" "paused_rate_limit" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries" || true
  printf '%s\t%s\t%s\n' "$id" "$report_num" "$error_msg" > "$PAUSE_FILE"
  BATCH_PAUSED=true
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  local report_num=""
  report_num=$(node "$PROJECT_DIR/reserve-report-num.mjs" 2>/dev/null | tr -d '[:space:]')
  if [[ -n "$report_num" ]]; then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

release_report_num() {
  local report_num="$1"
  [[ -n "$report_num" && "$report_num" != "-" ]] || return 0
  node "$PROJECT_DIR/reserve-report-num.mjs" --release "$report_num" >/dev/null 2>&1 || true
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

reserve_report_num_retrying() {
  local attempt=0
  local max_attempts=3
  local result=""
  while (( attempt < max_attempts )); do
    if result=$(reserve_report_num "$@"); then
      printf '%s\n' "$result"
      return 0
    fi
    attempt=$((attempt + 1))
    if (( attempt < max_attempts )); then
      echo "    ⚠️  Report-number reservation failed (attempt $attempt/$max_attempts), retrying in 2s..." >&2
      sleep 2
    fi
  done
  echo "    ❌ Report-number reservation failed after $max_attempts attempts for offer id=$1 — leaving it pending for next run." >&2
  return 1
}

process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")
  local report_num
  if ! report_num=$(reserve_report_num_retrying "$id" "$url" "$started_at" "$retries"); then
    return 1
  fi
  local date
  date=$(date +%Y-%m-%d)
  local jd_tmp_dir="$PROJECT_DIR/batch/tmp"
  mkdir -p "$jd_tmp_dir"
  local jd_file
  jd_file="$(mktemp "$jd_tmp_dir/batch-jd-${id}.XXXXXX")"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) command -v cygpath >/dev/null 2>&1 && jd_file="$(cygpath -m "$jd_file")" ;;
  esac

  local prefetch_min_words=80
  local jd_prefetch_words=0
  if command -v curl >/dev/null 2>&1; then
    local _url_safe
    local current_url="$url"
    local redirect_count=0
    local curl_status=0
    local redirect_headers
    local redirect_location
    while :; do
      _url_safe=$(node -e "
      try {
        const u = new URL(process.argv[1]);
        const h = u.hostname.toLowerCase().replace(/\.\$/, '');
        const blocked =
          h === 'localhost' || h === 'localhost.localdomain' ||
          h.endsWith('.local') || h.endsWith('.internal') ||
          h.includes(':') ||
          /^127\./.test(h) || /^169\.254\./.test(h) ||
          /^10\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) ||
          /^192\.168\./.test(h) || /^0\./.test(h);
        process.stdout.write(blocked ? '0' : '1');
      } catch (e) { process.stdout.write('0'); }
      " "$current_url" 2>/dev/null)
      if [[ "$_url_safe" != "1" ]]; then
        echo "    ℹ️  JD prefetch: blocked — private/loopback destination ($current_url)"
        : > "$jd_file"
        break
      else
        redirect_headers="$(mktemp "${TMPDIR:-/tmp}/batch-jd-headers.XXXXXX")"
        curl_status=0
        curl --silent --show-error --location --max-redirs 0 \
          --max-time 20 --connect-timeout 5 \
          --fail --compressed \
          --proto '=http,https' --proto-redir 'https,http' --max-filesize 5000000 \
          --user-agent "Mozilla/5.0 (compatible; career-ops/batch)" \
          --header "Accept: text/html,application/xhtml+xml,*/*;q=0.8" \
          --dump-header "$redirect_headers" \
          --output "$jd_file" \
          -- "$current_url" 2>/dev/null || curl_status=$?
        redirect_location=""
        if [[ "$curl_status" -eq 47 ]]; then
          redirect_location="$(awk 'tolower($0) ~ /^location:[[:space:]]*/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value) } END { print value }' "$redirect_headers")"
        fi
        rm -f "$redirect_headers"
        if [[ "$curl_status" -eq 47 && -n "$redirect_location" ]]; then
          if [[ "$redirect_count" -ge 10 ]]; then
            : > "$jd_file"
            echo "    ℹ️  JD prefetch: too many redirects — worker will WebFetch"
            break
          fi
          current_url="$(node -e "
            try { process.stdout.write(new URL(process.argv[2], process.argv[1]).href); }
            catch (e) { process.stdout.write(''); }
          " "$current_url" "$redirect_location" 2>/dev/null)"
          if [[ -z "$current_url" ]]; then
            : > "$jd_file"
            break
          fi
          redirect_count=$((redirect_count + 1))
          continue
        fi
        if [[ "$curl_status" -ne 0 ]]; then
          : > "$jd_file"
        fi
        break
      fi
    done
      jd_prefetch_words=$(node -e "
        const fs = require('fs');
        try {
          const text = fs.readFileSync(process.argv[1], 'utf-8')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&(nbsp|#160|#xa0);/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          fs.writeFileSync(process.argv[1], text);
          process.stdout.write(String(text.split(' ').filter(Boolean).length));
        } catch (e) { process.stdout.write('0'); }
      " "$jd_file" 2>/dev/null) || jd_prefetch_words=0
      jd_prefetch_words="${jd_prefetch_words//[^0-9]/}"
      jd_prefetch_words="${jd_prefetch_words:-0}"
      if [[ "$jd_prefetch_words" -lt "$prefetch_min_words" ]]; then
        : > "$jd_file"
        echo "    ℹ️  JD prefetch: thin content (${jd_prefetch_words} words) — worker will WebFetch"
      else
        echo "    ℹ️  JD prefetch: ${jd_prefetch_words} words written to JD file"
      fi
  fi

  echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))"

  local prompt
  if [[ "$SKIP_PDF" == "true" ]]; then
    prompt="Process this job offer. Run the pipeline: A-G evaluation + report .md + tracker line. Do not generate PDF; write ❌ in the tracker PDF column and set \"pdf\": null in the final JSON."
    echo "    ⏭️  --skip-pdf set — skipping PDF generation for #$id ($url)"
  else
    prompt="Process this job offer. Run the full pipeline: A-G evaluation + report .md + optional PDF + tracker line."
  fi
  prompt="$prompt URL: $url"
  prompt="$prompt JD file: $jd_file"
  prompt="$prompt Report number: $report_num"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"

  local log_file="$LOGS_DIR/${report_num}-${id}.log"

  local resolved_prompt="$BATCH_DIR/.resolved-prompt-${id}.md"
  sed \
    -e "s|{{URL}}|<URL from the job message>|g" \
    -e "s|{{JD_FILE}}|<JD file from the job message>|g" \
    -e "s|{{REPORT_NUM}}|<report number from the job message>|g" \
    -e "s|{{DATE}}|<date from the job message>|g" \
    -e "s|{{ID}}|<batch ID from the job message>|g" \
    "$PROMPT_FILE" > "$resolved_prompt"

  for context_file in "$PROJECT_DIR/modes/_profile.md" "$PROJECT_DIR/config/profile.yml" "$PROJECT_DIR/modes/_custom.md"; do
    if [[ -f "$context_file" ]]; then
      {
        printf '\n\n---\n\n'
        printf '## Runtime personalization: %s\n\n' "${context_file#"$PROJECT_DIR/"}"
        sed 's/^/    /' "$context_file"
        printf '\n'
      } >> "$resolved_prompt"
    fi
  done

  local -a claude_args=(-p --dangerously-skip-permissions --strict-mcp-config)
  if [[ -n "$RESOLVED_MODEL" ]]; then
    claude_args+=(--model "$RESOLVED_MODEL")
  fi
  claude_args+=(--append-system-prompt-file "$resolved_prompt" "$prompt")

  local full_prompt=""
  local -a model_args=()
  if [[ "$CLI" != "claude" ]]; then
    full_prompt="$(cat "$resolved_prompt")"$'\n\n'"$prompt"
    [[ -n "$MODEL" ]] && model_args=(--model "$MODEL")
  fi

  local exit_code=0
  local terminal_failure_recorded=false
  local shim_retries=0
  local max_shim_retries=4
  while true; do
    exit_code=0
    case "$CLI" in
      claude)
        claude "${claude_args[@]}" > "$log_file" 2>&1 || exit_code=$?
        ;;
      opencode)
        if command -v opencode &>/dev/null; then
          opencode run ${model_args[@]+"${model_args[@]}"} "$full_prompt" > "$log_file" 2>&1 || exit_code=$?
        else
          ollama launch opencode ${model_args[@]+"${model_args[@]}"} -y -- run "$full_prompt" > "$log_file" 2>&1 || exit_code=$?
        fi
        ;;
      gemini)
        gemini ${model_args[@]+"${model_args[@]}"} -p "$full_prompt" > "$log_file" 2>&1 || exit_code=$?
        ;;
      qwen)
        qwen ${model_args[@]+"${model_args[@]}"} -p "$full_prompt" > "$log_file" 2>&1 || exit_code=$?
        ;;
    esac

    if [[ "$CLI" != "claude" ]]; then
      break
    fi

    if [[ $exit_code -eq 0 ]]; then
      break
    fi

    if [[ $exit_code -eq 127 ]] && grep -qE "(claude: command not found|claude:.*not found|cannot find.*claude)" "$log_file" && (( shim_retries < max_shim_retries )); then
      shim_retries=$((shim_retries + 1))
      echo "    ⏳ Claude command not found (shim swap detected). Retrying in 30s (attempt $shim_retries/$max_shim_retries)..."
      sleep 30
      continue
    fi

    if is_session_limit_log "$log_file"; then
      mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
      echo "    ⏸️  Session/rate limit reached; pausing batch without consuming retry budget."
      terminal_failure_recorded=true
      break
    fi

    if is_rate_limit_log "$log_file" && (( retries < MAX_RETRIES )); then
      if (( RATE_LIMIT_SLEEP <= 0 )); then
        mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
        echo "    ⏸️  Rate limited and --rate-limit-sleep is 0; pausing batch without consuming retry budget."
        terminal_failure_recorded=true
        break
      fi
      local retry_delay
      retry_delay=$(rate_limit_delay "$log_file" "$retries")
      if [[ "$retry_delay" == pause ]]; then
        mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
        echo "    ⏸️  Retry-After exceeds --rate-limit-sleep; pausing batch without consuming retry budget."
        terminal_failure_recorded=true
        break
      fi
      retries=$((retries + 1))
      local retry_completed_at
      retry_completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      update_state_retrying "$id" "$url" "rate_limited" "$started_at" "$retry_completed_at" "$report_num" "-" "rate-limit; retrying after ${retry_delay}s" "$retries" || true
      echo "    ⏳ Rate limited (attempt $retries/$MAX_RETRIES). Waiting ${retry_delay}s before retry..."
      sleep "$retry_delay"
      continue
    fi

    break
  done

  rm -f "$resolved_prompt" "$jd_file"

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $exit_code -eq 0 ]]; then
    local worker_result_json
    worker_result_json=$(awk '
      /^```json[[:space:]]*$/ { in_block=1; block=""; next }
      in_block && /^```[[:space:]]*$/ { in_block=0; last=block; next }
      in_block { block = block $0 "\n" }
      END { printf "%s", last }
    ' "$log_file" 2>/dev/null || true)

    local worker_failed_match="" worker_error_match="" score="-"
    local parsed_status="" parsed_error="" parsed_score=""
    if [[ -n "$worker_result_json" ]]; then
      local parsed
      parsed=$(printf '%s' "$worker_result_json" | node -e '
        let data = "";
        process.stdin.on("data", d => data += d);
        process.stdin.on("end", () => {
          try {
            const obj = JSON.parse(data);
            const status = typeof obj.status === "string" ? obj.status : "";
            const message = status === "needs_confirmation" ? obj.question : obj.error;
            const error = typeof message === "string" ? message.replace(/[\x00-\x1f\x7f]/g, " ") : "";
            const score = typeof obj.score === "number" ? String(obj.score) : "";
            process.stdout.write(status + "\x1f" + error + "\x1f" + score);
          } catch {
            process.stdout.write("");
          }
        });
      ' 2>/dev/null || true)
      if [[ -n "$parsed" ]]; then
        IFS=$'\x1f' read -r parsed_status parsed_error parsed_score <<< "$parsed"
        if [[ "$parsed_status" == "failed" ]]; then
          worker_failed_match="failed"
          worker_error_match="$parsed_error"
        elif [[ -n "$parsed_score" ]]; then
          score="$parsed_score"
        fi
      fi
    fi

    if [[ "$parsed_status" == "needs_confirmation" ]]; then
      local question="${parsed_error:-Which agency did this posting come through?}"
      if ! node -e '
        const result = JSON.parse(process.argv[1]);
        process.exit(result.reason === "agency_confirmation" &&
          result.url === process.argv[2] && String(result.id) === process.argv[3] ? 0 : 1);
      ' "$worker_result_json" "$url" "$id"; then
        question="Invalid confirmation handoff identity/reason; parent must inspect the job log and ask for this URL"
      fi
      local tracker_artifact="$TRACKER_DIR/$id.tsv"
      local -a report_artifacts=()
      if [[ -n "$report_num" && "$report_num" != "-" ]]; then
        shopt -s nullglob
        report_artifacts=("$REPORTS_DIR/$report_num-"*.md)
        shopt -u nullglob
      fi
      if [[ -f "$tracker_artifact" || ${#report_artifacts[@]} -gt 0 ]]; then
        local quarantine_dir="$LOGS_DIR/quarantine"
        mkdir -p "$quarantine_dir"
        if [[ -f "$tracker_artifact" ]]; then
          mv "$tracker_artifact" "$quarantine_dir/$id-tracker.tsv"
        fi
        local report_artifact
        for report_artifact in ${report_artifacts[@]+"${report_artifacts[@]}"}; do
          mv "$report_artifact" "$quarantine_dir/$id-${report_artifact##*/}"
        done
        question="Worker violated the confirmation hold by writing artifacts; inspect the quarantined tracker/report before answering"
        update_state_retrying "$id" "$url" "needs_confirmation" "$started_at" "$completed_at" "-" "-" "$question" "$retries" || true
        echo "    ERROR: confirmation hold produced artifacts; reservation kept and tracker merge skipped." >&2
        return 2
      fi
      local hold_rc=0
      update_state_retrying "$id" "$url" "needs_confirmation" "$started_at" "$completed_at" "-" "-" "$question" "$retries" || hold_rc=$?
      release_report_num "$report_num"
      echo "    Needs confirmation: $url — $question (resume in the parent session after an explicit answer)"
      if (( hold_rc == 2 )); then
        echo "    ERROR: confirmation hold could not be persisted; stop and repair state before rerunning this posting." >&2
        return 2
      fi
      return 0
    fi

    if [[ -n "$worker_failed_match" ]]; then
      [[ -z "$worker_error_match" ]] && worker_error_match="worker reported status:failed (exit code 0)"
      if (( retries < MAX_RETRIES )); then
        retries=$((retries + 1))
      fi
      update_state_retrying "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$worker_error_match" "$retries" || true
      release_report_num "$report_num"
      echo "    ❌ Failed (worker-reported, attempt $retries): $worker_error_match"
      return 0
    fi

    local report_files
    report_files=$(compgen -G "$REPORTS_DIR/${report_num}-*.md" 2>/dev/null | grep -vE -- '-RESERVED\.md$' || true)
    if [[ -z "$report_files" ]]; then
      if (( retries < MAX_RETRIES )); then
        retries=$((retries + 1))
      fi
      update_state_retrying "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "worker exited cleanly but wrote no report file for this report number" "$retries" || true
      release_report_num "$report_num"
      echo "    ❌ Failed (no report file on disk, attempt $retries)"
      return 0
    fi

    if is_decimal_number "$score" && LC_ALL=C awk -v min="$MIN_SCORE" 'BEGIN{exit !(min > 0)}'; then
      if LC_ALL=C awk -v score="$score" -v min="$MIN_SCORE" 'BEGIN{exit !(score < min)}'; then
        update_state_retrying "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "below-min-score" "$retries" || true
        release_report_num "$report_num"
        echo "    ⏭️  Skipped (score: $score < min-score: $MIN_SCORE)"
        return 0
      fi
    fi

    update_state_retrying "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$score" "-" "$retries" || true
    release_report_num "$report_num"
    echo "    ✅ Completed (score: $score, report: $report_num)"
  elif [[ "$terminal_failure_recorded" == "false" ]]; then
    if (( retries < MAX_RETRIES )); then
      retries=$((retries + 1))
    fi
    local error_msg
    error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    update_state_retrying "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries" || true
    release_report_num "$report_num"
    echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
  fi
}

merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Reconciling pipeline.md ==="
  node "$PROJECT_DIR/reconcile-pipeline.mjs" || echo "⚠️  Pipeline reconcile had issues (see above)"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 skipped=0 failed=0 pending=0 needs_confirmation=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(LC_ALL=C awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      skipped) skipped=$((skipped + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      needs_confirmation) needs_confirmation=$((needs_confirmation + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Skipped: $skipped | Failed: $failed | Pending: $pending | Needs confirmation: $needs_confirmation"

  if (( score_count > 0 )); then
    local avg
    avg=$(LC_ALL=C awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi

  if [[ -f "$BATCH_DIR/aggregate-tokens.mjs" ]]; then
    if ! node "$BATCH_DIR/aggregate-tokens.mjs"; then
      echo "Warning: token aggregation failed." >&2
    fi
  fi
}

print_status_table() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    return
  fi

  local total=0 completed=0 processing=0 failed=0 pending=0 skipped=0 rate_limited=0 paused_rate_limit=0 needs_confirmation=0
  local score_sum=0 score_count=0

  local header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    total=$((total + 1))
    case "$sstatus" in
      completed)
        completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(LC_ALL=C awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      processing) processing=$((processing + 1)) ;;
      needs_confirmation) needs_confirmation=$((needs_confirmation + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      skipped) skipped=$((skipped + 1)) ;;
      rate_limited) rate_limited=$((rate_limited + 1)) ;;
      paused_rate_limit) paused_rate_limit=$((paused_rate_limit + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "=== Batch Progress ==="
  echo "Total: $total | Completed: $completed | Processing: $processing | Failed: $failed | Pending: $pending | Skipped: $skipped | Rate Limited: $rate_limited | Paused: $paused_rate_limit | Needs confirmation: $needs_confirmation"
  if (( score_count > 0 )); then
    local avg
    avg=$(LC_ALL=C awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
  echo ""

  printf "%-4s | %-17s | %-6s | %-5s | %-40s\n" "ID" "Status" "Report" "Score" "URL / Detail"
  printf "%-4s+%-19s+%-8s+%-7s+%-42s\n" "----" "-------------------" "--------" "-------" "------------------------------------------"

  header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    local target="$surl"
    if [[ "$sstatus" == "needs_confirmation" ]]; then
      target="$surl — Needs confirmation: $serror"
    elif [[ "$sstatus" == "failed" && -n "$serror" && "$serror" != "-" ]]; then
      target="Error: $serror"
    fi
    if [[ "$sstatus" != "needs_confirmation" ]] && (( ${#target} > 50 )); then
      target="${target:0:47}..."
    fi
    printf "%-4s | %-17s | %-6s | %-5s | %-50s\n" "$sid" "$sstatus" "$sreport" "$sscore" "$target"
  done < "$STATE_FILE"
}

watch_status() {
  local active_pid=""
  if [[ -f "$LOCK_FILE" ]]; then
    active_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  fi

  if [[ -n "$active_pid" ]] && kill -0 "$active_pid" 2>/dev/null; then
    echo "Watching batch-runner (PID $active_pid)... Press Ctrl+C to stop."
    while kill -0 "$active_pid" 2>/dev/null; do
      clear || printf "\033[c"
      echo "=== Watching Batch Progress (PID $active_pid) ==="
      print_status_table
      sleep 2
    done
    echo ""
    echo "=== Batch runner process (PID $active_pid) has finished ==="
  else
    echo "No active batch-runner detected."
  fi

  echo "Showing final status:"
  print_status_table

  if [[ -f "$PROJECT_DIR/verify-pipeline.mjs" ]]; then
    echo ""
    echo "=== Running pipeline verification ==="
    node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues"
  fi
}

main() {
  if [[ "$STATUS_ONLY" == "true" ]]; then
    check_status_prerequisites
    print_status_table
    exit 0
  fi

  if [[ "$WATCH_MODE" == "true" ]]; then
    check_status_prerequisites
    watch_status
    exit 0
  fi

  check_prerequisites

  resolve_worker_model

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
    rm -f "$PAUSE_FILE"
  fi

  init_state

  if [[ "$DRY_RUN" == "false" ]]; then
    reconcile_recovery_records
  fi

  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  if (( LIMIT > 0 )); then
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES | Limit: $LIMIT"
  else
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  fi
  if [[ "$RESOLVED_SPEND_TIER" == "override" ]]; then
    echo "CLI: $CLI | Model: $RESOLVED_MODEL (explicit --model override)"
  elif [[ "$RESOLVED_SPEND_TIER" == "cli-default" ]]; then
    echo "CLI: $CLI | Model: $CLI default"
  else
    echo "CLI: $CLI | Model: $RESOLVED_MODEL (spend_tier=${RESOLVED_SPEND_TIER})"
  fi
  echo "Input: $total_input offers"
  echo ""

  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue
    [[ -z "$id" || -z "$url" ]] && continue

    [[ "$id" =~ ^[0-9]+$ ]] || continue

    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$status" == "needs_confirmation" ]]; then
      echo "HOLD #$id: needs confirmation in the parent session ($url)"
      continue
    fi

    if [[ "$RESUME_PAUSED" == "true" ]]; then
      if [[ "$status" != "paused_rate_limit" ]]; then
        continue
      fi
    elif [[ "$RETRY_FAILED" == "true" ]]; then
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      if [[ "$status" == "completed" || "$status" == "skipped" ]]; then
        continue
      fi
      if [[ "$status" == "paused_rate_limit" ]]; then
        continue
      fi
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    if (( LIMIT > 0 )) && (( ${#pending_ids[@]} >= LIMIT )); then
      break
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  if (( PARALLEL <= 1 )); then
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Resume later with --resume-paused. ==="
        break
      fi
    done
  else
    local running=0
    local parallel_rc=0 worker_rc=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
        break
      fi

      while (( running >= PARALLEL )); do
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            worker_rc=0
            wait "${pids[$j]}" 2>/dev/null || worker_rc=$?
            if (( worker_rc != 0 )); then
              parallel_rc=$worker_rc
            fi
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        pids=(${pids[@]+"${pids[@]}"})
        pid_ids=(${pid_ids[@]+"${pid_ids[@]}"})
        if (( parallel_rc != 0 )); then
          break
        fi
        if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
          echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
          break
        fi
        sleep 1
      done

      if (( parallel_rc != 0 )) || [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        break
      fi

      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    for pid in ${pids[@]+"${pids[@]}"}; do
      worker_rc=0
      wait "$pid" 2>/dev/null || worker_rc=$?
      if (( worker_rc != 0 )); then
        parallel_rc=$worker_rc
      fi
    done
    if (( parallel_rc != 0 )); then
      echo "ERROR: a parallel worker failed fatally; tracker merge skipped. Inspect the worker log and repair state before rerunning." >&2
      return "$parallel_rc"
    fi
  fi

  merge_tracker

  print_summary

  exit 0
}

main "$@"
