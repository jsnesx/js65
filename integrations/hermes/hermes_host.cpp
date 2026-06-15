/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// C++ host for the Static Hermes js65 frontend (integrations/hermes.ts).
//
// Static Hermes exposes no fs / argv / stdin / stdout / process to JS, so this
// host installs the __js65_* functions that integrations/hermes.ts relies on,
// using the JSI runtime reachable from the SHRuntime (the same mechanism the
// shermes ConsoleBindings use for print/console). The js65 frontend is compiled
// separately with `-exported-unit js65`, which emits the unit creator
// `sh_export_js65` but no main(); this file supplies the main() that wires
// everything together and runs the unit.

#define _CRT_SECURE_NO_WARNINGS 1

#include "hermes/VM/static_h.h"
#include "hermes/hermes.h"
#include "jsi/jsi.h"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

using namespace facebook;

// --- symbols supplied by the compiled js65 unit + ConsoleBindings ---------
extern "C" SHUnit *sh_export_js65(void);

typedef struct SHConsoleContext SHConsoleContext;
extern "C" SHConsoleContext *
init_console_bindings(SHRuntime *shr, int scriptArgc, const char *const *scriptArgv);
extern "C" void free_console_context(SHConsoleContext *consoleContext);
extern "C" bool run_event_loop(SHRuntime *shr, SHConsoleContext *consoleContext);

namespace {

// The user CLI args (everything after argv[0]); returned to JS by __js65_args.
std::vector<std::string> g_args;

/// A jsi::MutableBuffer backed by a std::vector<uint8_t>.
class VectorMutableBuffer : public jsi::MutableBuffer {
 public:
  explicit VectorMutableBuffer(std::vector<uint8_t> data) : data_(std::move(data)) {}
  size_t size() const override { return data_.size(); }
  uint8_t *data() override { return data_.data(); }

 private:
  std::vector<uint8_t> data_;
};

[[noreturn]] void throwError(jsi::Runtime &rt, const std::string &msg) {
  auto ctor = rt.global().getPropertyAsFunction(rt, "Error");
  auto err = ctor.callAsConstructor(rt, jsi::String::createFromUtf8(rt, msg)).asObject(rt);
  throw jsi::JSError(rt, std::move(err));
}

/// Build a JS Uint8Array that owns a copy of \p data.
jsi::Value makeUint8Array(jsi::Runtime &rt, std::vector<uint8_t> data) {
  auto buf = std::make_shared<VectorMutableBuffer>(std::move(data));
  jsi::ArrayBuffer ab{rt, std::move(buf)};
  auto ctor = rt.global().getPropertyAsFunction(rt, "Uint8Array");
  return ctor.callAsConstructor(rt, std::move(ab));
}

/// Copy the bytes out of a JS Uint8Array / TypedArray / ArrayBuffer argument.
std::vector<uint8_t> getBytes(jsi::Runtime &rt, const jsi::Value &v) {
  if (!v.isObject())
    throwError(rt, "expected a Uint8Array argument");
  jsi::Object obj = v.getObject(rt);
  if (obj.isArrayBuffer(rt)) {
    jsi::ArrayBuffer ab = obj.getArrayBuffer(rt);
    return std::vector<uint8_t>(ab.data(rt), ab.data(rt) + ab.size(rt));
  }
  auto bufProp = obj.getProperty(rt, "buffer");
  if (!bufProp.isObject() || !bufProp.asObject(rt).isArrayBuffer(rt))
    throwError(rt, "expected a Uint8Array argument");
  jsi::ArrayBuffer ab = bufProp.asObject(rt).getArrayBuffer(rt);
  auto off = obj.getProperty(rt, "byteOffset");
  auto len = obj.getProperty(rt, "byteLength");
  size_t offset = off.isNumber() ? (size_t)off.getNumber() : 0;
  size_t length = len.isNumber() ? (size_t)len.getNumber() : ab.size(rt);
  return std::vector<uint8_t>(ab.data(rt) + offset, ab.data(rt) + offset + length);
}

std::vector<uint8_t> readFileBytes(jsi::Runtime &rt, const std::string &path) {
  FILE *f = std::fopen(path.c_str(), "rb");
  if (!f)
    throwError(rt, "Could not read file: " + path);
  std::fseek(f, 0, SEEK_END);
  long len = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  std::vector<uint8_t> data(len > 0 ? (size_t)len : 0);
  if (len > 0 && std::fread(data.data(), 1, (size_t)len, f) != (size_t)len) {
    std::fclose(f);
    throwError(rt, "Short read on file: " + path);
  }
  std::fclose(f);
  return data;
}

void writeFileBytes(jsi::Runtime &rt, const std::string &path, const std::vector<uint8_t> &data) {
  FILE *f = std::fopen(path.c_str(), "wb");
  if (!f)
    throwError(rt, "Could not open file for writing: " + path);
  if (!data.empty() && std::fwrite(data.data(), 1, data.size(), f) != data.size()) {
    std::fclose(f);
    throwError(rt, "Short write on file: " + path);
  }
  std::fclose(f);
}

std::vector<uint8_t> readAllStdin() {
  std::vector<uint8_t> out;
  uint8_t chunk[65536];
  size_t n;
  while ((n = std::fread(chunk, 1, sizeof(chunk), stdin)) > 0)
    out.insert(out.end(), chunk, chunk + n);
  return out;
}

void setFn(
    jsi::Runtime &rt,
    const char *name,
    unsigned argc,
    jsi::HostFunctionType fn) {
  rt.global().setProperty(
      rt,
      name,
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, name), argc, std::move(fn)));
}

