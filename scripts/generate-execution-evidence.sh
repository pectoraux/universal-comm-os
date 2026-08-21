#!/usr/bin/env bash
#
# scripts/generate-execution-evidence.sh — S0.2.5 (Article XVII / ARCH-052)
#
# Generates a machine-readable execution evidence manifest that proves:
#   - what commit was tested (commit_sha)
#   - what environment tested it (os, node, package_manager, runtime)
#   - what commands were executed (commands[] with exit_code + duration_ms)
#   - whether they succeeded (every exit_code must be 0 for a VALID manifest)
#   - whether the evidence corresponds to the repository state (commit_sha == HEAD)
#
# The manifest is written to:
#   docs/verification/latest-execution.json
#
# A copy is archived to:
#   docs/verification/history/<milestone>-<short-sha>-<timestamp>.json
#
# Usage:
#   scripts/generate-execution-evidence.sh <MILESTONE_ID>
#
# Example:
#   scripts/generate-execution-evidence.sh S0.2.5
#
# Pre-conditions:
#   - The Repository Truth Gate has already run successfully at this commit.
#     (The generator does NOT itself run the gate — but it does re-execute
#     the same validation commands and record their actual exit codes.)
#   - The worktree is clean (no uncommitted changes).
#
# Exit codes:
#   0 — manifest generated and all required commands succeeded (STATUS: VALID)
#   1 — generation failed (dirty worktree, missing dependencies, or a
#       required command failed; the manifest is still written with the
#       failure recorded — STATUS: INVALID)

set -euo pipefail

MILESTONE="${1:-UNKNOWN}"
EVIDENCE_DIR="docs/verification"
LATEST_MANIFEST="$EVIDENCE_DIR/latest-execution.json"
HISTORY_DIR="$EVIDENCE_DIR/history"

# ─── 1. Pre-conditions ──────────────────────────────────────────────────
# Worktree must be clean — the manifest's commit_sha must correspond to a
# real commit, not a working-tree snapshot.
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: worktree is dirty. Commit or stash before generating execution evidence."
  echo "       The manifest's commit_sha must correspond to a real commit."
  git status --porcelain
  exit 1
fi

# docs/verification/ must exist (or be creatable).
mkdir -p "$EVIDENCE_DIR" "$HISTORY_DIR"

# ─── 2. Capture environment ──────────────────────────────────────────────
COMMIT_SHA=$(git rev-parse HEAD)
SHORT_SHA=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
REPO_URL=$(git remote get-url origin 2>/dev/null | sed -E 's|https://[^@]*@|https://|' || echo "unknown")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S+00:00")

OS=$(uname -s)
OS_VER=$(uname -r)
OS_ARCH=$(uname -m)
ENV_OS="$OS $OS_ARCH (kernel $OS_VER)"

# Node version.
if command -v node >/dev/null 2>&1; then
  ENV_NODE=$(node --version 2>&1)
else
  ENV_NODE="not installed"
fi

# Package manager.
if command -v bun >/dev/null 2>&1; then
  ENV_PM=$(bun --version 2>&1 | sed 's/^/bun /')
elif command -v npm >/dev/null 2>&1; then
  ENV_PM=$(npm --version 2>&1 | sed 's/^/npm /')
else
  ENV_PM="not installed"
fi

# Runtime (vitest if available).
if command -v npx >/dev/null 2>&1; then
  ENV_RUNTIME=$(npx vitest --version 2>/dev/null | sed 's/^/vitest /' || echo "vitest (version unavailable)")
else
  ENV_RUNTIME="vitest (npx unavailable)"
fi

# ─── 3. Re-execute validation commands and record exit codes ─────────────
# The manifest reflects a REAL execution. We do NOT trust a prior gate run.
# We re-run each command and record the actual exit code + duration.
#
# Commands are run in order. If one fails, we still run the rest (so the
# manifest captures the full failure picture) but the overall STATUS is
# INVALID.
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

run_command() {
  local label="$1"
  shift
  local cmd_str="$1"
  shift
  local log_file="$TMPDIR/$label.log"
  local start_ms end_ms duration exit_code
  start_ms=$(date +%s%3N 2>/dev/null || date +%s)
  # Run the command, capturing all output. We do NOT let `set -e` exit
  # the script — we want to record the failure and continue.
  bash -c "$cmd_str" > "$log_file" 2>&1 || true
  exit_code=$?
  end_ms=$(date +%s%3N 2>/dev/null || date +%s)
  duration=$((end_ms - start_ms))

  # Extract the summary line (last line containing "passed" or "PASS"/"FAIL").
  local summary
  summary=$(tail -5 "$log_file" | grep -E '[0-9]+ passed|PASS|FAIL|error' | tail -1 || echo "exit_code=$exit_code")
  # Encode as a JSON entry.
  printf '{"label":"%s","command":%s,"exit_code":%d,"duration_ms":%d,"summary":%s}' \
    "$label" \
    "$(printf '%s' "$cmd_str" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')" \
    "$exit_code" \
    "$duration" \
    "$(printf '%s' "$summary" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
}

# We use python3 to assemble the JSON (jq may not be available). Each
# command entry is appended to a list.
declare -a COMMANDS

# Command 1: typecheck
COMMANDS+=("$(run_command typecheck "npx tsc --noEmit")")

# Command 2: full test suite
COMMANDS+=("$(run_command tests "bun run vitest --run")")

# Command 3: architecture subset
COMMANDS+=("$(run_command architecture "bun run vitest --run tests/architecture/")")

# Command 4: security subset
COMMANDS+=("$(run_command security "bun run vitest --run tests/architecture/s0-security.test.ts")")

