#!/bin/sh
# Refresh the vendored agent.cloud code from a checkout of summationai/agent-cloud, and record its commit.
# Usage: conformance/vendor/sync.sh ~/agent-cloud   (the conformance suite must then pass for every stack)
set -eu
src="${1:?path to an agent-cloud checkout}"
here="$(cd "$(dirname "$0")" && pwd)"
cp "$src/packages/cli/src/checks.ts" "$src/packages/cli/src/migrations.ts" "$src/packages/cli/src/config.ts" "$here/agc/"
cp "$src/packages/runner/src/build.ts" "$here/agc/runner-build.ts"
cp "$src/packages/control/src/github.ts" "$here/agc/github.ts"
git -C "$src" rev-parse HEAD > "$here/agc/COMMIT"
echo "vendored agent-cloud $(cat "$here/agc/COMMIT")"
