// SPDX-License-Identifier: MPL-2.0

// Implementation of the shared host core (see hermes_core.h).

#include "hermes_core.h"

#include "hermes/VM/static_h.h"

#include "third_party/miniz/miniz.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <optional>

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

// Holds the bytes returned by the filesystem Js65ResolveFn until the resolve binding copies
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
  // Create the parent directories so writing to `build/out.nes` works on a fresh tree.
  // An existing directory is not an error; a real failure surfaces from the open below.
  if (path.has_parent_path() && !path.parent_path().empty()) {
    std::error_code mkec;
    std::filesystem::create_directories(path.parent_path(), mkec);
  }
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

// --- gzip -----------------------------------------------------------------
// miniz has no gzip framing, only raw deflate (tdefl) and zlib streams, so the 10-byte
// gzip header and the 8-byte CRC32+ISIZE trailer (RFC 1952) are hand-rolled here around
// miniz's raw-deflate calls. mtime is always 0 and FNAME is never written, matching the
// other three codec implementations (bun/node/pako all drop the filename field too).

std::vector<uint8_t> gzipCompress(jsi::Runtime &rt, const std::vector<uint8_t> &data) {
  size_t compLen = 0;
  mz_uint flags = tdefl_create_comp_flags_from_zip_params(1, -15, MZ_DEFAULT_STRATEGY);
  void *comp = tdefl_compress_mem_to_heap(data.data(), data.size(), &compLen, flags);
  if (!comp) throwError(rt, "gzip: compression failed");

  std::vector<uint8_t> out;
  out.reserve(10 + compLen + 8);
  // Header: magic (1f 8b), CM=8 (deflate), FLG=0, MTIME=0 (4 bytes), XFL=0, OS=ff (unknown).
  static const uint8_t header[10] = {0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff};
  out.insert(out.end(), header, header + 10);
  out.insert(out.end(), static_cast<uint8_t *>(comp), static_cast<uint8_t *>(comp) + compLen);
  mz_free(comp);

  mz_ulong crc = mz_crc32(MZ_CRC32_INIT, data.data(), data.size());
  uint32_t isize = static_cast<uint32_t>(data.size());
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<uint8_t>((crc >> (8 * i)) & 0xff));
  for (int i = 0; i < 4; ++i) out.push_back(static_cast<uint8_t>((isize >> (8 * i)) & 0xff));
  return out;
}

std::vector<uint8_t> gzipDecompress(jsi::Runtime &rt, const std::vector<uint8_t> &data) {
  if (data.size() < 18 || data[0] != 0x1f || data[1] != 0x8b || data[2] != 0x08)
    throwError(rt, "gzip: bad magic");

  uint8_t flg = data[3];
  size_t pos = 10;
  if (flg & 0x04) { // FEXTRA
    if (pos + 2 > data.size()) throwError(rt, "gzip: truncated FEXTRA");
    uint16_t xlen = static_cast<uint16_t>(data[pos] | (data[pos + 1] << 8));
    pos += 2 + xlen;
  }
  if (flg & 0x08) { // FNAME
    while (pos < data.size() && data[pos] != 0) ++pos;
    ++pos;
  }
  if (flg & 0x10) { // FCOMMENT
    while (pos < data.size() && data[pos] != 0) ++pos;
    ++pos;
  }
  if (flg & 0x02) pos += 2; // FHCRC
  if (pos + 8 > data.size()) throwError(rt, "gzip: truncated header");

  size_t payloadLen = data.size() - pos - 8;
  size_t decompLen = 0;
  void *decomp = tinfl_decompress_mem_to_heap(data.data() + pos, payloadLen, &decompLen, 0);
  if (!decomp) throwError(rt, "gzip: decompression failed");

  std::vector<uint8_t> out(static_cast<uint8_t *>(decomp), static_cast<uint8_t *>(decomp) + decompLen);
  mz_free(decomp);

  const uint8_t *trailer = data.data() + data.size() - 8;
  uint32_t expectedCrc = 0, expectedSize = 0;
  for (int i = 0; i < 4; ++i) expectedCrc |= static_cast<uint32_t>(trailer[i]) << (8 * i);
  for (int i = 0; i < 4; ++i) expectedSize |= static_cast<uint32_t>(trailer[4 + i]) << (8 * i);

  mz_ulong actualCrc = mz_crc32(MZ_CRC32_INIT, out.data(), out.size());
  if (actualCrc != expectedCrc) throwError(rt, "gzip: CRC32 mismatch");
  if (out.size() != expectedSize) throwError(rt, "gzip: size mismatch");
  return out;
}

int32_t fsResolveText(void *, const char *const *basePaths, int32_t basePathCount,
                      const char *relPath, int32_t *outBase,
                      const uint8_t **outData, int32_t *outLen) {
  const char *rel = relPath ? relPath : "";
  for (int32_t i = 0; i < basePathCount; ++i) {
    const char *base = basePaths[i] ? basePaths[i] : "";
    if (!readFileInto(resolvePath(base, rel), g_fsScratch)) continue;
    *outBase = i;
    *outData = g_fsScratch.data();
    *outLen = static_cast<int32_t>(g_fsScratch.size());
    return 0;
  }
  return -1;
}

int32_t fsResolveBinary(void *ctx, const char *const *basePaths, int32_t basePathCount,
                        const char *relPath, int32_t *outBase,
                        const uint8_t **outData, int32_t *outLen) {
  // Text and binary reads are byte-identical on the filesystem side.
  return fsResolveText(ctx, basePaths, basePathCount, relPath, outBase, outData, outLen);
}

