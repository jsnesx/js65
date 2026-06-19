/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Implementation of the shared host core (see hermes_core.h).

#include "hermes_core.h"

#include "hermes/VM/static_h.h"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>

namespace js65core {

// symbols supplied by the compiled js65 unit + ConsoleBindings
extern "C" SHUnit *sh_export_js65(void);

typedef struct SHConsoleContext SHConsoleContext;
extern "C" SHConsoleContext *
init_console_bindings(SHRuntime *shr, int scriptArgc, const char *const *scriptArgv);
extern "C" void free_console_context(SHConsoleContext *consoleContext);
extern "C" bool run_event_loop(SHRuntime *shr, SHConsoleContext *consoleContext);

namespace {

// A jsi::MutableBuffer backed by a std::vector<uint8_t>.
// The idea for this class came from hermes internal code somewhere, but it lets us
// create a buffer for 
class VectorMutableBuffer : public jsi::MutableBuffer {
 public:
  explicit VectorMutableBuffer(std::vector<uint8_t> data) : data_(std::move(data)) {}
  size_t size() const override { return data_.size(); }
  uint8_t *data() override { return data_.data(); }

 private:
  std::vector<uint8_t> data_;
};

// Holds the bytes returned by the filesystem Js65ReadFn until the read binding copies
// them into a JS value. Overwritten each call, which is safe because the binding copies
// immediately and synchronously before the next read.
thread_local std::vector<uint8_t> g_fsScratch;

} // namespace

[[noreturn]] void throwError(jsi::Runtime &rt, std::string_view msg) {
  auto str = jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t *>(msg.data()), msg.size());
  auto ctor = rt.global().getPropertyAsFunction(rt, "Error");
  auto err = ctor.callAsConstructor(rt, std::move(str)).asObject(rt);
  throw jsi::JSError(rt, std::move(err));
}

jsi::Value makeUint8Array(jsi::Runtime &rt, std::vector<uint8_t> data) {
  auto buf = std::make_shared<VectorMutableBuffer>(std::move(data));
  jsi::ArrayBuffer ab{rt, std::move(buf)};
  auto ctor = rt.global().getPropertyAsFunction(rt, "Uint8Array");
  return ctor.callAsConstructor(rt, std::move(ab));
}

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

void setFn(jsi::Runtime &rt, const char *name, unsigned argc, jsi::HostFunctionType fn) {
  rt.global().setProperty(
      rt,
      name,
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, name), argc, std::move(fn)));
}

bool readFileInto(const std::filesystem::path &path, std::vector<uint8_t> &out) {
  std::error_code ec;
  auto size = std::filesystem::file_size(path, ec);
  if (ec)
    return false;
  std::ifstream in(path, std::ios::binary);
  if (!in)
    return false;
  std::vector<uint8_t> data(static_cast<size_t>(size));
  if (size > 0 && !in.read(reinterpret_cast<char *>(data.data()), static_cast<std::streamsize>(size)))
    return false;
  out = std::move(data);
  return true;
}

void writeFileBytes(jsi::Runtime &rt, const std::filesystem::path &path, const std::vector<uint8_t> &data) {
  std::ofstream out(path, std::ios::binary);
  if (!out)
    throwError(rt, "Could not open file for writing: " + path.string());
  out.write(reinterpret_cast<const char *>(data.data()), static_cast<std::streamsize>(data.size()));
  if (!out)
    throwError(rt, "Short write on file: " + path.string());
}

std::filesystem::path resolvePath(std::string_view base, std::string_view file) {
  std::filesystem::path filePath(file);
  if (file.empty() || base.empty() || base == ".")
    return filePath;
  // path::operator/ replaces the base when filePath is absolute (POSIX root or Windows
  // drive/UNC) and otherwise joins under it, matching hermes.ts resolvePath.
  return std::filesystem::path(base) / filePath;
}

int32_t fsReadText(void *, const char *basePath, const char *relPath,
                   const uint8_t **outData, int32_t *outLen) {
  if (!readFileInto(resolvePath(basePath ? basePath : "", relPath ? relPath : ""), g_fsScratch))
    return -1;
  *outData = g_fsScratch.data();
  *outLen = static_cast<int32_t>(g_fsScratch.size());
  return 0;
}

int32_t fsReadBinary(void *ctx, const char *basePath, const char *relPath,
                     const uint8_t **outData, int32_t *outLen) {
  // Text and binary reads are byte-identical on the filesystem side.
  return fsReadText(ctx, basePath, relPath, outData, outLen);
}

void installCommonBindings(jsi::Runtime &rt, HostContext &ctx) {
  setFn(rt, "__js65_args", 0,
      [&ctx](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        auto arr = jsi::Array(rt, ctx.args.size());
        for (size_t i = 0; i < ctx.args.size(); ++i)
          arr.setValueAtIndex(rt, i, jsi::String::createFromUtf8(rt, ctx.args[i]));
        return arr;
      });

  setFn(rt, "__js65_cbReadText", 2,
      [&ctx](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 2 || !args[0].isString() || !args[1].isString())
          throwError(rt, "__js65_cbReadText: (basePath, relPath) expected");
        if (!ctx.readText) throwError(rt, "__js65_cbReadText: no readText callback");
        std::string base = args[0].getString(rt).utf8(rt);
        std::string rel = args[1].getString(rt).utf8(rt);
        const uint8_t *data = nullptr;
        int32_t len = 0;
        if (ctx.readText(ctx.readCtx, base.c_str(), rel.c_str(), &data, &len) != 0)
          throwError(rt, "Could not read file: " + rel);
        return jsi::String::createFromUtf8(rt, data ? data : (const uint8_t *)"", len > 0 ? (size_t)len : 0);
      });

  setFn(rt, "__js65_cbReadBinary", 2,
      [&ctx](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 2 || !args[0].isString() || !args[1].isString())
          throwError(rt, "__js65_cbReadBinary: (basePath, relPath) expected");
        if (!ctx.readBinary) throwError(rt, "__js65_cbReadBinary: no readBinary callback");
        std::string base = args[0].getString(rt).utf8(rt);
        std::string rel = args[1].getString(rt).utf8(rt);
        const uint8_t *data = nullptr;
        int32_t len = 0;
        if (ctx.readBinary(ctx.readCtx, base.c_str(), rel.c_str(), &data, &len) != 0)
          throwError(rt, "Could not read file: " + rel);
        return makeUint8Array(rt, std::vector<uint8_t>(data, data + (len > 0 ? len : 0)));
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

bool runJs65Core(HostContext &ctx,
             const std::function<void(jsi::Runtime &rt, HostContext &ctx)> &installEntryBindings) {
  // Hand _sh_init only a program name so it never tries to parse user/CLI flags as
  // Hermes VM options.
  char prog[] = "js65";
  char *argv[] = {prog};
  SHRuntime *shr = _sh_init(1, argv);
  SHConsoleContext *consoleContext = init_console_bindings(shr, 0, nullptr);
  jsi::Runtime &rt = *_sh_get_hermes_runtime(shr);
  installCommonBindings(rt, ctx);
  installEntryBindings(rt, ctx);
  bool success = _sh_initialize_units(shr, 1, sh_export_js65) &&
      run_event_loop(shr, consoleContext);
  free_console_context(consoleContext);
  _sh_done(shr);
  return success;
}

} // namespace js65core
