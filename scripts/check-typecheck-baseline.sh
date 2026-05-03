#!/usr/bin/env bash
# check-typecheck-baseline.sh — Pre-commit hook: block type error regression
#
# Runs tsc --noEmit in packages/playwright-mcp, counts errors, compares
# against typecheck-baseline.json. Blocks commit on regression, auto-updates
# baseline on improvement, passes silently on equal count.
#
# Event: pre-commit (via playwright-mcp/.pre-commit-config.yaml)
# Prerequisites: node 22 (fnm-managed), tsc (npx)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/playwright-mcp"
BASELINE="$PKG_DIR/typecheck-baseline.json"

# Early exit — no baseline committed yet
if [[ ! -f "$BASELINE" ]]; then
    echo "typecheck-ratchet: no baseline found, skipping"
    exit 0
fi

# Run tsc and capture error count
tsc_output="$(cd "$PKG_DIR" && npx tsc --noEmit 2>&1 || true)"
current_count="$(echo "$tsc_output" | grep -c '^tests/\|^cli-dev' || echo 0)"

# Read baseline
baseline_count="$(node -e "console.log(require('$BASELINE').errorCount)")"

if [[ "$current_count" -gt "$baseline_count" ]]; then
    echo "REGRESSION: type errors increased: $baseline_count → $current_count"
    echo ""
    echo "$tsc_output" | grep '^tests/\|^cli-dev' | tail -20
    echo ""
    echo "Type error regression detected. Fix the new type errors before committing."
    exit 1
elif [[ "$current_count" -lt "$baseline_count" ]]; then
    echo "IMPROVED: type errors decreased: $baseline_count → $current_count"
    node -e "
        const b = { errorCount: $current_count, updatedAt: new Date().toISOString().slice(0, 10) };
        require('fs').writeFileSync('$BASELINE', JSON.stringify(b, null, 2) + '\n');
    "
    git -C "$REPO_ROOT" add "packages/playwright-mcp/typecheck-baseline.json"
    echo "Baseline auto-updated and staged."
fi

# Equal count = silent pass
