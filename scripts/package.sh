#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
revision="${1:?usage: scripts/package.sh REVISION OUTPUT_DIR}"
output_dir="${2:?usage: scripts/package.sh REVISION OUTPUT_DIR}"
[[ "$revision" =~ ^[0-9a-f]{7,40}$ ]]
test -f "$root_dir/web/dist/index.html"
mkdir -p -- "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT
release="$staging/caudal-$revision"
mkdir -p -- "$release/web" "$release/downloads"
cd -- "$root_dir"

CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X main.version=$revision" -o "$release/caudal" ./cmd/caudal
for architecture in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$architecture" go build -trimpath \
    -ldflags '-s -w' -o "$release/downloads/caudal-agent-linux-$architecture" ./cmd/caudal-agent
done
cp -R -- web/dist/. "$release/web/"
printf '%s\n' "$revision" > "$release/REVISION"
(
  cd -- "$release"
  find caudal downloads web REVISION -type f -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 -- "$file"
  done > SHA256SUMS
)
COPYFILE_DISABLE=1 tar -czf "$output_dir/caudal-$revision-linux-amd64.tar.gz" -C "$staging" "caudal-$revision"
(
  cd -- "$output_dir"
  shasum -a 256 -- "caudal-$revision-linux-amd64.tar.gz" > "caudal-$revision-linux-amd64.tar.gz.sha256"
)
