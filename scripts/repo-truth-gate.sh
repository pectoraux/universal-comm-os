#!/usr/bin/env bash
#
# scripts/repo-truth-gate.sh — S0.2.3 (Article XVI, ARCH-051)
#
# The Repository Truth Gate. Run this BEFORE declaring any milestone complete.
#
# Verifies:
#   1. The working tree is clean (no uncommitted changes).
#   2. The full test suite passes at the current HEAD.
#   3. The local HEAD has been pushed to origin/main.
#   4. local HEAD == origin/main HEAD == the commit just tested.
#
# Exits 0 only if all four conditions hold. Produces a COMMIT REPORT on stdout
# that the agent MUST include verbatim in the milestone completion message.
#
# Usage:
#   scripts/repo-truth-gate.sh <MILESTONE_ID>
#
# Example:
#   scripts/repo-truth-gate.sh S0.2.2

set -euo pipefail

MILESTONE="${1:-UNKNOWN}"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# ─── 1. Working tree clean ───────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: working tree is dirty. Commit or stash your changes before running this gate."
  git status --porcelain
  exit 1
fi
WORKTREE_CLEAN=YES
LOCAL_HEAD=$(git rev-parse HEAD)

# ─── 2. Run full test suite at HEAD ───────────────────────────────────────
echo "Running full test suite at HEAD=$LOCAL_HEAD ..."
TEST_LOG="$TMPDIR/tests.log"
if ! bun run vitest --run > "$TEST_LOG" 2>&1; then
  echo "FAIL: test suite did not pass cleanly."
  tail -10 "$TEST_LOG"
  exit 1
fi
TEST_TAIL=$(tail -10 "$TEST_LOG")
TEST_PASS=$(echo "$TEST_TAIL" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '^[0-9]+' || true)
TEST_FAIL=$(echo "$TEST_TAIL" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '^[0-9]+' || true)
TEST_PASS="${TEST_PASS:-0}"
TEST_FAIL="${TEST_FAIL:-0}"

if [ "$TEST_FAIL" -ne 0 ] || [ "$TEST_PASS" -eq 0 ]; then
  echo "FAIL: test results invalid ($TEST_PASS passed, $TEST_FAIL failed)."
  tail -10 "$TEST_LOG"
  exit 1
fi

# Re-check worktree cleanliness after tests.
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: tests left the working tree dirty."
  git status --porcelain
  exit 1
fi

# ─── 3. Architecture subset (for the report) ──────────────────────────────
ARCH_LOG="$TMPDIR/arch.log"
bun run vitest --run tests/architecture/ > "$ARCH_LOG" 2>&1 || true
ARCH_TAIL=$(tail -5 "$ARCH_LOG")
ARCH_PASS=$(echo "$ARCH_TAIL" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '^[0-9]+' || true)
ARCH_PASS="${ARCH_PASS:-0}"

# ─── 4. Fetch + compare ────────────────────────────────────────────────────
git fetch origin --quiet 2>&1 || true
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "UNKNOWN")

if [ "$REMOTE_HEAD" = "UNKNOWN" ]; then
  echo "FAIL: cannot resolve origin/main HEAD. Did you push?"
  exit 1
fi

if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "FAIL: local HEAD != origin/main HEAD."
  echo "  local HEAD:     $LOCAL_HEAD"
  echo "  origin/main:    $REMOTE_HEAD"
  echo "  Run: git push origin main"
  exit 1
fi

# ─── 5. HEAD must not have moved during tests ──────────────────────────────
TESTED_SHA=$(git rev-parse HEAD)
if [ "$TESTED_SHA" != "$LOCAL_HEAD" ]; then
  echo "FAIL: HEAD moved during tests (was $LOCAL_HEAD, now $TESTED_SHA)."
  exit 1
fi

MATCH=YES

# ─── 6. Files added/modified in HEAD vs HEAD~1 ────────────────────────────
FILES_ADDED=$(git show --stat --name-status HEAD | grep -E '^A' | awk '{print $2}' | sort | tr '\n' ',' | sed 's/,$//' || true)
FILES_MODIFIED=$(git show --stat --name-status HEAD | grep -E '^[MCDR]' | awk '{print $2}' | sort | tr '\n' ',' | sed 's/,$//' || true)

# ─── 7. COMMIT REPORT ─────────────────────────────────────────────────────
printf '\n'
printf '=== REPOSITORY TRUTH GATE — %s ===\n\n' "$MILESTONE"
printf 'MILESTONE:      %s\n' "$MILESTONE"
printf 'LOCAL HEAD:     %s\n' "$LOCAL_HEAD"
printf 'GITHUB main:    %s\n' "$REMOTE_HEAD"
printf 'TESTED SHA:     %s\n' "$TESTED_SHA"
printf 'MATCH:          %s\n' "$MATCH"
printf 'WORKTREE CLEAN: %s\n' "$WORKTREE_CLEAN"
printf '\n'
printf 'TEST RESULT:    %s passed / %s failed\n' "$TEST_PASS" "$TEST_FAIL"
printf 'ARCHITECTURE:   %s passed (subset of above)\n' "$ARCH_PASS"
printf '\n'
printf 'FILES ADDED:    %s\n' "${FILES_ADDED:-<none>}"
printf 'FILES MODIFIED: %s\n' "${FILES_MODIFIED:-<none>}"
printf '\n'
printf '=== END REPORT ===\n\n'
printf 'Reviewer verification:\n'
printf '  git ls-tree -r origin/main --name-only    # list every file at origin/main\n'
printf '  git show origin/main:<path>              # retrieve the exact bytes\n'
printf '  git rev-parse origin/main                # confirm the SHA reported here\n'
printf '\n'

exit 0
