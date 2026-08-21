# This directory holds archived execution evidence manifests.
#
# Each milestone run produces:
#   docs/verification/latest-execution.json  (the current manifest)
#   docs/verification/history/<milestone>-<short-sha>-<timestamp>.json  (archive)
#
# The archive files are kept for forensic audit. They are NOT used by the
# verifier — only `latest-execution.json` is. Reviewers may diff historical
# manifests to see how the test results changed over time.
#
# Article XVII / ARCH-052.
