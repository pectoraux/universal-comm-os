#!/usr/bin/env bash
#
# scripts/repo-truth-gate.sh — S0.2.4 (Article XVI, ARCH-051)
#
# The Repository Truth Gate. Run this BEFORE declaring any milestone complete.
#
# S0.2.4 — the gate has TWO modes:
#
#   MAIN_MILESTONE  — for declaring a milestone COMPLETE on main.
#                     Requires: tested SHA == local HEAD == origin/main HEAD.
#                     Run by: bash scripts/repo-truth-gate.sh MAIN_MILESTONE <milestone-id>
#                     CI context: pushes to main.
#
#   PR_INTEGRITY   — for verifying a pull request's integrity.
#                     Requires: tested SHA == checked-out HEAD (== github.sha in CI).
#                     Does NOT require origin/main equality (the PR's commit
#                     is by definition not yet merged into main).
#                     Run by: bash scripts/repo-truth-gate.sh PR_INTEGRITY <pr-id>
#                     CI context: pull_request events.
#
# Common requirements (both modes):
#   1. Working tree clean (no uncommitted changes).
#   2. Full test suite passes at HEAD.
#   3. Architecture tests pass at HEAD (FATAL — was previously advisory).
#   4. Security tests pass at HEAD (FATAL — was previously advisory).
#   5. Typecheck passes at HEAD (FATAL — was previously `continue-on-error: true`).
#   6. HEAD did not move during the test run.
#
# Usage:
#   scripts/repo-truth-gate.sh <MODE> <MILESTONE_ID>
#
# Examples:
#   scripts/repo-truth-gate.sh MAIN_MILESTONE S0.2.4
#   scripts/repo-truth-gate.sh PR_INTEGRITY pr-42

set -euo pipefail

MODE="${1:-MAIN_MILESTONE}"
MILESTONE="${2:-UNKNOWN}"

if [ "$MODE" != "MAIN_MILESTONE" ] && [ "$MODE" != "PR_INTEGRITY" ]; then
  echo "FAIL: invalid mode '$MODE'. Must be MAIN_MILESTONE or PR_INTEGRITY."
  echo "Usage: $0 <MAIN_MILESTONE|PR_INTEGRITY> <milestone-id>"
  exit 2
fi

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

# ─── 2. Typecheck (FATAL — S0.2.4) ─────────────────────────────────────────
# Typecheck is required to pass at HEAD. Previously this was advisory
# (continue-on-error: true in the CI workflow) — that allowed type drift
# to accumulate while tests passed. Now it's a gate failure.
echo "Running typecheck at HEAD=$LOCAL_HEAD ..."
TYPECHECK_LOG="$TMPDIR/typecheck.log"
if ! npx tsc --noEmit > "$TYPECHECK_LOG" 2>&1; then
  echo "FAIL: typecheck failed (was previously advisory — now FATAL per S0.2.4)."
  # Print only the lines that originate from src/ and tests/ (filter out
  # noise from examples/, skills/, etc. that have pre-existing unrelated errors).
  grep -E "^(src/|tests/)" "$TYPECHECK_LOG" | head -20 || tail -20 "$TYPECHECK_LOG"
  exit 1
fi
TYPECHECK=PASS

# ─── 3. Full test suite at HEAD ───────────────────────────────────────────
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

# ─── 4. Architecture tests (FATAL — S0.2.4) ───────────────────────────────
# Previously the architecture subset was `|| true` — advisory only. S0.2.4
# makes any architecture test failure a gate failure.
echo "Running architecture tests at HEAD=$LOCAL_HEAD ..."
ARCH_LOG="$TMPDIR/arch.log"
if ! bun run vitest --run tests/architecture/ > "$ARCH_LOG" 2>&1; then
  echo "FAIL: architecture tests failed (was previously advisory — now FATAL per S0.2.4)."
  tail -20 "$ARCH_LOG"
  exit 1
fi
ARCH_TAIL=$(tail -5 "$ARCH_LOG")
ARCH_PASS=$(echo "$ARCH_TAIL" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '^[0-9]+' || true)
ARCH_FAIL=$(echo "$ARCH_TAIL" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '^[0-9]+' || true)
ARCH_PASS="${ARCH_PASS:-0}"
ARCH_FAIL="${ARCH_FAIL:-0}"
if [ "$ARCH_FAIL" -ne 0 ]; then
  echo "FAIL: $ARCH_FAIL architecture tests failed (FATAL per S0.2.4)."
  tail -20 "$ARCH_LOG"
  exit 1
