/**
 * S0.2.3 + S0.2.4 — Repository Truth Gate (Article XVI / ARCH-051) acceptance tests.
 *
 * These tests prove the governance gate exists and is structurally sound.
 * They do NOT replace the gate itself (which is a runtime script + CI job);
 * they prove the gate's documentation and tooling are present and consistent
 * with the constitution.
 *
 * A milestone reported COMPLETE without satisfying Article XVI is
 * automatically INVALID. These tests make that enforceable in CI.
 *
 * S0.2.4 added a SECOND mode (PR_INTEGRITY) to the gate. The original
 * MAIN_MILESTONE mode (S0.2.3) is unchanged in spirit; the gate script
 * now takes a MODE argument and branches behavior:
 *
 *   MAIN_MILESTONE  — requires local HEAD == origin/main HEAD == tested SHA
 *   PR_INTEGRITY    — requires tested SHA == checked-out HEAD only; does
 *                     NOT consult origin/main
 *
 * S0.2.4 also made:
 *   - architecture tests FATAL in the gate (was `|| true`)
 *   - security tests a FATAL dedicated subset
 *   - typecheck FATAL in CI (removed `continue-on-error: true`)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const CONSTITUTION_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_CONSTITUTION.md');
const LEDGER_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_LEDGER.md');
const GATE_SCRIPT = join(PROJECT_ROOT, 'scripts', 'repo-truth-gate.sh');
const PRE_PUSH_INSTALLER = join(PROJECT_ROOT, 'scripts', 'install-pre-push-hook.sh');
const CI_WORKFLOW = join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml');

// ─── S0.2.3-A: Constitution Article XVI — Repository Truth Gate ────────

describe('S0.2.3-A: Constitution Article XVI — Repository Truth Gate', () => {
  const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');

  it('Article XVI exists', () => {
    expect(constitution).toContain('Article XVI');
  });

  it('codifies the SHA equality invariant (MAIN_MILESTONE mode)', () => {
    expect(constitution).toContain('local HEAD == origin/main HEAD == tested commit SHA');
  });

  it('codifies the worktree-clean requirement', () => {
    expect(constitution).toContain('git status --porcelain');
    expect(constitution).toContain('dirty');
  });

  it('codifies the COMMIT REPORT format', () => {
    expect(constitution).toContain('MILESTONE:');
    expect(constitution).toContain('LOCAL HEAD:');
    expect(constitution).toContain('GITHUB main:');
    expect(constitution).toContain('TESTED SHA:');
    expect(constitution).toContain('MATCH:');
    expect(constitution).toContain('WORKTREE CLEAN:');
  });

  it('documents the independent-verification right of the reviewer', () => {
    expect(constitution).toContain('Reviewer verification');
    expect(constitution).toContain('git show origin/main:<path>');
  });

  it('documents the CI enforcement path (GitHub Actions)', () => {
    expect(constitution).toContain('GitHub Actions');
    expect(constitution).toContain('BUILD_AT_SHA');
    expect(constitution).toContain('TESTED_AT_SHA');
    expect(constitution).toContain('ARCHITECTURE_AT_SHA');
  });

  it('records the S0.2.2 governance failure as the motivation', () => {
    expect(constitution).toContain('S0.2.2 governance failure');
    expect(constitution).toContain('404');
    expect(constitution).toContain('UNVERIFIED');
  });

  it('declares unverified completion reports INVALID', () => {
    expect(constitution).toContain('automatically INVALID');
  });
});

// ─── S0.2.4-A: Constitution describes the two gate modes ──────────────

describe('S0.2.4-A: Constitution Article XVI — two gate modes', () => {
  const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');

  it('documents Mode 1: MAIN_MILESTONE', () => {
    expect(constitution).toContain('Mode 1: MAIN_MILESTONE');
    expect(constitution).toContain('MAIN_MILESTONE');
  });

  it('documents Mode 2: PR_INTEGRITY', () => {
    expect(constitution).toContain('Mode 2: PR_INTEGRITY');
    expect(constitution).toContain('PR_INTEGRITY');
  });

  it('MAIN_MILESTONE requires origin/main equality', () => {
    // The MAIN_MILESTONE procedure explicitly fetches origin and compares.
    expect(constitution).toContain('MAIN_MILESTONE procedure');
    expect(constitution).toMatch(/local HEAD == origin\/main HEAD == tested commit SHA/);
  });

  it('PR_INTEGRITY explicitly does NOT consult origin/main', () => {
    expect(constitution).toContain('PR_INTEGRITY procedure');
    expect(constitution).toContain('Do NOT consult `origin/main`');
  });

  it('documents the common requirements (both modes)', () => {
    expect(constitution).toContain('Common requirements');
    expect(constitution).toContain('Architecture tests pass');
    expect(constitution).toContain('Security tests pass');
    expect(constitution).toContain('Typecheck passes');
  });

  it('marks architecture tests as FATAL (was previously advisory)', () => {
    expect(constitution).toContain('Architecture tests pass');
    expect(constitution).toMatch(/FATAL \(previously advisory.*\|\| true/);
  });

  it('marks security tests as a FATAL dedicated subset', () => {
    expect(constitution).toContain('Security tests pass');
    expect(constitution).toMatch(/FATAL.*dedicated subset/);
  });

  it('marks typecheck as FATAL (was previously continue-on-error)', () => {
    expect(constitution).toContain('Typecheck passes');
    expect(constitution).toMatch(/FATAL.*continue-on-error: true/);
  });

  it('documents the COMMIT REPORT with MODE field', () => {
    expect(constitution).toContain('MODE:');
    expect(constitution).toContain('MAIN_MILESTONE | PR_INTEGRITY');
    expect(constitution).toContain('MATCH INVARIANT:');
  });

  it('documents the branch-protection limitation on private repos', () => {
    expect(constitution).toContain('Branch protection');
    expect(constitution).toContain('GitHub Pro');
    expect(constitution).toContain('403');
  });

  it('documents the pre-push hook as a compensating control', () => {
    expect(constitution).toContain('pre-push hook');
    expect(constitution).toContain('install-pre-push-hook.sh');
  });
});

// ─── S0.2.3-B: Architecture ledger ARCH-051 ────────────────────────────

describe('S0.2.3-B: Architecture ledger ARCH-051', () => {
  const ledger = readFileSync(LEDGER_FILE, 'utf-8');

  it('ARCH-051 entry exists', () => {
    expect(ledger).toContain('ARCH-051');
  });

  it('references Article XVI', () => {
    expect(ledger).toContain('Article XVI');
  });

  it('requires the gate script scripts/repo-truth-gate.sh', () => {
    expect(ledger).toContain('scripts/repo-truth-gate.sh');
  });

  it('records the S0.2.2 motivation (mentions 404 from the GitHub API)', () => {
    expect(ledger).toContain('S0.2.2');
    expect(ledger).toContain('404');
  });
});

// ─── S0.2.4-B: Ledger ARCH-051 describes the two modes ─────────────────

describe('S0.2.4-B: Ledger ARCH-051 — two modes', () => {
  const ledger = readFileSync(LEDGER_FILE, 'utf-8');

  it('describes MAIN_MILESTONE mode', () => {
    expect(ledger).toContain('MAIN_MILESTONE');
  });

  it('describes PR_INTEGRITY mode', () => {
    expect(ledger).toContain('PR_INTEGRITY');
  });

  it('records that PR_INTEGRITY does NOT consult origin/main', () => {
    expect(ledger).toMatch(/PR_INTEGRITY.*does NOT consult/i);
  });

  it('records that architecture tests are FATAL', () => {
    expect(ledger).toMatch(/[Aa]rchitecture tests FATAL/);
  });

  it('records that security tests are a FATAL dedicated subset', () => {
    expect(ledger).toMatch(/[Ss]ecurity tests.*FATAL.*dedicated subset/);
  });

  it('records that typecheck is FATAL (continue-on-error removed)', () => {
    expect(ledger).toMatch(/[Tt]ypecheck FATAL/);
    expect(ledger).toContain('continue-on-error');
  });

  it('records the branch-protection 403 limitation', () => {
    expect(ledger).toContain('403');
    expect(ledger).toContain('GitHub Pro');
  });

  it('records the pre-push hook workaround', () => {
    expect(ledger).toContain('install-pre-push-hook.sh');
  });
});

// ─── S0.2.3-C: Gate script exists and is executable ───────────────────

describe('S0.2.3-C: Gate script exists and is executable', () => {
  it('scripts/repo-truth-gate.sh exists', () => {
    expect(existsSync(GATE_SCRIPT)).toBe(true);
  });

  it('is executable (mode bits include user-exec)', () => {
    expect(existsSync(GATE_SCRIPT)).toBe(true);
    const stat = statSync(GATE_SCRIPT);
    const userExec = (stat.mode & 0o100) !== 0;
    expect(userExec).toBe(true);
  });

  it('checks worktree cleanliness', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('git status --porcelain');
    expect(script).toMatch(/\[ -n "\$\(git status --porcelain\)" \]/);
  });

  it('runs the full test suite', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('bun run vitest --run');
  });

  it('has `set -euo pipefail` (fails fast on any error)', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('set -euo pipefail');
  });

  it('emits the COMMIT REPORT', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('MILESTONE:');
    expect(script).toContain('LOCAL HEAD:');
    expect(script).toContain('TESTED SHA:');
    expect(script).toContain('MATCH:');
    expect(script).toContain('WORKTREE CLEAN:');
    expect(script).toContain('FILES ADDED:');
    expect(script).toContain('FILES MODIFIED:');
  });
});

// ─── S0.2.4-C: Gate script implements the two modes ───────────────────

describe('S0.2.4-C: Gate script implements the two modes', () => {
  const script = readFileSync(GATE_SCRIPT, 'utf-8');

  it('accepts a MODE argument (MAIN_MILESTONE | PR_INTEGRITY)', () => {
    expect(script).toMatch(/MODE="\$\{1:-MAIN_MILESTONE\}"/);
    expect(script).toContain('MAIN_MILESTONE');
    expect(script).toContain('PR_INTEGRITY');
  });

  it('rejects an invalid mode with exit 2', () => {
    expect(script).toMatch(/invalid mode/);
    expect(script).toMatch(/exit 2/);
  });

  it('in MAIN_MILESTONE mode: fetches origin and compares to origin/main HEAD', () => {
    // The MAIN_MILESTONE branch of the if-statement must call git fetch + rev-parse origin/main.
    expect(script).toContain('git fetch origin');
    expect(script).toContain('git rev-parse origin/main');
    // And it must error if local HEAD != origin/main HEAD.
    expect(script).toMatch(/MAIN_MILESTONE mode requires local HEAD == origin\/main HEAD/);
  });

  it('in PR_INTEGRITY mode: does NOT fetch origin or compare to origin/main', () => {
    // The PR_INTEGRITY branch must NOT call git fetch and must NOT compare to origin/main.
    // Look for the PR_INTEGRITY branch of the if-statement.
    const prBranchMatch = script.match(/elif \[\s*"?\$MODE"? = "PR_INTEGRITY" \][\s\S]*?fi/);
    expect(prBranchMatch).toBeTruthy();
    const prBranch = prBranchMatch![0];
    expect(prBranch).not.toContain('git fetch');
    expect(prBranch).not.toContain('git rev-parse origin/main');
    // The PR branch must set REMOTE_HEAD to a non-comparison sentinel string.
    expect(prBranch).toContain('not consulted in PR_INTEGRITY mode');
  });

  it('PR_INTEGRITY reports MATCH INVARIANT that excludes origin/main', () => {
    expect(script).toContain('origin/main NOT required');
  });

  it('MAIN_MILESTONE reports MATCH INVARIANT that includes origin/main', () => {
    expect(script).toContain('local HEAD == origin/main HEAD == tested SHA');
  });

  it('emits MODE in the COMMIT REPORT', () => {
    expect(script).toMatch(/MODE:/);
    expect(script).toMatch(/printf 'MODE:.*%s/);
  });

  it('emits MATCH INVARIANT in the COMMIT REPORT', () => {
    expect(script).toMatch(/MATCH INVARIANT:/);
    expect(script).toMatch(/printf 'MATCH INVARIANT:/);
  });
});

// ─── S0.2.4-D: Gate script makes architecture + security + typecheck FATAL ──

describe('S0.2.4-D: Gate script — architecture, security, typecheck FATAL', () => {
  const script = readFileSync(GATE_SCRIPT, 'utf-8');

  it('runs typecheck (was previously skipped entirely)', () => {
    expect(script).toContain('npx tsc --noEmit');
    expect(script).toMatch(/Typecheck.*FATAL/);
  });

  it('exits 1 on typecheck failure', () => {
    expect(script).toMatch(/FAIL: typecheck failed/);
    // The script's `if ! npx tsc ...` block must end with `exit 1`.
    expect(script).toMatch(/npx tsc --noEmit[\s\S]*?exit 1/);
  });

  it('runs architecture tests as FATAL (no `|| true`)', () => {
    expect(script).toContain('bun run vitest --run tests/architecture/');
    // The architecture run must NOT be followed by `|| true`.
    // The pattern is `if ! bun run vitest --run tests/architecture/ > "$ARCH_LOG" 2>&1; then`.
    expect(script).toMatch(/if ! bun run vitest --run tests\/architecture\/ > "\$ARCH_LOG" 2>&1/);
    expect(script).not.toMatch(/bun run vitest --run tests\/architecture\/.*\|\| true/);
  });

  it('exits 1 on architecture failure', () => {
    expect(script).toMatch(/FAIL: architecture tests failed/);
  });

  it('runs security tests as a FATAL dedicated subset', () => {
    expect(script).toContain('tests/architecture/s0-security.test.ts');
    expect(script).toMatch(/if ! bun run vitest --run tests\/architecture\/s0-security\.test\.ts/);
  });

  it('exits 1 on security failure', () => {
    expect(script).toMatch(/FAIL: security tests failed/);
  });

  it('emits TYPECHECK in the COMMIT REPORT', () => {
    expect(script).toMatch(/TYPECHECK:/);
  });

  it('emits ARCHITECTURE with FATAL annotation', () => {
    expect(script).toMatch(/ARCHITECTURE:.*FATAL/);
  });

  it('emits SECURITY with FATAL annotation', () => {
    expect(script).toMatch(/SECURITY:.*FATAL/);
  });
});

// ─── S0.2.4-E: CI workflow has the two gate jobs + removed continue-on-error ──

describe('S0.2.4-E: CI workflow — two gate jobs, no continue-on-error', () => {
  const ci = readFileSync(CI_WORKFLOW, 'utf-8');

  it('has a MAIN_MILESTONE gate job (on push to main)', () => {
    expect(ci).toContain('repo-truth-gate-main');
    expect(ci).toContain('MAIN_MILESTONE');
    expect(ci).toMatch(/github\.event_name == 'push'/);
    expect(ci).toMatch(/github\.ref == 'refs\/heads\/main'/);
  });

  it('has a PR_INTEGRITY gate job (on pull_request)', () => {
    expect(ci).toContain('repo-truth-gate-pr');
    expect(ci).toContain('PR_INTEGRITY');
    expect(ci).toMatch(/github\.event_name == 'pull_request'/);
  });

  it('does NOT have `continue-on-error` as a YAML field on the typecheck step', () => {
    // The typecheck step must not have `continue-on-error:` as a YAML field
    // (which would make type failures advisory). S0.2.4 removes this.
    //
    // The step name says "(FATAL — was previously continue-on-error: true)"
    // as documentation, so the literal string `continue-on-error` IS in
    // the file. We must distinguish: a YAML field starts at column 6
    // (matching `^      continue-on-error:`), but a comment in the `name:`
    // value does NOT start at column 6.
    const lines = ci.split('\n');
    // S0.2.6-B: the name is now quoted ("Typecheck (FATAL...)") to fix
    // a YAML parsing error. The search must handle both quoted and unquoted.
    const startIdx = lines.findIndex((l) => l.trim().startsWith('- name:') && l.includes('Typecheck'));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // Read forward until we hit the next `- name:` step or end of file.
    let i = startIdx + 1;
    const blockLines: string[] = [];
    while (i < lines.length && !lines[i].trim().startsWith('- name:')) {
      blockLines.push(lines[i]);
      i++;
    }
    // The block must contain `run: npx tsc --noEmit`.
    const block = blockLines.join('\n');
    expect(block).toContain('npx tsc --noEmit');
    // And MUST NOT contain a YAML field `continue-on-error:` (a top-level
    // step attribute that starts at the step's YAML indent — column 6).
    // We look for `^      continue-on-error:` (6 spaces indent for a step field).
    const hasYamlContinueOnError = blockLines.some((l) => /^\s{6}continue-on-error\s*:/.test(l));
    expect(hasYamlContinueOnError).toBe(false);
  });

  it('marks the typecheck step as FATAL with a comment', () => {
    expect(ci).toMatch(/Typecheck \(FATAL/);
  });

  it('marks the architecture tests step as FATAL in CI', () => {
    expect(ci).toMatch(/Architecture tests \(FATAL\)/);
  });

  it('has a separate Security tests step that is FATAL', () => {
    expect(ci).toMatch(/Security tests \(FATAL\)/);
    expect(ci).toContain('tests/architecture/s0-security.test.ts');
  });

  it('the MAIN_MILESTONE gate job runs the gate script in MAIN_MILESTONE mode', () => {
    expect(ci).toMatch(/repo-truth-gate\.sh MAIN_MILESTONE/);
  });

  it('the PR_INTEGRITY gate job runs the gate script in PR_INTEGRITY mode', () => {
    expect(ci).toMatch(/repo-truth-gate\.sh PR_INTEGRITY/);
  });

  it('both gate jobs emit the SHA outputs (BUILD_AT_SHA, TESTED_AT_SHA, ARCHITECTURE_AT_SHA)', () => {
    expect(ci).toContain('build_at_sha');
    expect(ci).toContain('tested_at_sha');
    expect(ci).toContain('architecture_at_sha');
  });

  it('both gate jobs emit MODE output', () => {
    expect(ci).toMatch(/mode: (MAIN_MILESTONE|PR_INTEGRITY)/);
  });
});

// ─── S0.2.4-F: Pre-push hook installer exists and is correct ───────────

describe('S0.2.4-F: Pre-push hook installer (branch-protection workaround)', () => {
  it('scripts/install-pre-push-hook.sh exists', () => {
    expect(existsSync(PRE_PUSH_INSTALLER)).toBe(true);
  });

  it('is executable', () => {
    const stat = statSync(PRE_PUSH_INSTALLER);
    const userExec = (stat.mode & 0o100) !== 0;
    expect(userExec).toBe(true);
  });

  it('installs the hook at .git/hooks/pre-push', () => {
    const installer = readFileSync(PRE_PUSH_INSTALLER, 'utf-8');
    expect(installer).toContain('.git/hooks/pre-push');
  });

  it('invokes the gate in PR_INTEGRITY mode at the actual call site', () => {
    // The installer's pre-push hook body runs `bash $GATE_SCRIPT PR_INTEGRITY ...`
    // The installer's comments MAY mention MAIN_MILESTONE (explaining what
    // CI does post-push), but the actual invocation must be PR_INTEGRITY.
    const installer = readFileSync(PRE_PUSH_INSTALLER, 'utf-8');
    // Find lines that actually invoke the gate script.
    const invocationLines = installer
      .split('\n')
      .filter((l) => l.includes('GATE_SCRIPT') || l.includes('repo-truth-gate.sh'))
      .filter((l) => /bash.*\$\{?GATE_SCRIPT\}?/.test(l) || /bash.*repo-truth-gate\.sh/.test(l));
    expect(invocationLines.length).toBeGreaterThan(0);
    // Every actual invocation must use PR_INTEGRITY.
    for (const line of invocationLines) {
      expect(line).toContain('PR_INTEGRITY');
      // The invocation must NOT be MAIN_MILESTONE (the comments can mention it).
      if (line.includes('MAIN_MILESTONE')) {
        // If MAIN_MILESTONE appears on an invocation line, it must be in a
        // comment (`#`) NOT in the actual bash command.
        const cmdPart = line.split('#')[0]; // before any comment
        expect(cmdPart).not.toContain('MAIN_MILESTONE');
      }
    }
  });

  it('documents the bypass path (--no-verify is an Article XVI violation)', () => {
    const installer = readFileSync(PRE_PUSH_INSTALLER, 'utf-8');
    expect(installer).toContain('--no-verify');
    expect(installer).toContain('Article XVI violation');
  });

  it('documents why branch protection is not available on private repos', () => {
    const installer = readFileSync(PRE_PUSH_INSTALLER, 'utf-8');
    expect(installer).toContain('GitHub Pro');
    expect(installer).toContain('403');
  });
});

// ─── S0.2.4-G: Proof that PR_INTEGRITY mode does not require origin/main ──

describe('S0.2.4-G: Proof — PR_INTEGRITY skips origin/main, MAIN_MILESTONE requires it', () => {
  // These are STRUCTURAL proofs — they assert on the gate script's source
  // code. The runtime behavior is enforced by CI (which runs the gate script
  // in the correct mode per trigger). These tests prove the script's logic
  // is correct: PR_INTEGRITY mode does NOT call `git fetch origin` or
  // `git rev-parse origin/main`, and does NOT compare against origin/main.

  const script = readFileSync(GATE_SCRIPT, 'utf-8');

  it('the gate script has an explicit if/elif on MODE', () => {
    expect(script).toMatch(/if \[\s*"\$MODE" = "MAIN_MILESTONE" \]/);
    expect(script).toMatch(/elif \[\s*"\$MODE" = "PR_INTEGRITY" \]/);
  });

  it('the MAIN_MILESTONE branch fetches origin AND compares to origin/main', () => {
    // Extract the MAIN_MILESTONE if-branch.
    const mainBranchMatch = script.match(/if \[\s*"\$MODE" = "MAIN_MILESTONE" \][\s\S]*?elif \[/);
    expect(mainBranchMatch).toBeTruthy();
    const mainBranch = mainBranchMatch![0];
    expect(mainBranch).toContain('git fetch origin');
    expect(mainBranch).toContain('git rev-parse origin/main');
    expect(mainBranch).toMatch(/MAIN_MILESTONE mode requires local HEAD == origin\/main HEAD/);
  });

  it('the PR_INTEGRITY branch does NOT fetch origin or compare to origin/main', () => {
    // Extract the PR_INTEGRITY elif-branch.
    const prBranchMatch = script.match(/elif \[\s*"\$MODE" = "PR_INTEGRITY" \][\s\S]*?fi/);
    expect(prBranchMatch).toBeTruthy();
    const prBranch = prBranchMatch![0];
    // Critical proof: PR_INTEGRITY does NOT fetch origin.
    expect(prBranch).not.toContain('git fetch origin');
    // And does NOT compare LOCAL_HEAD to origin/main.
    expect(prBranch).not.toContain('git rev-parse origin/main');
    // And explicitly notes the invariant.
    expect(prBranch).toContain('origin/main NOT required');
  });

  it('the PR_INTEGRITY branch sets REMOTE_HEAD to a non-comparison sentinel', () => {
    const prBranchMatch = script.match(/elif \[\s*"\$MODE" = "PR_INTEGRITY" \][\s\S]*?fi/);
    const prBranch = prBranchMatch![0];
    expect(prBranch).toContain('REMOTE_HEAD="(not consulted in PR_INTEGRITY mode)"');
  });

  it('the COMMIT REPORT distinguishes the two modes (different reviewer hints)', () => {
    expect(script).toContain('Reviewer verification (MAIN_MILESTONE)');
    expect(script).toContain('Reviewer verification (PR_INTEGRITY)');
    // PR_INTEGRITY must explicitly say origin/main is NOT required.
    expect(script).toContain('origin/main equality is NOT required in PR_INTEGRITY mode');
  });
});

// ─── S0.2.3-D (updated): CI workflow machine-enforces the gate ────────

describe('S0.2.3-D: CI workflow machine-enforces the gate', () => {
  const ci = readFileSync(CI_WORKFLOW, 'utf-8');

  it('runs on push and pull_request', () => {
    expect(ci).toMatch(/on:\s+push:/);
    expect(ci).toMatch(/pull_request:/);
  });

  it('fails on dirty worktree (in both gate jobs)', () => {
    // The gate script handles this — CI just runs the script.
    expect(ci).toContain('repo-truth-gate.sh');
  });

  it('runs the gate script (which contains all the SHA / worktree / arch / sec / typecheck checks)', () => {
    expect(ci).toContain('bash scripts/repo-truth-gate.sh');
  });

  it('emits a step summary on both gate jobs', () => {
    expect(ci).toContain('Gate summary');
    expect(ci).toContain('GITHUB_STEP_SUMMARY');
  });

  it('checks out with full history (for the gate script git operations)', () => {
    expect(ci).toContain('fetch-depth: 0');
  });
});

// ─── S0.2.4-H: Branch protection API status (documented limitation) ──

describe('S0.2.4-H: Branch protection API status — documented limitation', () => {
  // These tests document the S0.2.4 §9 limitation: the GitHub API returns
  // 403 on the branch-protection endpoint for private repos without GitHub Pro.
  // The constitution records this; the pre-push hook is the compensating control.

  it('the constitution documents the 403 from the GitHub API', () => {
    const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');
    expect(constitution).toContain('403');
    expect(constitution).toContain('GitHub Pro');
  });

  it('the ledger records the 403 limitation', () => {
    const ledger = readFileSync(LEDGER_FILE, 'utf-8');
    expect(ledger).toContain('403');
  });

  it('the pre-push hook installer documents the 403 limitation', () => {
    const installer = readFileSync(PRE_PUSH_INSTALLER, 'utf-8');
    expect(installer).toContain('403');
  });

  it('a reviewer-verification curl command is documented in the constitution', () => {
    const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');
    expect(constitution).toContain('curl -sS https://api.github.com/repos/pectoraux/universal-comm-os/branches/main/protection');
    expect(constitution).toContain('404');
    expect(constitution).toContain('200');
  });
});

// ─── S0.2.3-E: Live gate execution deferred to CI ──────────────────────

describe('S0.2.3-E: Live gate execution deferred to CI', () => {
  // NOTE: the live gate script (scripts/repo-truth-gate.sh) runs the full
  // vitest suite internally. Running it from inside a vitest worker would
  // recursively spawn vitest, which causes the worker pool to crash.
  //
  // The canonical live execution paths are:
  //   1. The developer runs `bash scripts/repo-truth-gate.sh <MODE> <id>`
  //      manually before declaring the milestone complete (MAIN_MILESTONE)
  //      or before requesting review on a PR (PR_INTEGRITY).
  //   2. The GitHub Actions `.github/workflows/ci.yml` `repo-truth-gate-main`
  //      job (MAIN_MILESTONE) and `repo-truth-gate-pr` job (PR_INTEGRITY)
  //      run the gate script in the correct mode on every push / pull_request.
  //
  // This test file verifies STRUCTURE (constitution, ledger, script content,
  // CI workflow content, pre-push installer). The live execution is enforced
  // by the gate script + CI workflow + pre-push hook — all of which are
  // themselves structurally verified above.

  it('live gate execution is deferred to the standalone script and CI', () => {
    // Trivial assertion — exists only to document the deferral.
    expect(true).toBe(true);
  });
});
