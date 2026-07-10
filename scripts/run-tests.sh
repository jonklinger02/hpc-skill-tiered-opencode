#!/bin/bash
# Skill-level test runner. Picks up every *.test.js next to it and runs each
# under node:test. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")"

shopt -s nullglob
tests=( *.test.js )
if [ "${#tests[@]}" -eq 0 ]; then
  echo "no tests found in $(pwd)"
  exit 0
fi

fail=0
for t in "${tests[@]}"; do
  echo "── $t ──"
  if ! node --test "$t"; then
    fail=$((fail+1))
  fi
done

if [ $fail -gt 0 ]; then
  echo "FAIL: $fail test file(s) had failures"
  exit 1
fi
echo "ALL PASS"
