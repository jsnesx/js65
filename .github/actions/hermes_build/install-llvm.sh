#!/usr/bin/env bash
# Put a full LLVM 22 toolchain (clang, lld, llvm-profdata) on PATH.
# On Windows, MSVC (set up by an earlier step) supplies the CRT, the Windows
# SDK, and link.exe that clang's *-windows-msvc target links against.
set -euo pipefail

LLVM_VERSION=22.1.8

if [ "$RUNNER_OS" = "Windows" ]; then
  # The runner's preinstalled clang lags behind the MSVC STL, which rejects
  # clang versions older than it supports (STL1000), so bring our own.
  LLVM_DIR="$RUNNER_TEMP/llvm"
  mkdir -p "$LLVM_DIR"
  curl -fsSL "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION/clang+llvm-$LLVM_VERSION-x86_64-pc-windows-msvc.tar.xz" \
    | tar -xJ -C "$LLVM_DIR" --strip-components=1
  LLVM_BIN="$(cygpath -u "$LLVM_DIR")/bin"
  cygpath -w "$LLVM_BIN" >> "$GITHUB_PATH"
elif [ "$RUNNER_OS" = "macOS" ]; then
  # Remove existing llvm so we don't get warnings with the newly installed llvm
  for keg in $(brew list --formula | grep -E '^llvm(@[0-9]+)?$' || true); do
    [ "$keg" = "llvm@22" ] || brew uninstall --ignore-dependencies "$keg"
  done
  HOMEBREW_NO_ENV_HINTS=1 brew install --quiet llvm@22 lld@22
  LLVM_BIN="$(brew --prefix llvm@22)/bin"
  # Unlike Apple Clang, Homebrew clang does not imply an SDK, so the
  # macOS headers have to be pointed at explicitly.
  SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
  export SDKROOT
  echo "SDKROOT=$SDKROOT" >> "$GITHUB_ENV"
  echo "$(brew --prefix lld@22)/bin" >> "$GITHUB_PATH"
else
  . /etc/os-release
  curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key \
    | sudo tee /etc/apt/trusted.gpg.d/llvm.asc > /dev/null
  echo "deb http://apt.llvm.org/$VERSION_CODENAME/ llvm-toolchain-$VERSION_CODENAME-22 main" \
    | sudo tee /etc/apt/sources.list.d/llvm-22.list
  sudo apt-get update
  sudo apt-get install -y llvm-22 clang-22 lld-22 libclang-rt-22-dev
  LLVM_BIN=/usr/lib/llvm-22/bin
fi
if [ "$RUNNER_OS" != "Windows" ]; then
  echo "$LLVM_BIN" >> "$GITHUB_PATH"
fi
"$LLVM_BIN/clang" --version
"$LLVM_BIN/llvm-profdata" --version
# Compile and link a real TU so a missing SDK or C++ runtime fails here,
# with a readable error, instead of thousands of lines into Hermes.
echo '#include <cstdio>
int main() { std::printf("toolchain ok\n"); return 0; }' > "$RUNNER_TEMP/probe.cpp"
"$LLVM_BIN/clang++" -std=c++17 "$RUNNER_TEMP/probe.cpp" -o "$RUNNER_TEMP/probe.exe"
"$RUNNER_TEMP/probe.exe"
