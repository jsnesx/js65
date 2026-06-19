/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Shared host core for the Static Hermes js65 frontend. The CLI executable
// (hermes_host.cpp) and the shared library (hermes_lib.cpp) are thin entry points over
// this core. They differ only in which Js65ReadFn pair they register (filesystem vs.
// host-supplied function pointers) and in their entry-specific bindings (stdin/stdout vs.
// the request/result protocol). The JSI helpers, the read bindings and the runtime
// bootstrap live here as the single source of truth.

#ifndef JS65_HERMES_CORE_H
#define JS65_HERMES_CORE_H

#include "js65.h"

#include "hermes/hermes.h"
#include "jsi/jsi.h"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace js65core {

// This header file is only used internally, so its fine to `using namespace` here.
using namespace facebook;

// Host state shared with the JS bindings for one runJs65Core call. Lives on the entry's stack
// and outlives the runtime created inside runJs65Core.
struct HostContext {
  // Backs __js65_cbReadText / __js65_cbReadBinary.
  Js65ReadFn readText = nullptr;
  Js65ReadFn readBinary = nullptr;
  void *readCtx = nullptr;

  // Backs __js65_cancelled: host-owned flag flipped from another thread to cancel the
  // in-flight compile. Passing in null means "never cancelled".
  // I'm not a huge fan of using volatile here, but it works well enough.
  const volatile int32_t *cancelFlag = nullptr;

  // The library entry's request data (returned by __js65_request). Empty for the CLI.
  std::string request;

  // The library entry's base ROM bytes (returned by __js65_baseRom). Empty for the CLI.
  std::vector<uint8_t> baseRom;

  // Values returned by __js65_args (the CLI's argv, or {"--lib"} for the library).
  std::vector<std::string> args;
};

[[noreturn]] void throwError(jsi::Runtime &rt, std::string_view msg);
jsi::Value makeUint8Array(jsi::Runtime &rt, std::vector<uint8_t> data);
std::vector<uint8_t> getBytes(jsi::Runtime &rt, const jsi::Value &v);
void setFn(jsi::Runtime &rt, const char *name, unsigned argc, jsi::HostFunctionType fn);

// Read a whole file into out; returns false (leaving out untouched) if it cannot be read.
bool readFileInto(const std::filesystem::path &path, std::vector<uint8_t> &out);
// Write data to path; throws a JS error on failure.
void writeFileBytes(jsi::Runtime &rt, const std::filesystem::path &path, const std::vector<uint8_t> &data);
// Join an include base directory with a requested file. An absolute file replaces the
// base, matching the resolvePath in hermes.ts so the CLI and the in-process callbacks
// resolve includes to the same target.
std::filesystem::path resolvePath(std::string_view base, std::string_view file);

// Filesystem-backed Js65ReadFn implementations: read a file relative to the include base.
// The CLI registers these as its read callbacks.
int32_t fsReadText(void *ctx, const char *basePath, const char *relPath,
                   const uint8_t **outData, int32_t *outLen);
int32_t fsReadBinary(void *ctx, const char *basePath, const char *relPath,
                     const uint8_t **outData, int32_t *outLen);

// Install the bindings both entries share: __js65_args, the read callbacks
// (__js65_cbReadText / __js65_cbReadBinary), __js65_writeText / __js65_writeBytes,
// __js65_listFiles, and __js65_exit.
void installCommonBindings(jsi::Runtime &rt, HostContext &ctx);

// Init the runtime + console bindings, install the common bindings plus the entry's own
// (via installEntryBindings), run the compiled unit and the event loop, then tear down.
// Returns true on success.
bool runJs65Core(HostContext &ctx,
             const std::function<void(jsi::Runtime &rt, HostContext &ctx)> &installEntryBindings);

} // namespace js65core

#endif // JS65_HERMES_CORE_H