fi

# ─── 5. Security tests (FATAL — S0.2.4) ────────────────────────────────────
# Security tests are the s0-security subset of tests/architecture/. They
# MUST pass for any gate to succeed.
echo "Running security tests at HEAD=$LOCAL_HEAD ..."
SEC_LOG="$TMPDIR/sec.log"
if ! bun run vitest --run tests/architecture/s0-security.test.ts > "$SEC_LOG" 2>&1; then
  echo "FAIL: security tests failed (FATAL per S0.2.4)."
  tail -20 "$SEC_LOG"
  exit 1
fi
SEC_TAIL=$(tail -5 "$SEC_LOG")
SEC_PASS=$(echo "$SEC_TAIL" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '^[0-9]+' || true)
SEC_FAIL=$(echo "$SEC_TAIL" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '^[0-9]+' || true)
SEC_PASS="${SEC_PASS:-0}"
SEC_FAIL="${SEC_FAIL:-0}"
if [ "$SEC_FAIL" -ne 0 ]; then
  echo "FAIL: $SEC_FAIL security tests failed (FATAL per S0.2.4)."
  tail -20 "$SEC_LOG"
  exit 1
fi

# ─── 6. HEAD did not move during tests ────────────────────────────────────
TESTED_SHA=$(git rev-parse HEAD)
if [ "$TESTED_SHA" != "$LOCAL_HEAD" ]; then
  echo "FAIL: HEAD moved during tests (was $LOCAL_HEAD, now $TESTED_SHA)."
  exit 1
fi

# ─── 7. Mode-specific SHA equality check ───────────────────────────────────
if [ "$MODE" = "MAIN_MILESTONE" ]; then
  # MAIN_MILESTONE: the tested commit MUST be on origin/main.
  git fetch origin --quiet 2>&1 || true
  REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "UNKNOWN")
  if [ "$REMOTE_HEAD" = "UNKNOWN" ]; then
    echo "FAIL: MAIN_MILESTONE mode requires origin/main HEAD to be resolvable."
    echo "       Did you push? Run: git push origin main"
    exit 1
  fi
  if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
    echo "FAIL: MAIN_MILESTONE mode requires local HEAD == origin/main HEAD."
    echo "  local HEAD:     $LOCAL_HEAD"
    echo "  origin/main:    $REMOTE_HEAD"
    echo "  Run: git push origin main"
    exit 1
  fi
  MATCH_DESC="local HEAD == origin/main HEAD == tested SHA"
elif [ "$MODE" = "PR_INTEGRITY" ]; then
  # PR_INTEGRITY: the tested commit must equal the checked-out HEAD.
  # In CI, github.sha == checked-out HEAD; origin/main is NOT consulted
  # because the PR's commit has not yet been merged into main.
  REMOTE_HEAD="(not consulted in PR_INTEGRITY mode)"
  MATCH_DESC="tested SHA == checked-out HEAD (origin/main NOT required)"
fi

MATCH=YES

# ─── 8. Generate execution evidence (S0.2.5 / Article XVII / ARCH-052) ────
# The gate re-runs the validation commands AND generates a manifest that
# records the actual exit codes. The manifest is written to
# docs/verification/latest-execution.json (gitignored — it's a generated
# artifact, not a tracked source file).
EVIDENCE_PATH="docs/verification/latest-execution.json"
EVIDENCE_SHA="(not generated)"
EVIDENCE_STATUS="INVALID"

if [ -x scripts/generate-execution-evidence.sh ]; then
  # The generator re-runs the validation commands and records their actual
  # exit codes. We capture the generator's stdout in a log file so the gate
  # can report evidence status without polluting the COMMIT REPORT.
  EVIDENCE_LOG="$TMPDIR/evidence.log"
  if bash scripts/generate-execution-evidence.sh "$MILESTONE" > "$EVIDENCE_LOG" 2>&1; then
    EVIDENCE_SHA="$LOCAL_HEAD"
    # Verify the manifest immediately.
    if bash scripts/verify-execution-evidence.sh >> "$EVIDENCE_LOG" 2>&1; then
      EVIDENCE_STATUS="VALID"
    else
      EVIDENCE_STATUS="INVALID (verification failed)"
      tail -5 "$EVIDENCE_LOG" >&2 || true
    fi
  else
    EVIDENCE_SHA="$LOCAL_HEAD"
    EVIDENCE_STATUS="INVALID (generation failed)"
    tail -5 "$EVIDENCE_LOG" >&2 || true
  fi