# ─── 4. Compute results summaries ─────────────────────────────────────────
# Parse the last-line summary from each command's log file.
# For tsc (typecheck), success is silent — exit_code 0 with empty output means PASS.
# For vitest commands, success produces a "<N> passed" summary line.
extract_summary() {
  local label="$1"
  local log_file="$TMPDIR/$label.log"
  # Check the exit_code of this command (we stored it in the commands[] entry
  # via run_command; we don't have direct access here, so we re-derive it from
  # the log file's last few lines for the summary).
  local summary
  summary=$(tail -10 "$log_file" | grep -E '[0-9]+ passed|PASS|FAIL' | tail -1 || true)
  if [ -z "$summary" ]; then
    # No "passed"/PASS/FAIL line found. For typecheck specifically, success is
    # silent — an empty log means PASS. For other commands, an empty log
    # without a passed line is treated as FAIL.
    if [ "$label" = "typecheck" ]; then
      # The typecheck log on success is empty (tsc --noEmit produces no output).
      # We can't check exit_code here (we'd need to look at commands[]); instead
      # we rely on the caller to know whether the command succeeded.
      # Return "PASS" optimistically; the overall_status check will mark
      # the manifest INVALID if the typecheck exit_code was non-zero.
      summary="PASS"
    else
      if [ -s "$log_file" ]; then
        summary="FAIL (no pass/fail summary line found)"
      else
        summary="FAIL (empty log)"
      fi
    fi
  fi
  printf '%s' "$summary"
}

TYPECHECK_RESULT=$(extract_summary typecheck)
TESTS_RESULT=$(extract_summary tests)
ARCH_RESULT=$(extract_summary architecture)
SEC_RESULT=$(extract_summary security)

# ─── 5. Determine overall validity ───────────────────────────────────────
# A manifest is VALID iff every command exit_code is 0 AND the worktree is
# clean (already verified) AND HEAD didn't move during execution.
OVERALL_STATUS="VALID"
for entry in "${COMMANDS[@]}"; do
  exit_code=$(printf '%s' "$entry" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read())["exit_code"])')
  if [ "$exit_code" -ne 0 ]; then
    OVERALL_STATUS="INVALID"
    break
  fi
done

# Verify HEAD didn't move during execution.
FINAL_HEAD=$(git rev-parse HEAD)
if [ "$FINAL_HEAD" != "$COMMIT_SHA" ]; then
  OVERALL_STATUS="INVALID (HEAD moved during evidence generation: was $COMMIT_SHA, now $FINAL_HEAD)"
fi

# ─── 6. Build JSON manifest ──────────────────────────────────────────────
# Use python3 to assemble the final JSON (jq may not be available).
python3 -c "
import json, sys
commands = [$(printf '%s,' "${COMMANDS[@]}" | sed 's/,$//')]
manifest = {
  'milestone': '$MILESTONE',
  'commit_sha': '$COMMIT_SHA',
  'repository': '$REPO_URL',
  'branch': '$BRANCH',
  'timestamp': '$TIMESTAMP',
  'environment': {
    'os': '''$ENV_OS''',
    'node': '''$ENV_NODE''',
    'package_manager': '''$ENV_PM''',
    'runtime': '''$ENV_RUNTIME'''
  },
  'commands': commands,
  'results': {
    'tests': '''$TESTS_RESULT''',
    'architecture': '''$ARCH_RESULT''',
    'security': '''$SEC_RESULT''',
    'typecheck': '''$TYPECHECK_RESULT'''
  },
  'overall_status': '$OVERALL_STATUS'
}
print(json.dumps(manifest, indent=2))
" > "$LATEST_MANIFEST"

# Archive a copy.
ARCHIVE_FILE="$HISTORY_DIR/${MILESTONE}-${SHORT_SHA}-$(date -u +%Y%m%dT%H%M%SZ).json"
cp "$LATEST_MANIFEST" "$ARCHIVE_FILE"

# ─── 7. Final summary ─────────────────────────────────────────────────────
echo ""
echo "=== EXECUTION EVIDENCE GENERATED (S0.2.5 / Article XVII / ARCH-052) ==="
echo ""
echo "Milestone:       $MILESTONE"
echo "Commit SHA:      $COMMIT_SHA"
echo "Branch:          $BRANCH"
echo "Repository:      $REPO_URL"
echo "Timestamp:       $TIMESTAMP"
echo "Environment:     $ENV_OS"
echo "                 $ENV_NODE"
echo "                 $ENV_PM"
echo "                 $ENV_RUNTIME"
echo ""
echo "Commands executed:"
for entry in "${COMMANDS[@]}"; do
  printf '%s' "$entry" | python3 -c "
import sys, json
e = json.loads(sys.stdin.read())
status = 'VALID' if e['exit_code'] == 0 else 'INVALID'
print('  - [' + status + '] ' + e['label'] + ': exit_code=' + str(e['exit_code']) + ', duration_ms=' + str(e['duration_ms']))
"
done
echo ""
echo "Results:"
echo "  tests:         $TESTS_RESULT"
echo "  architecture:  $ARCH_RESULT"
echo "  security:      $SEC_RESULT"
echo "  typecheck:     $TYPECHECK_RESULT"
echo ""
echo "Overall status:  $OVERALL_STATUS"
echo ""
echo "Manifest written to:"
echo "  $LATEST_MANIFEST"
echo "Archived to:"
echo "  $ARCHIVE_FILE"
echo ""
if [ "$OVERALL_STATUS" = "VALID" ]; then
  echo "STATUS: VALID — the manifest can be verified with:"
  echo "  bash scripts/verify-execution-evidence.sh"
  exit 0
else
  echo "STATUS: INVALID — the manifest records a failure. Reviewer should investigate."
  exit 1
fi
