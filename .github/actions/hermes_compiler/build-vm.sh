#!/usr/bin/env bash
# Configure and build the Static Hermes VM libraries into a given build dir.
#
#   build-vm.sh <build-dir> [extra flags appended to CMAKE_{C,CXX}_FLAGS_RELEASE]
set -euo pipefail

BUILD_DIR="$1"
shift
EXTRA_FLAGS="$*"

# clang targeting *-windows-msvc runs in MS-compat mode and does not define
# __GNUC__, tripping Hermes' -Werror=undef in vendored llvh headers. -Wno-undef
# must follow that flag, so set it per-config.
CONFIG_FLAGS="-O3 -DNDEBUG"
if [ "$RUNNER_OS" = "Windows" ]; then
  CONFIG_FLAGS="$CONFIG_FLAGS -Wno-undef"
fi
if [ -n "$EXTRA_FLAGS" ]; then
  CONFIG_FLAGS="$CONFIG_FLAGS $EXTRA_FLAGS"
fi

# We use GNU clang across all platforms (even windows) because in my testing,
# clang produces much much faster shermes code. I'm guessing its because
# computed goto in clang makes for much faster interpreters, so its just always
# gonna be better than msvc builds.
cmake -S hermes -B "$BUILD_DIR" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DHERMES_ALLOW_BOOST_CONTEXT=1 \
  -DHERMES_ENABLE_DEBUGGER=OFF \
  -DHERMES_BUILD_SHARED_JSI=OFF \
  -DHERMES_ENABLE_TEST_SUITE=OFF \
  -DHERMES_ENABLE_NAPI=OFF \
  -DCMAKE_C_COMPILER=clang \
  -DCMAKE_CXX_COMPILER=clang++ \
  "-DCMAKE_C_FLAGS_RELEASE=$CONFIG_FLAGS" \
  "-DCMAKE_CXX_FLAGS_RELEASE=$CONFIG_FLAGS"

cmake --build "$BUILD_DIR" --parallel --target shermes hermesvm_a shermes_console_a jsi