void installJs65Bindings(SHRuntime *shr) {
  jsi::Runtime &rt = *_sh_get_hermes_runtime(shr);

  setFn(rt, "__js65_args", 0,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        auto arr = jsi::Array(rt, g_args.size());
        for (size_t i = 0; i < g_args.size(); ++i)
          arr.setValueAtIndex(rt, i, jsi::String::createFromUtf8(rt, g_args[i]));
        return arr;
      });

  setFn(rt, "__js65_readText", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) throwError(rt, "__js65_readText: path expected");
        auto data = readFileBytes(rt, args[0].getString(rt).utf8(rt));
        return jsi::String::createFromUtf8(rt, data.data(), data.size());
      });

  setFn(rt, "__js65_readBytes", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) throwError(rt, "__js65_readBytes: path expected");
        return makeUint8Array(rt, readFileBytes(rt, args[0].getString(rt).utf8(rt)));
      });

  setFn(rt, "__js65_writeText", 2,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 2 || !args[0].isString() || !args[1].isString())
          throwError(rt, "__js65_writeText: (path, string) expected");
        std::string s = args[1].getString(rt).utf8(rt);
        writeFileBytes(rt, args[0].getString(rt).utf8(rt),
                       std::vector<uint8_t>(s.begin(), s.end()));
        return jsi::Value::undefined();
      });

  setFn(rt, "__js65_writeBytes", 2,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 2 || !args[0].isString()) throwError(rt, "__js65_writeBytes: (path, bytes) expected");
        writeFileBytes(rt, args[0].getString(rt).utf8(rt), getBytes(rt, args[1]));
        return jsi::Value::undefined();
      });

  setFn(rt, "__js65_stdinText", 0,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        auto data = readAllStdin();
        return jsi::String::createFromUtf8(rt, data.data(), data.size());
      });

  setFn(rt, "__js65_stdinBytes", 0,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        return makeUint8Array(rt, readAllStdin());
      });

  setFn(rt, "__js65_stdoutText", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) throwError(rt, "__js65_stdoutText: string expected");
        std::string s = args[0].getString(rt).utf8(rt);
        std::fwrite(s.data(), 1, s.size(), stdout);
        std::fflush(stdout);
        return jsi::Value::undefined();
      });

  setFn(rt, "__js65_stdoutBytes", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1) throwError(rt, "__js65_stdoutBytes: bytes expected");
        auto data = getBytes(rt, args[0]);
        std::fwrite(data.data(), 1, data.size(), stdout);
        std::fflush(stdout);
        return jsi::Value::undefined();
      });

  setFn(rt, "__js65_listFiles", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) throwError(rt, "__js65_listFiles: dir expected");
        std::string dir = args[0].getString(rt).utf8(rt);
        std::vector<std::string> files;
        std::error_code ec;
        for (auto it = std::filesystem::recursive_directory_iterator(dir, ec);
             !ec && it != std::filesystem::recursive_directory_iterator(); it.increment(ec)) {
          if (it->is_regular_file(ec)) files.push_back(it->path().string());
        }
        auto arr = jsi::Array(rt, files.size());
        for (size_t i = 0; i < files.size(); ++i)
          arr.setValueAtIndex(rt, i, jsi::String::createFromUtf8(rt, files[i]));
        return arr;
      });

  setFn(rt, "__js65_exit", 1,
      [](jsi::Runtime &, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        std::fflush(stdout);
        std::exit(count >= 1 && args[0].isNumber() ? (int)args[0].getNumber() : 0);
      });
}

} // namespace

int main(int argc, char **argv) {
#if defined(_WIN32)
  // ROM/IPS output and module envelopes are binary; keep them byte-exact.
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif

  for (int i = 1; i < argc; ++i)
    g_args.emplace_back(argv[i]);

  // Hand _sh_init only the program name so it never tries to parse the user's
  // assembler flags (e.g. -o) as Hermes VM options.
  SHRuntime *shr = _sh_init(1, argv);
  SHConsoleContext *consoleContext = init_console_bindings(shr, 0, nullptr);
  installJs65Bindings(shr);
  bool success = _sh_initialize_units(shr, 1, sh_export_js65) &&
      run_event_loop(shr, consoleContext);
  free_console_context(consoleContext);
  _sh_done(shr);
  return success ? 0 : 1;
}
