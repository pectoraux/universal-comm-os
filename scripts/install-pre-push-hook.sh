#!/usr/bin/env bash
#
# scripts/install-pre-push-hook.sh — S0.2.4 (Article XVI §9 workaround)
#
# Installs a Git pre-push hook that runs the Repository Truth Gate in
# PR_INTEGRITY mode before allowing a push to succeed.
#
# WHY: GitHub branch protection is not available on private repos without
# GitHub Pro / Team / Enterprise. The current `pectoraux/universal-comm-os`
# repo is private and returns 403 on the branch-protection API. The pre-push
# hook is a compensating control — it runs the gate locally before the push
# reaches GitHub.
#
# BYPASS: `git push --no-verify` skips the hook. Doing so is an Article XVI
# violation and is recorded in the COMMIT REPORT (the agent must explicitly
# disclose `--no-verify` usage to the reviewer).
#
# The hook is installed at `.git/hooks/pre-push` and is therefore per-repo
# (not per-developer). Every developer who clones the repo and runs this
# installer gets the same hook.
#
# Usage:
#   bash scripts/install-pre-push-hook.sh

set -euo pipefail

HOOK_PATH=".git/hooks/pre-push"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE_SCRIPT="$SCRIPT_DIR/repo-truth-gate.sh"

if [ ! -d .git/hooks ]; then
  echo "FAIL: .git/hooks directory not found. Are you in a git repository?"
  exit 1
fi

if [ ! -x "$GATE_SCRIPT" ]; then
  echo "FAIL: $GATE_SCRIPT not executable or missing."
  echo "       Run: chmod +x $GATE_SCRIPT"
  exit 1
fi

# Write the hook. The hook receives stdin as: <local ref> <local sha> <remote ref> <remote sha> per line.
# We run the gate in PR_INTEGRITY mode before allowing the push.
cat > "$HOOK_PATH" << EOF
#!/usr/bin/env bash
# Auto-installed by scripts/install-pre-push-hook.sh (S0.2.4 / Article XVI §9).
# Runs the Repository Truth Gate in PR_INTEGRITY mode before push.
# Bypass: git push --no-verify (Article XVI violation — must be disclosed).

set -euo pipefail

REPO_ROOT="$REPO_ROOT"
GATE_SCRIPT="$GATE_SCRIPT"

# Read stdin (one line per ref being pushed). We only need to know that
# SOMETHING is being pushed; we run the gate once regardless.
while read -r _local_ref _local_sha _remote_ref _remote_sha; do
  :
done

# Only run the gate if the gate script exists and is executable.
if [ ! -x "\$GATE_SCRIPT" ]; then
  echo "WARN: \$GATE_SCRIPT not found or not executable — skipping pre-push gate (Article XVI §9)."
  exit 0
fi

# Run the gate in PR_INTEGRITY mode. In CI on a push event, the SHA equality
# is checked against origin/main by the MAIN_MILESTONE gate job; the local
# pre-push hook is the developer-side enforcement of the same invariant
# (before the push leaves the developer's machine).
#
# Note: PR_INTEGRITY mode does NOT fetch origin or compare to origin/main.
# This is intentional — at pre-push time, the local HEAD is what will
# become the new origin/main HEAD after the push. The MAIN_MILESTONE
# check (origin/main equality) happens in CI after the push lands.
if ! bash "\$GATE_SCRIPT" PR_INTEGRITY "pre-push-\$(git rev-parse --short HEAD)"; then
  echo "FAIL: pre-push Repository Truth Gate (PR_INTEGRITY mode) rejected the push."
  echo "       Fix the failures above, commit, and retry."
  echo "       To bypass (Article XVI violation, must be disclosed to reviewer):"
  echo "         git push --no-verify"
  exit 1
fi

exit 0
EOF

chmod +x "$HOOK_PATH"

echo "OK: pre-push hook installed at $HOOK_PATH"
echo "    Mode: PR_INTEGRITY"
echo "    Gate: $GATE_SCRIPT"
echo ""
echo "To bypass (Article XVI violation, must be disclosed to reviewer):"
echo "  git push --no-verify"
echo ""
echo "To uninstall:"
echo "  rm $HOOK_PATH"
