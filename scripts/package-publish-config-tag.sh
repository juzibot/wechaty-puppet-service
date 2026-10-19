#!/usr/bin/env bash
set -e

VERSION=$(npx pkg-jq -r .version)

if [[ "$VERSION" == *-patch-c-* ]]; then
  npx pkg-jq -i '.publishConfig.tag="patch-c"'
  echo 'C-region patch: publishConfig.tag set to patch-c.'
elif npx --package @chatie/semver semver-is-prod $VERSION; then
  npx pkg-jq -i '.publishConfig.tag="latest"'
  echo "production release: publicConfig.tag set to latest."
else
  npx pkg-jq -i '.publishConfig.tag="next"'
  echo 'development release: publicConfig.tag set to next.'
fi

