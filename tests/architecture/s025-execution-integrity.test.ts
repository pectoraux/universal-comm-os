/**
 * S0.2.5 — Execution Integrity Evidence (Article XVII / ARCH-052) acceptance tests.
 *
 * These tests prove the execution evidence governance layer exists and is
 * structurally sound:
 *
 * A. Constitution Article XVII exists with the canonical format spec.
 * B. Architecture ledger ARCH-052 entry exists.
 * C. Manifest format tests — verify the schema requirements.
 * D. Generator script tests — script exists, executable, correct behavior.
 * E. Verifier script tests — script exists, executable, correct behavior.
 * F. Gate integration tests — the repo-truth-gate invokes the generator
 *    and emits the EXECUTION EVIDENCE block in the COMMIT REPORT.
 * G. CI workflow tests — the execution-evidence job exists, generates,
 *    verifies, uploads artifact.
 * H. .gitignore tests — the manifest paths are gitignored (so committing
 *    the manifest doesn't advance HEAD and invalidate the strict-equality
 *    check).
 *
 * These tests do NOT execute the scripts (which would re-run the test
 * suite recursively); they verify the SCRIPTS' STRUCTURE.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const CONSTITUTION_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_CONSTITUTION.md');
const LEDGER_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_LEDGER.md');
const GENERATOR_SCRIPT = join(PROJECT_ROOT, 'scripts', 'generate-execution-evidence.sh');
const VERIFIER_SCRIPT = join(PROJECT_ROOT, 'scripts', 'verify-execution-evidence.sh');
const GATE_SCRIPT = join(PROJECT_ROOT, 'scripts', 'repo-truth-gate.sh');
const CI_WORKFLOW = join(PROJECT_ROOT, '.github', 'workflows', 'ci.yml');
const GITIGNORE = join(PROJECT_ROOT, '.gitignore');
const VERIFICATION_DIR = join(PROJECT_ROOT, 'docs', 'verification');
const VERIFICATION_README = join(VERIFICATION_DIR, 'README.md');
const HISTORY_DIR = join(VERIFICATION_DIR, 'history');
const HISTORY_README = join(HISTORY_DIR, 'README.md');

// ─── A. Constitution Article XVII ──────────────────────────────────────

describe('S0.2.5-A: Constitution Article XVII — Execution Evidence Integrity', () => {
  const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');

  it('Article XVII exists', () => {
    expect(constitution).toContain('Article XVII');
  });

  it('requires not only repository truth but execution evidence', () => {
    expect(constitution).toContain('not only repository truth');
    expect(constitution).toContain('execution evidence');
  });

  it('defines the required principle: commit / environment / commands / success / correspondence', () => {
    expect(constitution).toContain('What commit was tested');
    expect(constitution).toContain('What environment tested it');
    expect(constitution).toContain('What commands were executed');
    expect(constitution).toContain('Whether they succeeded');
    expect(constitution).toContain('Whether the evidence corresponds to the repository state');
  });

  it('codifies the manifest format (ARCH-052)', () => {
    expect(constitution).toContain('milestone');
    expect(constitution).toContain('commit_sha');
    expect(constitution).toContain('repository');
    expect(constitution).toContain('branch');
    expect(constitution).toContain('timestamp');
    expect(constitution).toContain('environment');
    expect(constitution).toContain('os');
    expect(constitution).toContain('node');
    expect(constitution).toContain('package_manager');
    expect(constitution).toContain('runtime');
    expect(constitution).toContain('commands');
    expect(constitution).toContain('exit_code');
    expect(constitution).toContain('duration_ms');
    expect(constitution).toContain('results');
    expect(constitution).toContain('typecheck');
  });

  it('documents generation rules (refuses on dirty worktree, re-executes commands)', () => {
    expect(constitution).toContain('Generation rules');
    expect(constitution).toContain('dirty');
    // The constitution uses "Re-execute" (capitalized at start of sentence).
    // The test is case-insensitive on this word.
    expect(constitution.toLowerCase()).toContain('re-execute');
  });

  it('documents verification rules (SHA matches HEAD, all exit_codes 0, timestamp within 30 days)', () => {
    expect(constitution).toContain('Verification rules');
    expect(constitution).toContain('commit_sha');
    expect(constitution).toContain('30 days');
  });

  it('documents invalidation conditions', () => {
    expect(constitution).toContain('Invalidation conditions');
    expect(constitution).toContain('INVALID');
  });

  it('extends the Article XVI COMMIT REPORT with EXECUTION EVIDENCE block', () => {
    expect(constitution).toContain('EXECUTION EVIDENCE');
    expect(constitution).toContain('PATH');
    expect(constitution).toContain('SHA');
    expect(constitution).toContain('STATUS');
    expect(constitution).toContain('VALID | INVALID');
  });

  it('declares that completion without VALID evidence is INVALID', () => {
    expect(constitution).toContain('automatically INVALID per Article XVII');
  });

  it('documents the CI enforcement path (execution-evidence job, 30-day artifact)', () => {
    expect(constitution).toContain('execution-evidence');
    expect(constitution).toContain('30-day');
  });

  it('records the S0.2.5 motivation (closing the gap Article XVI left)', () => {
    expect(constitution).toContain('S0.2.5');
    expect(constitution).toContain('Article XVI proved');
    expect(constitution).toContain('did not prove that the test was actually executed');
  });
});

// ─── B. Architecture ledger ARCH-052 ──────────────────────────────────

describe('S0.2.5-B: Architecture ledger ARCH-052', () => {
  const ledger = readFileSync(LEDGER_FILE, 'utf-8');

  it('ARCH-052 entry exists', () => {
    expect(ledger).toContain('ARCH-052');
  });

  it('references Article XVII', () => {
    expect(ledger).toContain('Article XVII');
  });

  it('describes the manifest path docs/verification/latest-execution.json', () => {
    expect(ledger).toContain('docs/verification/latest-execution.json');
  });

  it('describes the generator script scripts/generate-execution-evidence.sh', () => {
    expect(ledger).toContain('scripts/generate-execution-evidence.sh');
  });

  it('describes the verifier script scripts/verify-execution-evidence.sh', () => {
    expect(ledger).toContain('scripts/verify-execution-evidence.sh');
  });

  it('records that the generator RE-EXECUTES (does not trust prior gate run)', () => {
    expect(ledger).toContain('RE-EXECUTES');
  });

  it('records the CI job name execution-evidence with 30-day retention', () => {
    expect(ledger).toContain('execution-evidence');
    expect(ledger).toContain('30-day');
  });

  it('records that the COMMIT REPORT is extended with EXECUTION EVIDENCE block', () => {
    expect(ledger).toContain('EXECUTION EVIDENCE');
  });

  it('records that completion without VALID evidence is INVALID', () => {
    expect(ledger).toMatch(/automatically INVALID.*Article XVII/);
  });
});

// ─── C. Manifest format tests ─────────────────────────────────────────

describe('S0.2.5-C: Manifest format — required fields documented in constitution', () => {
  const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');

  it('documents milestone field', () => {
    expect(constitution).toContain('"milestone"');
  });

  it('documents commit_sha field (full 40-character SHA-1)', () => {
    expect(constitution).toContain('"commit_sha"');
    expect(constitution).toContain('40-character SHA-1');
  });

  it('documents repository field (URL with credentials stripped)', () => {
    expect(constitution).toContain('"repository"');
    expect(constitution).toContain('credentials stripped');
  });

  it('documents timestamp field (ISO-8601 UTC with timezone offset)', () => {
    expect(constitution).toContain('"timestamp"');
    expect(constitution).toContain('ISO-8601');
  });

  it('documents environment.os field', () => {
    expect(constitution).toContain('"os"');
  });

  it('documents environment.node field', () => {
    expect(constitution).toContain('"node"');
  });

  it('documents environment.package_manager field', () => {
    expect(constitution).toContain('"package_manager"');
  });

  it('documents environment.runtime field', () => {
    expect(constitution).toContain('"runtime"');
  });

  it('documents commands[] with command/exit_code/duration_ms', () => {
    expect(constitution).toContain('"command"');
    expect(constitution).toContain('"exit_code"');
    expect(constitution).toContain('"duration_ms"');
  });

  it('documents results.tests/architecture/security/typecheck', () => {
    expect(constitution).toContain('"tests"');
    expect(constitution).toContain('"architecture"');
    expect(constitution).toContain('"security"');
    expect(constitution).toContain('"typecheck"');
  });
});

// ─── D. Generator script tests ────────────────────────────────────────

describe('S0.2.5-D: Generator script exists and is correct', () => {
  it('scripts/generate-execution-evidence.sh exists', () => {
    expect(existsSync(GENERATOR_SCRIPT)).toBe(true);
  });

  it('is executable', () => {
    expect(existsSync(GENERATOR_SCRIPT)).toBe(true);
    const stat = statSync(GENERATOR_SCRIPT);
    const userExec = (stat.mode & 0o100) !== 0;
    expect(userExec).toBe(true);
  });

  it('has set -euo pipefail (fail-fast on any error)', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('set -euo pipefail');
  });

  it('takes MILESTONE as the first positional argument', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toMatch(/MILESTONE="\$\{1:-UNKNOWN\}"/);
  });

  it('refuses to generate if worktree is dirty', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('worktree is dirty');
    // The check uses `git status --porcelain` (the same canonical pattern as the gate).
    expect(script).toMatch(/\[ -n "\$\(git status --porcelain\)" \]/);
  });

  it('captures commit_sha from git rev-parse HEAD', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('COMMIT_SHA=$(git rev-parse HEAD)');
  });

  it('captures branch from git rev-parse --abbrev-ref HEAD', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('git rev-parse --abbrev-ref HEAD');
  });

  it('strips credentials from the repository URL', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    // The sed pattern strips `https://user:token@` from the origin URL.
    expect(script).toMatch(/sed -E 's\|https:\/\/\[\^@\]\*@\|https:\/\/\|'/);
  });

  it('captures ISO-8601 timestamp via date -u', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain("date -u");
    // ISO-8601 format with +00:00 timezone offset.
    expect(script).toContain('+"%Y-%m-%dT%H:%M:%S+00:00"');
  });

  it('re-executes the required validation commands (does not trust prior gate run)', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('npx tsc --noEmit');
    expect(script).toContain('bun run vitest --run');
    expect(script).toContain('tests/architecture/');
    expect(script).toContain('tests/architecture/s0-security.test.ts');
  });

  it('writes the manifest to docs/verification/latest-execution.json', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('docs/verification/latest-execution.json');
  });

  it('archives a copy to docs/verification/history/', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('docs/verification/history/');
  });

  it('computes overall_status as VALID only if every exit_code is 0', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('OVERALL_STATUS="VALID"');
    expect(script).toContain('OVERALL_STATUS="INVALID"');
  });

  it('verifies HEAD did not move during evidence generation', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('HEAD moved during evidence generation');
  });

  it('emits a clear STATUS: VALID / STATUS: INVALID final line', () => {
    const script = readFileSync(GENERATOR_SCRIPT, 'utf-8');
    expect(script).toContain('STATUS: VALID');
    expect(script).toContain('STATUS: INVALID');
  });
});

// ─── E. Verifier script tests ────────────────────────────────────────

describe('S0.2.5-E: Verifier script exists and is correct', () => {
  it('scripts/verify-execution-evidence.sh exists', () => {
    expect(existsSync(VERIFIER_SCRIPT)).toBe(true);
  });

  it('is executable', () => {
    expect(existsSync(VERIFIER_SCRIPT)).toBe(true);
    const stat = statSync(VERIFIER_SCRIPT);
    const userExec = (stat.mode & 0o100) !== 0;
    expect(userExec).toBe(true);
  });

  it('has set -euo pipefail', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('set -euo pipefail');
  });

  it('checks that the manifest file exists', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('execution evidence manifest not found');
  });

  it('validates JSON parseability', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('not valid JSON');
  });

  it('verifies commit_sha == git rev-parse HEAD', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('manifest commit_sha');
    expect(script).toContain('HEAD');
    expect(script).toContain('Regenerate');
  });

  it('verifies repository matches current origin URL', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('manifest repository');
    expect(script).toContain('origin URL');
  });

  it('verifies every commands[].exit_code is 0', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('non-zero exit codes');
  });

  it('verifies timestamp is ISO-8601 and within 30 days', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('TS_PARSE_FAIL');
    expect(script).toContain('TS_STALE');
    expect(script).toContain('30');
  });

  it('verifies results.typecheck == "PASS"', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain("results.typecheck");
    expect(script).toContain("PASS");
  });

  it('verifies results.tests/architecture/security contain "passed" + non-zero count + either explicit "0 failed" OR matching pass/total counts', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('passed');
    // The verifier accepts BOTH explicit "0 failed" AND implicit zero failures
    // (vitest output on success: "Tests <N> passed (<N>)" — no "failed" line).
    expect(script).toContain('0 failed');
    expect(script).toContain('passed (');
    // The passed count must be non-zero.
    expect(script).toContain('0 tests passed');
  });

  it('exits 0 on VALID, 1 on INVALID with specific error message', () => {
    const script = readFileSync(VERIFIER_SCRIPT, 'utf-8');
    expect(script).toContain('STATUS: VALID');
    expect(script).toMatch(/exit 1/g);
    expect(script).toMatch(/exit 0/g);
  });
});

// ─── F. Gate integration tests ──────────────────────────────────────

describe('S0.2.5-F: Repo Truth Gate integrates execution evidence', () => {
  const gate = readFileSync(GATE_SCRIPT, 'utf-8');

  it('invokes scripts/generate-execution-evidence.sh', () => {
    expect(gate).toContain('scripts/generate-execution-evidence.sh');
  });

  it('invokes scripts/verify-execution-evidence.sh after generation', () => {
    expect(gate).toContain('scripts/verify-execution-evidence.sh');
  });

  it('emits EXECUTION EVIDENCE block with PATH / SHA / STATUS fields in COMMIT REPORT', () => {
    expect(gate).toContain('EXECUTION EVIDENCE');
    expect(gate).toContain('EVIDENCE_PATH');
    expect(gate).toContain('EVIDENCE_SHA');
    expect(gate).toContain('EVIDENCE_STATUS');
  });

  it('references Article XVII / ARCH-052 in the COMMIT REPORT', () => {
    expect(gate).toContain('Article XVII');
    expect(gate).toContain('ARCH-052');
  });

  it('exits 1 if execution evidence is not VALID (Article XVII requirement)', () => {
    expect(gate).toContain('execution evidence is');
    expect(gate).toContain('Article XVII requires VALID');
  });

  it('extends the reviewer-verification hints with manifest inspection commands', () => {
    expect(gate).toContain('cat docs/verification/latest-execution.json');
    expect(gate).toContain('bash scripts/verify-execution-evidence.sh');
  });
});

// ─── G. CI workflow tests ────────────────────────────────────────────

describe('S0.2.5-G: CI workflow has execution-evidence job', () => {
  const ci = readFileSync(CI_WORKFLOW, 'utf-8');

  it('has an execution-evidence job', () => {
    expect(ci).toContain('execution-evidence');
  });

  it('the job depends on the existing gate jobs (does NOT weaken them)', () => {
    // The needs: list must include ci (the main build job) and at least
    // one of the repo-truth-gate jobs.
    expect(ci).toContain('needs: [ci');
    // The job runs AFTER the gates — it adds a new required check, not
    // a replacement.
    expect(ci).toMatch(/needs:.*repo-truth-gate/);
  });

  it('the job checks out the repo', () => {
    expect(ci).toContain('actions/checkout@v4');
  });

  it('the job installs bun + dependencies', () => {
    expect(ci).toContain('oven-sh/setup-bun@v1');
    expect(ci).toContain('bun install');
  });

  it('the job generates Prisma Client', () => {
    expect(ci).toContain('npx prisma generate');
  });

  it('the job runs scripts/generate-execution-evidence.sh', () => {
    expect(ci).toContain('bash scripts/generate-execution-evidence.sh');
  });

  it('the job runs scripts/verify-execution-evidence.sh', () => {
    expect(ci).toContain('bash scripts/verify-execution-evidence.sh');
  });

  it('the job uploads the manifest as a GitHub Actions artifact with 30-day retention', () => {
    expect(ci).toContain('actions/upload-artifact@v4');
    expect(ci).toContain('execution-evidence-${{ github.sha }}');
    expect(ci).toContain('retention-days: 30');
    expect(ci).toContain('docs/verification/');
  });

  it('the job emits a step summary', () => {
    expect(ci).toContain('Evidence summary');
    expect(ci).toContain('GITHUB_STEP_SUMMARY');
  });

  it('the job does NOT remove the existing gate jobs (S0.2.3 / S0.2.4 gates retained)', () => {
    // The repo-truth-gate-main and repo-truth-gate-pr jobs must still exist.
    expect(ci).toContain('repo-truth-gate-main');
    expect(ci).toContain('repo-truth-gate-pr');
    expect(ci).toContain('repo-truth-gate-pr:');
    expect(ci).toContain('repo-truth-gate-main:');
  });
});

// ─── H. .gitignore tests ────────────────────────────────────────────

describe('S0.2.5-H: .gitignore — manifest paths are gitignored', () => {
  const gitignore = readFileSync(GITIGNORE, 'utf-8');

  it('gitignores docs/verification/latest-execution.json', () => {
    expect(gitignore).toContain('/docs/verification/latest-execution.json');
  });

  it('gitignores docs/verification/history/*.json', () => {
    expect(gitignore).toContain('/docs/verification/history/*.json');
  });

  it('documents why the manifest is gitignored (committing it would advance HEAD)', () => {
    expect(gitignore).toContain('GENERATED artifact');
    expect(gitignore).toContain('advance HEAD');
    expect(gitignore).toContain('invalidate');
  });

  it('documents the docs/verification/ directory is tracked via README.md', () => {
    expect(gitignore).toContain('README.md');
  });
});

// ─── I. Directory structure tests ────────────────────────────────────

describe('S0.2.5-I: docs/verification/ directory structure', () => {
  it('docs/verification/ exists', () => {
    expect(existsSync(VERIFICATION_DIR)).toBe(true);
  });

  it('docs/verification/README.md exists (tracks the directory in git)', () => {
    expect(existsSync(VERIFICATION_README)).toBe(true);
  });

  it('docs/verification/history/ exists', () => {
    expect(existsSync(HISTORY_DIR)).toBe(true);
  });

  it('docs/verification/history/README.md exists (tracks the history directory)', () => {
    expect(existsSync(HISTORY_README)).toBe(true);
  });

  it('docs/verification/README.md documents the manifest format', () => {
    const readme = readFileSync(VERIFICATION_README, 'utf-8');
    expect(readme).toContain('milestone');
    expect(readme).toContain('commit_sha');
    expect(readme).toContain('commands');
    expect(readme).toContain('results');
  });

  it('docs/verification/README.md explains why the manifest is gitignored', () => {
    const readme = readFileSync(VERIFICATION_README, 'utf-8');
    expect(readme).toContain('Gitignored');
    expect(readme).toContain('advance HEAD');
  });

  it('docs/verification/README.md documents the generate + verify commands', () => {
    const readme = readFileSync(VERIFICATION_README, 'utf-8');
    expect(readme).toContain('bash scripts/generate-execution-evidence.sh');
    expect(readme).toContain('bash scripts/verify-execution-evidence.sh');
  });
});

// ─── J. Manifest invalidation tests (static) ─────────────────────────

describe('S0.2.5-J: Verifier handles invalidation conditions', () => {
  const verifier = readFileSync(VERIFIER_SCRIPT, 'utf-8');

  it('rejects when manifest is missing', () => {
    expect(verifier).toContain('not found');
  });

  it('rejects when commit_sha does not match HEAD', () => {
    expect(verifier).toContain('manifest commit_sha');
    expect(verifier).toContain('HEAD');
    expect(verifier).toContain('repository advanced past');
  });

  it('rejects when repository URL does not match', () => {
    expect(verifier).toContain('remote changed');
  });

  it('rejects when any command exit_code is non-zero', () => {
    expect(verifier).toContain('non-zero exit codes');
  });

  it('rejects when timestamp is stale (> 30 days)', () => {
    expect(verifier).toContain('TS_STALE');
    expect(verifier).toContain('days old');
  });

  it('rejects when results.typecheck is not PASS', () => {
    expect(verifier).toContain("expected 'PASS'");
  });

  it('rejects when results.tests does not contain "passed" with non-zero count', () => {
    expect(verifier).toContain('does not contain');
    expect(verifier).toContain("'<N> passed'");
  });

  it('rejects when results.tests records non-zero failures', () => {
    expect(verifier).toContain('failed tests');
  });
});
