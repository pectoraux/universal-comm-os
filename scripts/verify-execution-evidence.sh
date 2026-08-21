#!/usr/bin/env bash
#
# scripts/verify-execution-evidence.sh — S0.2.5 (Article XVII / ARCH-052)
#
# Verifies the execution evidence manifest at docs/verification/latest-execution.json.
#
# Verifies:
#   1. The manifest exists.
#   2. It parses as JSON.
#   3. All required fields are present and non-empty.
#   4. commit_sha == git rev-parse HEAD (manifest corresponds to current commit).
#   5. repository matches the current origin URL (credentials stripped).
#   6. Every commands[].exit_code is 0 (no failed commands).
#   7. timestamp parses as ISO-8601 and is within the last 30 days.
#   8. results.typecheck is "PASS".
#   9. results.tests / results.architecture / results.security each contain
#      "passed" with a non-zero count and "0 failed".
#
# Usage:
#   scripts/verify-execution-evidence.sh
#
# Exit codes:
#   0 — manifest is VALID (all checks pass)
#   1 — manifest is INVALID (with specific error message)

set -euo pipefail

MANIFEST="docs/verification/latest-execution.json"

if [ ! -f "$MANIFEST" ]; then
  echo "FAIL: execution evidence manifest not found at $MANIFEST"
  echo "      Run: bash scripts/generate-execution-evidence.sh <milestone>"
  exit 1
fi

# ─── 1. Parse JSON ───────────────────────────────────────────────────────
if ! python3 -c "import json,sys; json.load(open('$MANIFEST'))" 2>/dev/null; then
  echo "FAIL: $MANIFEST is not valid JSON."
  exit 1
fi

# ─── 2. Required fields ──────────────────────────────────────────────────
REQUIRED_TOP="milestone commit_sha repository branch timestamp"
REQUIRED_ENV="os node package_manager runtime"
REQUIRED_RESULTS="tests architecture security typecheck"

check_field() {
  local field="$1"
  local value
  value=$(python3 -c "
import json
m = json.load(open('$MANIFEST'))
v = m
for p in '$field'.split('.'):
  if not isinstance(v, dict) or p not in v or v[p] is None or v[p] == '':
    print('__MISSING__')
    break
  v = v[p]
else:
  print('__OK__' if v != '' else '__EMPTY__')
")
  if [ "$value" = "__MISSING__" ]; then
    echo "FAIL: required field '$field' is missing from manifest."
    exit 1
  elif [ "$value" = "__EMPTY__" ]; then
    echo "FAIL: required field '$field' is empty in manifest."
    exit 1
  fi
}

for f in $REQUIRED_TOP; do check_field "$f"; done
for f in $REQUIRED_ENV; do check_field "environment.$f"; done
for f in $REQUIRED_RESULTS; do check_field "results.$f"; done

# Also check commands[] is a non-empty list.
CMDS_LEN=$(python3 -c "import json; m=json.load(open('$MANIFEST')); print(len(m.get('commands', [])))")
if [ "$CMDS_LEN" = "0" ] || [ "$CMDS_LEN" = "" ]; then
  echo "FAIL: manifest commands[] is empty — no commands were recorded."
  exit 1
fi

# ─── 3. commit_sha matches HEAD ──────────────────────────────────────────
MANIFEST_SHA=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['commit_sha'])")
HEAD_SHA=$(git rev-parse HEAD)
if [ "$MANIFEST_SHA" != "$HEAD_SHA" ]; then
  echo "FAIL: manifest commit_sha ($MANIFEST_SHA) != HEAD ($HEAD_SHA)."
  echo "      The repository advanced past the manifest's commit."
  echo "      Regenerate: bash scripts/generate-execution-evidence.sh <milestone>"
  exit 1
fi

# ─── 4. repository matches origin ────────────────────────────────────────
MANIFEST_REPO=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['repository'])")
ORIGIN_URL=$(git remote get-url origin 2>/dev/null | sed -E 's|https://[^@]*@|https://|' || echo "unknown")
if [ "$MANIFEST_REPO" != "$ORIGIN_URL" ]; then
  echo "FAIL: manifest repository ($MANIFEST_REPO) != origin URL ($ORIGIN_URL)."
  echo "      The remote changed since the manifest was generated."
  exit 1
fi

