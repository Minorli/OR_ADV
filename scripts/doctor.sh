#!/usr/bin/env bash
# Read-only local inventory. No network, installs, credentials or environment dump.
set -u
missing=0
printf 'OR ADV local environment check (read-only)\n'
for tool in git node npm python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    case "$tool" in
      python3) python3 --version ;;
      *) "$tool" --version ;;
    esac
  else
    printf 'MISSING: %s\n' "$tool"
    missing=$((missing + 1))
  fi
done
if command -v node >/dev/null 2>&1; then
  node -e 'const n=Number(process.versions.node.split(".")[0]); if(n<22){console.error("NOTICE: review maintained Node 22/24 and tool compatibility");process.exitCode=1}'
fi
if command -v tcb >/dev/null 2>&1; then
  printf 'CloudBase CLI: installed (run tcb --version separately)\n'
else
  printf 'CloudBase CLI: not installed; unnecessary for local mock work\n'
fi
printf 'No cloud login, API call, install, or system modification was performed.\n'
if [ "$missing" -ne 0 ]; then
  printf 'Missing basic tools: %s; see docs/09-linux.md\n' "$missing"
  exit 1
fi
