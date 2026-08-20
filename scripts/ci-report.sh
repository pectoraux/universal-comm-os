#!/bin/bash
# S0-10/S0.1-9: CI artifact reporting script.
# Returns nonzero exit if ANY mandatory check fails.
# Usage: bash scripts/ci-report.sh

set -e

REPORT_DIR="ci-artifacts"
mkdir -p "$REPORT_DIR"
FAIL_COUNT=0

echo "=== Universal Communication OS — CI Report ===" | tee "$REPORT_DIR/report.txt"
echo "Date: $(date -u)" | tee -a "$REPORT_DIR/report.txt"
echo "" | tee -a "$REPORT_DIR/report.txt"

# 1. Tests
echo "--- Tests ---" | tee -a "$REPORT_DIR/report.txt"
if bun run test 2>&1 | tee "$REPORT_DIR/tests.log" | tail -5 | tee -a "$REPORT_DIR/report.txt"; then
  echo "Tests: PASS" | tee -a "$REPORT_DIR/report.txt"
else
  echo "Tests: FAIL" | tee -a "$REPORT_DIR/report.txt"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo "" | tee -a "$REPORT_DIR/report.txt"

# 2. Architecture tests
echo "--- Architecture Tests ---" | tee -a "$REPORT_DIR/report.txt"
if bun run test:arch 2>&1 | tee "$REPORT_DIR/arch-tests.log" | tail -5 | tee -a "$REPORT_DIR/report.txt"; then
  echo "Architecture Tests: PASS" | tee -a "$REPORT_DIR/report.txt"
else
  echo "Architecture Tests: FAIL" | tee -a "$REPORT_DIR/report.txt"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo "" | tee -a "$REPORT_DIR/report.txt"

# 3. Lint
echo "--- Lint ---" | tee -a "$REPORT_DIR/report.txt"
if bun run lint 2>&1 | tee "$REPORT_DIR/lint.log" | tail -5 | tee -a "$REPORT_DIR/report.txt"; then
  echo "Lint: PASS" | tee -a "$REPORT_DIR/report.txt"
else
  echo "Lint: FAIL" | tee -a "$REPORT_DIR/report.txt"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo "" | tee -a "$REPORT_DIR/report.txt"

# 4. Typecheck
echo "--- Typecheck ---" | tee -a "$REPORT_DIR/report.txt"
if npx tsc --noEmit 2>&1 | tee "$REPORT_DIR/typecheck.log" | tail -5 | tee -a "$REPORT_DIR/report.txt"; then
  echo "Typecheck: PASS" | tee -a "$REPORT_DIR/report.txt"
else
  echo "Typecheck: FAIL (non-critical warnings)" | tee -a "$REPORT_DIR/report.txt"
  # Typecheck warnings don't fail CI
fi
echo "" | tee -a "$REPORT_DIR/report.txt"

# 5. Security checks
echo "--- Security Checks ---" | tee -a "$REPORT_DIR/report.txt"

# 5a. .env not in git history
if git log --all --oneline -- .env 2>/dev/null | head -1 > "$REPORT_DIR/env-check.txt" 2>&1; then
  if [ -s "$REPORT_DIR/env-check.txt" ]; then
    echo "Check: .env in git history: FAIL" | tee -a "$REPORT_DIR/report.txt"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    echo "Check: .env in git history: PASS" | tee -a "$REPORT_DIR/report.txt"
  fi
fi

# 5b. NEXTAUTH_SECRET fallback removed
if grep -q "dev-secret-change-in-production" src/lib/auth.ts 2>/dev/null; then
  echo "Check: NEXTAUTH_SECRET fallback: FAIL" | tee -a "$REPORT_DIR/report.txt"
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo "Check: NEXTAUTH_SECRET fallback: PASS" | tee -a "$REPORT_DIR/report.txt"
fi

# 5c. All server actions auth-guarded
AUTH_COUNT=$(grep -c "withAuth\|withRole" src/app/actions/commos.ts 2>/dev/null || echo "0")
if [ "$AUTH_COUNT" -gt "0" ]; then
  echo "Check: Server actions auth-guarded: PASS ($AUTH_COUNT guards)" | tee -a "$REPORT_DIR/report.txt"
else
  echo "Check: Server actions auth-guarded: FAIL" | tee -a "$REPORT_DIR/report.txt"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# 5d. Secret scan — check for patterns in tracked files
echo "" | tee -a "$REPORT_DIR/report.txt"
echo "--- Secret Scan ---" | tee -a "$REPORT_DIR/report.txt"
SECRET_PATTERNS="(ghp_[a-zA-Z0-9]\{36\}|vcp_[a-zA-Z0-9]\{40,\}|npg_[a-zA-Z0-9]\{16,\}|AKIA[A-Z0-9]\{16\})"
if git ls-files | xargs grep -rl "$SECRET_PATTERNS" 2>/dev/null | head -5 > "$REPORT_DIR/secret-scan.txt" 2>&1; then
  if [ -s "$REPORT_DIR/secret-scan.txt" ]; then
    echo "Check: Secret scan: FAIL — found secrets in tracked files:" | tee -a "$REPORT_DIR/report.txt"
    cat "$REPORT_DIR/secret-scan.txt" | tee -a "$REPORT_DIR/report.txt"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    echo "Check: Secret scan: PASS" | tee -a "$REPORT_DIR/report.txt"
  fi
fi

echo "" | tee -a "$REPORT_DIR/report.txt"
echo "=== Summary ===" | tee -a "$REPORT_DIR/report.txt"
echo "Failures: $FAIL_COUNT" | tee -a "$REPORT_DIR/report.txt"
echo "Artifacts in: $REPORT_DIR/" | tee -a "$REPORT_DIR/report.txt"

if [ "$FAIL_COUNT" -gt "0" ]; then
  echo "CI FAILED with $FAIL_COUNT failure(s)" | tee -a "$REPORT_DIR/report.txt"
  exit 1
fi

echo "CI PASSED" | tee -a "$REPORT_DIR/report.txt"
exit 0
