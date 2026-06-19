/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// CLI entry point for the Static Hermes js65 frontend (build/js65[.exe]). It is a thin
// wrapper over the shared host core (hermes_core.cpp): it registers the filesystem
// read handlers, installs the stdin/stdout bindings the CLI needs, and runs the unit.
// Everything else (JSI helpers, read/write/listFiles bindings, runtime bootstrap)
// lives in the core and is shared with the shared-library entry (hermes_lib.cpp).

#define _CRT_SECURE_NO_WARNINGS 1

#include "hermes_core.h"

#include <cstdio>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

using namespace facebook;
using js65core::HostContext;

namespace {

std::vector<uint8_t> readAllStdin() {
  std::vector<uint8_t> out;
  uint8_t chunk[65536];
  size_t n;
  while ((n = std::fread(chunk, 1, sizeof(chunk), stdin)) > 0)
    out.insert(out.end(), chunk, chunk + n);
  return out;
}

// stdin/stdout bindings are CLI-only: the library entry uses request/result instead.
void installCliBindings(jsi::Runtime &rt, HostContext &) {
  js65core::setFn(rt, "__js65_stdinText", 0,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        auto data = readAllStdin();
        return jsi::String::createFromUtf8(rt, data.data(), data.size());
      });

  js65core::setFn(rt, "__js65_stdinBytes", 0,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        return js65core::makeUint8Array(rt, readAllStdin());
      });

  js65core::setFn(rt, "__js65_stdoutText", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) js65core::throwError(rt, "__js65_stdoutText: string expected");
        std::string s = args[0].getString(rt).utf8(rt);
        std::fwrite(s.data(), 1, s.size(), stdout);
        std::fflush(stdout);
        return jsi::Value::undefined();
      });

  js65core::setFn(rt, "__js65_stdoutBytes", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1) js65core::throwError(rt, "__js65_stdoutBytes: bytes expected");
        auto data = js65core::getBytes(rt, args[0]);
        std::fwrite(data.data(), 1, data.size(), stdout);
        std::fflush(stdout);
        return jsi::Value::undefined();
      });
}

} // namespace

int main(int argc, char **argv) {
#if defined(_WIN32)
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif

  HostContext ctx;
  // The CLI reads includes straight off the filesystem relative to the include base.
  ctx.readText = &js65core::fsReadText;
  ctx.readBinary = &js65core::fsReadBinary;
  for (int i = 1; i < argc; ++i)
    ctx.args.emplace_back(argv[i]);

  bool success = js65core::runJs65Core(ctx, installCliBindings);
  return success ? 0 : 1;
}