# ─── 5. All command exit_codes are 0 ─────────────────────────────────────
FAILED_CMDS=$(python3 -c "
import json
m = json.load(open('$MANIFEST'))
for c in m['commands']:
  if c['exit_code'] != 0:
    print(f\"  - {c['label']}: exit_code={c['exit_code']}\")
")
if [ -n "$FAILED_CMDS" ]; then
  echo "FAIL: manifest records non-zero exit codes:"
  echo "$FAILED_CMDS"
  exit 1
fi

# ─── 6. timestamp is ISO-8601 and within 30 days ─────────────────────────
TS_CHECK=$(python3 -c "
import json, datetime, sys
m = json.load(open('$MANIFEST'))
ts = m['timestamp']
try:
  dt = datetime.datetime.fromisoformat(ts)
except Exception as e:
  print(f'TS_PARSE_FAIL: {e}')
  sys.exit(0)
now = datetime.datetime.now(dt.tzinfo)
age_days = (now - dt).days
if age_days > 30:
  print(f'TS_STALE: {age_days} days old (max 30)')
  sys.exit(0)
print('TS_OK')
")
if [[ "$TS_CHECK" == TS_PARSE_FAIL:* ]]; then
  echo "FAIL: manifest timestamp is not valid ISO-8601: ${TS_CHECK#TS_PARSE_FAIL: }"
  exit 1
elif [[ "$TS_CHECK" == TS_STALE:* ]]; then
  echo "FAIL: manifest is stale: ${TS_CHECK#TS_STALE: }"
  exit 1
elif [ "$TS_CHECK" != "TS_OK" ]; then
  echo "FAIL: manifest timestamp check returned unexpected: $TS_CHECK"
  exit 1
fi

# ─── 7. results.typecheck == "PASS" ──────────────────────────────────────
TYPECHECK=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['results']['typecheck'])")
if [ "$TYPECHECK" != "PASS" ]; then
  echo "FAIL: manifest results.typecheck = '$TYPECHECK' (expected 'PASS')."
  exit 1
fi

# ─── 8. results.tests/architecture/security contain "passed" + non-zero count ──
# Vitest output format on success: "Tests <N> passed (<N>)" — no "failed"
# line is shown because there are zero failures. The verifier accepts BOTH:
#   (a) explicit "0 failed" in the summary, OR
#   (b) "passed (<N>)" where the two N values match (meaning 0 failures).
for f in tests architecture security; do
  VALUE=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['results']['$f'])")
  # Must contain a digit followed by " passed" (e.g., "435 passed")
  if ! echo "$VALUE" | grep -qE '[0-9]+ passed'; then
    echo "FAIL: manifest results.$f ('$VALUE') does not contain '<N> passed'."
    exit 1
  fi
  # The passed count must be non-zero.
  PASSED_COUNT=$(echo "$VALUE" | grep -oE '[0-9]+ passed' | grep -oE '^[0-9]+')
  if [ "$PASSED_COUNT" = "0" ]; then
    echo "FAIL: manifest results.$f ('$VALUE') has 0 tests passed."
    exit 1
  fi
  # If "failed" appears, it must be "0 failed" — non-zero failures are a FAIL.
  if echo "$VALUE" | grep -qE '[0-9]+ failed'; then
    FAILED_COUNT=$(echo "$VALUE" | grep -oE '[0-9]+ failed' | grep -oE '^[0-9]+')
    if [ "$FAILED_COUNT" != "0" ]; then
      echo "FAIL: manifest results.$f ('$VALUE') records $FAILED_COUNT failed tests."
      exit 1
    fi
  fi
  # If vitest output is "Tests <N> passed (<M>)" with N == M, that means
  # 0 failures (M = total = N + failures; if N == M, failures == 0).
  if echo "$VALUE" | grep -qE '[0-9]+ passed \([0-9]+\)'; then
    PASSED_INNER=$(echo "$VALUE" | grep -oE '[0-9]+ passed \([0-9]+\)' | grep -oE 'passed \([0-9]+\)' | grep -oE '[0-9]+\)' | tr -d '()')
    PASSED_OUTER=$(echo "$VALUE" | grep -oE '[0-9]+ passed' | grep -oE '^[0-9]+')
    if [ "$PASSED_INNER" != "$PASSED_OUTER" ]; then
      echo "FAIL: manifest results.$f ('$VALUE') shows $PASSED_OUTER passed but $PASSED_INNER total — implies non-zero failures."
      exit 1
    fi
  fi
done

# ─── All checks passed ───────────────────────────────────────────────────
echo "=== EXECUTION EVIDENCE VERIFIED (S0.2.5 / Article XVII / ARCH-052) ==="
echo ""
echo "Manifest:        $MANIFEST"
echo "Milestone:       $(python3 -c "import json; print(json.load(open('$MANIFEST'))['milestone'])")"
echo "Commit SHA:      $MANIFEST_SHA"
echo "Repository:      $MANIFEST_REPO"
echo "Branch:          $(python3 -c "import json; print(json.load(open('$MANIFEST'))['branch'])")"
echo "Timestamp:       $(python3 -c "import json; print(json.load(open('$MANIFEST'))['timestamp'])")"
echo ""
echo "Commands recorded: $CMDS_LEN (all exit_code=0)"
echo ""
echo "Results:"
echo "  tests:         $(python3 -c "import json; print(json.load(open('$MANIFEST'))['results']['tests'])")"
echo "  architecture:  $(python3 -c "import json; print(json.load(open('$MANIFEST'))['results']['architecture'])")"
echo "  security:      $(python3 -c "import json; print(json.load(open('$MANIFEST'))['results']['security'])")"
echo "  typecheck:     $TYPECHECK"
echo ""
echo "STATUS: VALID"
exit 0
