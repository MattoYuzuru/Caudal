#!/usr/bin/env bash
# Install a checksum-verified artifact from a trusted build.
set -euo pipefail

source_release="$(realpath -- "${1:?usage: sudo ops/install-release.sh RELEASE_DIRECTORY}")"
release_revision="$(cat -- "$source_release/REVISION")"
[[ "$release_revision" =~ ^[0-9a-f]{7,40}$ ]]
[[ "$EUID" == 0 ]]
app_root=/opt/caudal
release_path="$app_root/releases/$release_revision"
health_url=http://127.0.0.1:18260/healthz

verify() {
  (
    cd -- "$1"
    sha256sum --strict --check --quiet SHA256SUMS
    test -x caudal
    test -s web/index.html
    test -x downloads/caudal-agent-linux-amd64
    test -x downloads/caudal-agent-linux-arm64
  )
}

verify "$source_release"
install -d -m 0755 "$app_root/releases"
exec 9>"$app_root/install.lock"
flock -n 9
previous="$(readlink -- "$app_root/current" || true)"
if [[ ! -d "$release_path" ]]; then
  copied="$(mktemp -d "$app_root/releases/.staged.XXXXXXXX")"
  trap 'rm -rf -- "$copied"' EXIT
  chmod 0755 "$copied"
  cp -R -- "$source_release/." "$copied/"
  chmod -R u=rwX,go=rX "$copied"
  verify "$copied"
  mv -T -- "$copied" "$release_path"
fi
cmp -- "$source_release/SHA256SUMS" "$release_path/SHA256SUMS"
verify "$release_path"

switch_to() {
  ln -sfnT -- "$1" "$app_root/.next"
  mv -Tf -- "$app_root/.next" "$app_root/current"
}
healthy() {
  for _attempt in {1..15}; do
    if curl -fsS --max-time 2 "$health_url" | grep -Fq -- "\"version\":\"$1\""; then
      return
    fi
    sleep 1
  done
  return 1
}

switch_to "$release_path"
if systemctl restart caudal.service && healthy "$release_revision"; then
  printf 'Caudal release %s is healthy\n' "$release_revision"
  exit 0
fi

if [[ -n "$previous" && "$previous" != "$release_path" ]]; then
  switch_to "$previous"
  systemctl restart caudal.service
  healthy "${previous##*/}"
  printf 'Restored Caudal release %s\n' "${previous##*/}" >&2
else
  systemctl stop caudal.service
  if [[ -z "$previous" ]]; then
    rm -- "$app_root/current"
  fi
fi
exit 1
