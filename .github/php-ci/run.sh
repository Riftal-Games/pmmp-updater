#!/usr/bin/env bash
# Runs a command in the image built from .github/php-ci/Dockerfile, in the package
# directory named first. The runner workspace persists between runs, so the container
# runs as the runner's own user and leaves nothing root-owned behind. Composer's
# downloads are kept under the runner user's ~/.cache, outside the workspace, so a run
# does not spend GitHub's unauthenticated API allowance on packages it already has.
set -euo pipefail

package="$(realpath "$1")"
shift
image="$(cat "$RUNNER_TEMP/php-ci.iid")"
cache="$HOME/.cache/pmmp-updater/composer"
mkdir -p "$cache"

exec docker run --rm -m 3g --cpus 2 \
  --user "$(id -u):$(id -g)" \
  -e COMPOSER_HOME=/tmp/composer \
  -e COMPOSER_CACHE_DIR=/composer-cache \
  -v "$cache:/composer-cache" \
  -v "$package:/pkg" \
  -w /pkg \
  "$image" "$@"
