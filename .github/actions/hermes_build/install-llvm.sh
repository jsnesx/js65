#!/usr/bin/env bash
# Put a full LLVM 22 toolchain (clang, lld, llvm-profdata) on PATH.
# macOS/Linux only.
# Windows runners ship clang already with a different runner. MSVC supplies the CRT,
# the Windows SDK, and link.exe that clang's *-windows-msvc target links against.
set -euo pipefail

if [ "$RUNNER_OS" = "macOS" ]; then
  # Unlink the preinstalled llvm so we can safely install our own.
  for keg in $(brew list --formula | grep -E '^llvm(@[0-9]+)?$' || true); do
    [ "$keg" = "llvm@22" ] || brew unlink "$keg"
  done
  brew install llvm@22 lld@22
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
echo "$LLVM_BIN" >> "$GITHUB_PATH"
"$LLVM_BIN/clang" --version
"$LLVM_BIN/llvm-profdata" --version
# Compile and link a real TU so a missing SDK or C++ runtime fails here,
# with a readable error, instead of thousands of lines into Hermes.
echo '#include <cstdio>
int main() { std::printf("toolchain ok\n"); return 0; }' > /tmp/probe.cpp
"$LLVM_BIN/clang++" -std=c++17 /tmp/probe.cpp -o /tmp/probe
/tmp/probe
