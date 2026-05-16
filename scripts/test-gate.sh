#!/usr/bin/env bash
set -euo pipefail

echo "=== BabyLink Test Gate ==="
echo ""

echo "--- Smoke tests (critical path) ---"
npx vitest run tests/e2e-server/smoke.test.js --reporter=verbose
echo ""
echo "=== Smoke tests passed ==="
echo ""

echo "--- Full test suite ---"
npx vitest run --reporter=verbose
echo ""
echo "=== ALL TESTS PASSED ==="
