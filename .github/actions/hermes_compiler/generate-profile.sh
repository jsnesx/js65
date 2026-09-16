#!/usr/bin/env bash
# Build the project against the instrumented VM, run the training workload, and
# merge the raw counters into a single profdata.
#
#   generate-profile.sh <instrumented-build-dir> <training-checkout> <out.profdata>
#
# The training arguments come from PGO_BUILD_COMMAND, split on whitespace.
set -euo pipefail

INSTRUMENTED="$(cd "$1" && pwd)"
TRAINING="$(cd "$2" && pwd)"
OUT="$3"
WORKSPACE="$PWD"

RAW_DIR="$WORKSPACE/build/pgo-raw"
rm -rf "$RAW_DIR"
mkdir -p "$RAW_DIR"

EXE=""
[ "$RUNNER_OS" = "Windows" ] && EXE=".exe"

# This runs before the caller's own dependency and ICU steps, so cover both here
# rather than depending on where the action sits in their workflow.
[ -d node_modules ] || bun install
if [ "$RUNNER_OS" = "Linux" ]; then
  # hermesvm references system ICU and the link needs the -dev .so symlinks.
  dpkg -s libicu-dev >/dev/null 2>&1 || (sudo apt-get update && sudo apt-get install -y libicu-dev)
fi

export LLVM_PROFILE_FILE="$RAW_DIR/discard/shermes-%p.profraw"

HERMES_SRC="$WORKSPACE/hermes" \
HERMES_BUILD="$INSTRUMENTED" \
HERMES_CONFIG='' \
JS65_PROFILE_FLAGS='-fprofile-generate' \
  bun run hermes-exe

export LLVM_PROFILE_FILE="$RAW_DIR/train-%p.profraw"

(cd "$TRAINING" && "$WORKSPACE/build/js65$EXE" $PGO_BUILD_COMMAND)

unset LLVM_PROFILE_FILE

CLANG_PATH="$(command -v clang)"
PROFDATA="$(dirname "$CLANG_PATH")/llvm-profdata$EXE"
if [ ! -x "$PROFDATA" ]; then
  PROFDATA="$(command -v llvm-profdata || true)"
fi
if [ -z "$PROFDATA" ]; then
  echo "could not locate llvm-profdata next to $CLANG_PATH or on PATH" >&2
  exit 1
fi

shopt -s nullglob
RAW=("$RAW_DIR"/train-*.profraw)
shopt -u nullglob
if [ ${#RAW[@]} -eq 0 ]; then
  echo "the training run produced no .profraw files; is the VM instrumented?" >&2
  exit 1
fi

"$PROFDATA" merge -output="$OUT" "${RAW[@]}"
"$PROFDATA" show "$OUT" | head -n 20

# The training build wrote an instrumented js65 and its objects into the shared
# build/ dir. Drop them so the caller's real build and tests don't pick them up.
rm -rf "$RAW_DIR"
rm -f "$WORKSPACE/build/js65$EXE" "$WORKSPACE/build"/*.o
rm -f "$WORKSPACE/build/js65.dll" "$WORKSPACE/build/libjs65.so" "$WORKSPACE/build/libjs65.dylib"
