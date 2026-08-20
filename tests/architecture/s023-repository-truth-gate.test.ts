/**
 * S0.2.3 — Repository Truth Gate (Article XVI / ARCH-051) acceptance tests.
 *
 * These tests prove the governance gate exists and is structurally sound.
 * They do NOT replace the gate itself (which is a runtime script + CI job);
 * they prove the gate's documentation and tooling are present and consistent
 * with the constitution.
 *
 * A milestone reported COMPLETE without satisfying Article XVI is
 * automatically INVALID. These tests make that enforceable in CI.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const CONSTITUTION_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_CONSTITUTION.md');
const LEDGER_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_LEDGER.md');
const GATE_SCRIPT = join(PROJECT_ROOT, 'scripts', 'repo-truth-gate.sh');
const CI_WORKFLOW = join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml');

describe('S0.2.3-A: Constitution Article XVI — Repository Truth Gate', () => {
  const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');

  it('Article XVI exists', () => {
    expect(constitution).toContain('Article XVI');
  });

  it('codifies the SHA equality invariant', () => {
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
    expect(constitution).toContain('Independent verification');
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

  it('records the S0.2.2 motivation', () => {
    expect(ledger).toContain('S0.2.2 governance failure');
  });
});

describe('S0.2.3-C: Gate script exists and is executable', () => {
  it('scripts/repo-truth-gate.sh exists', () => {
    expect(existsSync(GATE_SCRIPT)).toBe(true);
  });

  it('is executable (mode bits include user-exec)', () => {
    // Use fs.statSync — portable, doesn't depend on git-tracked state.
    expect(existsSync(GATE_SCRIPT)).toBe(true);
    const stat = statSync(GATE_SCRIPT);
    // Octal mode: 0o100 means user-exec bit is set.
    const userExec = (stat.mode & 0o100) !== 0;
    expect(userExec).toBe(true);
  });

  it('checks worktree cleanliness', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('git status --porcelain');
    // The script uses `if [ -n "$(git status --porcelain)" ]` to detect dirty worktree.
    expect(script).toMatch(/\[ -n "\$\(git status --porcelain\)" \]/);
  });

  it('runs the full test suite', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('bun run vitest --run');
  });

  it('fetches origin and compares local HEAD to origin/main HEAD', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('git fetch origin');
    expect(script).toContain('git rev-parse origin/main');
    expect(script).toContain('git rev-parse HEAD');
  });

  it('exits non-zero on mismatch', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    // The script has `set -euo pipefail` so any failed check exits non-zero.
    expect(script).toContain('set -euo pipefail');
    // And explicit exit 1 on each failure path.
    expect(script).toMatch(/exit 1/g);
  });

  it('emits the COMMIT REPORT', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('MILESTONE:');
    expect(script).toContain('LOCAL HEAD:');
    expect(script).toContain('GITHUB main:');
    expect(script).toContain('TESTED SHA:');
    expect(script).toContain('MATCH:');
    expect(script).toContain('WORKTREE CLEAN:');
    expect(script).toContain('FILES ADDED:');
    expect(script).toContain('FILES MODIFIED:');
  });

  it('includes reviewer-verification hints in the report', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf-8');
    expect(script).toContain('git ls-tree -r origin/main --name-only');
    expect(script).toContain('git show origin/main:<path>');
    expect(script).toContain('git rev-parse origin/main');
  });
});

describe('S0.2.3-D: CI workflow machine-enforces the gate', () => {
  const ci = readFileSync(CI_WORKFLOW, 'utf-8');

  it('has a repo-truth-gate job', () => {
    expect(ci).toContain('repo-truth-gate');
  });

  it('emits BUILD_AT_SHA, TESTED_AT_SHA, ARCHITECTURE_AT_SHA outputs', () => {
    expect(ci).toContain('BUILD_AT_SHA');
    expect(ci).toContain('TESTED_AT_SHA');
    expect(ci).toContain('ARCHITECTURE_AT_SHA');
  });

  it('runs on push and pull_request', () => {
    expect(ci).toMatch(/on:\s+push:/);
    expect(ci).toMatch(/pull_request:/);
  });

  it('fails on dirty worktree', () => {
    expect(ci).toContain('WORKTREE_CLEAN=NO');
    expect(ci).toContain('Worktree is dirty');
  });

  it('fails when local HEAD != github.sha', () => {
    expect(ci).toContain('github.sha');
    expect(ci).toContain('MATCH=NO');
  });

  it('runs the full test suite at the exact commit', () => {
    expect(ci).toContain('Running full test suite at');
    expect(ci).toContain('bun run vitest --run');
  });

  it('re-checks worktree cleanliness after tests', () => {
    expect(ci).toContain('Tests mutated tracked files');
    expect(ci).toContain('worktree dirty after tests');
  });

  it('runs the architecture subset', () => {
    expect(ci).toContain('bun run vitest --run tests/architecture/');
  });

  it('fails if HEAD moved during tests', () => {
    expect(ci).toContain('HEAD moved during tests');
  });

  it('emits the VALIDATED banner on success', () => {
    expect(ci).toContain('REPOSITORY TRUTH GATE — VALIDATED');
  });
});

describe('S0.2.3-E: Live gate execution deferred to CI', () => {
  // NOTE: the live gate script (scripts/repo-truth-gate.sh) runs the full
  // vitest suite internally. Running it from inside a vitest worker would
  // recursively spawn vitest, which causes the worker pool to crash.
  //
  // The canonical live execution paths are:
  //   1. The developer runs `bash scripts/repo-truth-gate.sh <milestone>`
  //      manually before declaring the milestone complete.
  //   2. The GitHub Actions `.github/workflows/ci.yml` `repo-truth-gate` job
  //      runs the equivalent logic on every push / pull_request.
  //
  // This test file verifies STRUCTURE (constitution, ledger, script content,
  // CI workflow content). The live execution is enforced by the gate script
  // + CI workflow — both of which are themselves structurally verified above.

  it('live gate execution is deferred to the standalone script and CI', () => {
    // Trivial assertion — exists only to document the deferral.
    expect(true).toBe(true);
  });
});