namespace {

// A file the host located: which base had it, plus its bytes.
struct HostHit {
  int32_t base;
  std::vector<uint8_t> data;
};

// Shared body of the two resolve bindings: marshal (bases[], relPath) out to the host
// callback and copy back whatever it points at. Returns nullopt when no base had the
// file, which the JS side turns into `undefined` and the assembler into a diagnostic.
std::optional<HostHit> resolveViaHost(jsi::Runtime &rt, HostContext &ctx, Js65ResolveFn fn,
                                      const char *name, const jsi::Value *args, size_t count) {
  if (count < 2 || !args[0].isObject() || !args[0].getObject(rt).isArray(rt) || !args[1].isString())
    throwError(rt, std::string(name) + ": (bases[], relPath) expected");
  if (!fn) throwError(rt, std::string(name) + ": no resolve callback");

  // Hold the strings alive for the duration of the call; the pointer array views them.
  jsi::Array bases = args[0].getObject(rt).getArray(rt);
  size_t n = bases.size(rt);
  std::vector<std::string> owned;
  owned.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    jsi::Value v = bases.getValueAtIndex(rt, i);
    owned.push_back(v.isString() ? v.getString(rt).utf8(rt) : std::string());
  }
  std::vector<const char *> ptrs;
  ptrs.reserve(n);
  for (const std::string &s : owned) ptrs.push_back(s.c_str());

  std::string rel = args[1].getString(rt).utf8(rt);
  int32_t which = 0;
  const uint8_t *data = nullptr;
  int32_t len = 0;
  if (fn(ctx.readCtx, ptrs.data(), static_cast<int32_t>(n), rel.c_str(), &which, &data, &len) != 0)
    return std::nullopt;
  if (which < 0 || static_cast<size_t>(which) >= n)
    throwError(rt, std::string(name) + ": host returned an out-of-range base index");
  // Copy before returning: the host buffer is only valid until the next callback.
  return HostHit{which, std::vector<uint8_t>(data ? data : (const uint8_t *)"",
                                             (data ? data : (const uint8_t *)"") + (len > 0 ? len : 0))};
}

// Build the `{base, content}` object the batched FileCallbacks contract returns.
jsi::Value makeResolved(jsi::Runtime &rt, int32_t baseIndex, jsi::Value content) {
  // The JS side passed the base list in, so hand back the index it chose; hermes.ts
  // maps it to the string.
  jsi::Object out(rt);
  out.setProperty(rt, "baseIndex", jsi::Value(baseIndex));
  out.setProperty(rt, "content", std::move(content));
  return out;
}

} // namespace

void installCommonBindings(jsi::Runtime &rt, HostContext &ctx) {
  setFn(rt, "__js65_args", 0,
      [&ctx](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        auto arr = jsi::Array(rt, ctx.args.size());
        for (size_t i = 0; i < ctx.args.size(); ++i)
          arr.setValueAtIndex(rt, i, jsi::String::createFromUtf8(rt, ctx.args[i]));
        return arr;
      });

  setFn(rt, "__js65_cbResolveText", 2,
      [&ctx](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        auto hit = resolveViaHost(rt, ctx, ctx.resolveText, "__js65_cbResolveText", args, count);
        if (!hit) return jsi::Value::undefined();
        return makeResolved(rt, hit->base,
            jsi::String::createFromUtf8(rt, hit->data.data(), hit->data.size()));
      });

  setFn(rt, "__js65_cbResolveBinary", 2,
      [&ctx](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        auto hit = resolveViaHost(rt, ctx, ctx.resolveBinary, "__js65_cbResolveBinary", args, count);
        if (!hit) return jsi::Value::undefined();
        return makeResolved(rt, hit->base, makeUint8Array(rt, std::move(hit->data)));
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

  // One directory, not recursive: bare entry names, directories marked with a trailing
  // '/'. Recursion lives in the TS `walkFiles` so every host agrees on path shape.
  // Throws when the directory cannot be read, so callers can distinguish a missing
  // directory from an empty one.
  setFn(rt, "__js65_listDir", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1 || !args[0].isString()) throwError(rt, "__js65_listDir: dir expected");
        std::string dir = args[0].getString(rt).utf8(rt);
        std::error_code ec;
        std::filesystem::directory_iterator it(dir, ec);
        if (ec) throwError(rt, "Could not list directory: " + dir);
        std::vector<std::string> entries;
        for (; it != std::filesystem::directory_iterator(); it.increment(ec)) {
          if (ec) throwError(rt, "Could not list directory: " + dir);
          std::error_code dec;
          std::string name = it->path().filename().string();
          entries.push_back(it->is_directory(dec) && !dec ? name + "/" : name);
        }
        auto arr = jsi::Array(rt, entries.size());
        for (size_t i = 0; i < entries.size(); ++i)
          arr.setValueAtIndex(rt, i, jsi::String::createFromUtf8(rt, entries[i]));
        return arr;
      });

  setFn(rt, "__js65_exit", 1,
      [](jsi::Runtime &, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        std::fflush(stdout);
        std::exit(count >= 1 && args[0].isNumber() ? (int)args[0].getNumber() : 0);
      });

  setFn(rt, "__js65_gzip", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1) throwError(rt, "__js65_gzip: bytes expected");
        return makeUint8Array(rt, gzipCompress(rt, getBytes(rt, args[0])));
      });

  setFn(rt, "__js65_gunzip", 1,
      [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 1) throwError(rt, "__js65_gunzip: bytes expected");
        return makeUint8Array(rt, gzipDecompress(rt, getBytes(rt, args[0])));
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