else
  echo "WARN: scripts/generate-execution-evidence.sh not executable — skipping execution evidence generation (Article XVII)." >&2
  EVIDENCE_STATUS="INVALID (generator not found)"
fi

# ─── 9. Files added/modified in HEAD vs HEAD~1 ────────────────────────────
FILES_ADDED=$(git show --stat --name-status HEAD 2>/dev/null | grep -E '^A' | awk '{print $2}' | sort | tr '\n' ',' | sed 's/,$//' || true)
FILES_MODIFIED=$(git show --stat --name-status HEAD 2>/dev/null | grep -E '^[MCDR]' | awk '{print $2}' | sort | tr '\n' ',' | sed 's/,$//' || true)

# ─── 9. COMMIT REPORT ─────────────────────────────────────────────────────
printf '\n'
printf '=== REPOSITORY TRUTH GATE — %s (mode: %s) ===\n\n' "$MILESTONE" "$MODE"
printf 'MILESTONE:      %s\n' "$MILESTONE"
printf 'MODE:           %s\n' "$MODE"
printf 'LOCAL HEAD:     %s\n' "$LOCAL_HEAD"
printf 'GITHUB main:    %s\n' "$REMOTE_HEAD"
printf 'TESTED SHA:     %s\n' "$TESTED_SHA"
printf 'MATCH:          %s\n' "$MATCH"
printf 'MATCH INVARIANT:%s\n' "$MATCH_DESC"
printf 'WORKTREE CLEAN: %s\n' "$WORKTREE_CLEAN"
printf '\n'
printf 'TEST RESULT:    %s passed / %s failed\n' "$TEST_PASS" "$TEST_FAIL"
printf 'ARCHITECTURE:   %s passed / %s failed (FATAL)\n' "$ARCH_PASS" "$ARCH_FAIL"
printf 'SECURITY:       %s passed / %s failed (FATAL)\n' "$SEC_PASS" "$SEC_FAIL"
printf 'TYPECHECK:       %s (FATAL)\n' "$TYPECHECK"
printf '\n'
printf 'EXECUTION EVIDENCE (S0.2.5 / Article XVII / ARCH-052):\n'
printf '  PATH:   %s\n' "$EVIDENCE_PATH"
printf '  SHA:    %s\n' "$EVIDENCE_SHA"
printf '  STATUS: %s\n' "$EVIDENCE_STATUS"
printf '\n'
printf 'FILES ADDED:    %s\n' "${FILES_ADDED:-<none>}"
printf 'FILES MODIFIED: %s\n' "${FILES_MODIFIED:-<none>}"
printf '\n'
printf '=== END REPORT ===\n\n'
if [ "$MODE" = "MAIN_MILESTONE" ]; then
  printf 'Reviewer verification (MAIN_MILESTONE):\n'
  printf '  git ls-tree -r origin/main --name-only    # list every file at origin/main\n'
  printf '  git show origin/main:<path>              # retrieve the exact bytes\n'
  printf '  git rev-parse origin/main                # confirm the SHA reported here\n'
  printf '  cat docs/verification/latest-execution.json  # inspect the execution evidence manifest\n'
  printf '  bash scripts/verify-execution-evidence.sh   # verify the manifest\n'
else
  printf 'Reviewer verification (PR_INTEGRITY):\n'
  printf '  git rev-parse HEAD                       # the checked-out SHA\n'
  printf '  git show HEAD:<path>                     # retrieve the exact bytes\n'
  printf '  Note: origin/main equality is NOT required in PR_INTEGRITY mode.\n'
  printf '  cat docs/verification/latest-execution.json  # inspect the execution evidence manifest\n'
  printf '  bash scripts/verify-execution-evidence.sh   # verify the manifest\n'
fi
printf '\n'

# S0.2.5: A milestone reported COMPLETE without VALID execution evidence is
# automatically INVALID (Article XVII). Exit non-zero if evidence is not VALID
# — this forces the agent to regenerate before claiming completion.
if [ "$EVIDENCE_STATUS" != "VALID" ]; then
  echo "FAIL: execution evidence is $EVIDENCE_STATUS (Article XVII requires VALID)." >&2
  exit 1
fi

exit 0
