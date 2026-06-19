/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Shared-library entry point for the Static Hermes js65 frontend. Implements the C ABI
// in js65.h over the shared host core (hermes_core.cpp): it forwards the caller's read
// function pointers into the assembler and translates the compile result into the typed
// Js65Result tree the ABI exposes. The frontend pushes the result through the
// __js65_result* host functions (see integrations/hermes/hermes.ts) so the structure is
// built field-by-field here rather than parsed from a serialized blob.

#include "js65.h"
#include "hermes_core.h"

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

using namespace facebook;
using js65core::HostContext;

// Pin the ABI layout (pointers first, then int32s) so consumers in other languages can
// hard-code offsets.
static_assert(offsetof(Js65Result, messages) == 8, "Js65Result layout");
static_assert(offsetof(Js65Result, success) == 16, "Js65Result layout");
static_assert(offsetof(Js65Message, source) == 24, "Js65Message layout");
static_assert(offsetof(Js65SourceInfo, line) == 24, "Js65SourceInfo layout");
static_assert(offsetof(Js65OutputFile, data) == 16, "Js65OutputFile layout");
static_assert(offsetof(Js65OutputFile, dataLength) == 24, "Js65OutputFile layout");

namespace {

// Mutable accumulator the JS frontend fills via the __js65_result* bindings; converted to
// the immutable Js65Result tree once the run completes.
struct SourceFrameBuilder {
  bool hasIdent = false;
  std::string ident;
  std::string file;
  int32_t line = 0;
  int32_t column = 0;
};
struct MessageBuilder {
  std::string level;
  std::string message;
  bool hasStack = false;
  std::string stack;
  std::vector<SourceFrameBuilder> frames; // innermost first, up the include/macro stack
};
struct OutputFileBuilder {
  std::string name;
  std::string type;
  std::vector<uint8_t> data;
};
struct ResultBuilder {
  int32_t success = 0;
  std::vector<OutputFileBuilder> outputs;
  std::vector<MessageBuilder> messages;
};

// The runtime is single-threaded and js65_compile re-inits it per call, so we
// guard access through a compile mutex.
std::mutex g_compileMutex;

char *dupString(std::string_view s) {
  char *p = static_cast<char *>(std::malloc(s.size() + 1));
  std::memcpy(p, s.data(), s.size());
  p[s.size()] = '\0';
  return p;
}

// Link a message's source frames into a parent chain: source == frames.front(), each
// frame's parent the next-outer one. Returns the head, or nullptr when there are none.
const Js65SourceInfo *buildSourceChain(const std::vector<SourceFrameBuilder> &frames) {
  const Js65SourceInfo *parent = nullptr;
  for (size_t i = frames.size(); i-- > 0;) {
    auto *node = static_cast<Js65SourceInfo *>(std::calloc(1, sizeof(Js65SourceInfo)));
    node->ident = frames[i].hasIdent ? dupString(frames[i].ident) : nullptr;
    node->file = dupString(frames[i].file);
    node->line = frames[i].line;
    node->column = frames[i].column;
    node->parent = parent;
    parent = node;
  }
  return parent;
}

const Js65Result *buildResult(const ResultBuilder &b) {
  auto *result = static_cast<Js65Result *>(std::calloc(1, sizeof(Js65Result)));
  result->success = b.success;
  result->outputCount = static_cast<int32_t>(b.outputs.size());
  if (!b.outputs.empty()) {
    auto *outputs = static_cast<Js65OutputFile *>(std::calloc(b.outputs.size(), sizeof(Js65OutputFile)));
    for (size_t i = 0; i < b.outputs.size(); ++i) {
      const OutputFileBuilder &ob = b.outputs[i];
      outputs[i].name = dupString(ob.name);
      outputs[i].type = dupString(ob.type);
      outputs[i].dataLength = static_cast<int32_t>(ob.data.size());
      if (!ob.data.empty()) {
        auto *data = static_cast<uint8_t *>(std::malloc(ob.data.size()));
        std::memcpy(data, ob.data.data(), ob.data.size());
        outputs[i].data = data;
      }
    }
    result->outputs = outputs;
  }
  result->messageCount = static_cast<int32_t>(b.messages.size());
  if (!b.messages.empty()) {
    auto *messages = static_cast<Js65Message *>(std::calloc(b.messages.size(), sizeof(Js65Message)));
    for (size_t i = 0; i < b.messages.size(); ++i) {
      const MessageBuilder &mb = b.messages[i];
      messages[i].level = dupString(mb.level);
      messages[i].message = dupString(mb.message);
      messages[i].stack = mb.hasStack ? dupString(mb.stack) : nullptr;
      messages[i].source = buildSourceChain(mb.frames);
    }
    result->messages = messages;
  }
  return result;
}

void freeSourceChain(const Js65SourceInfo *node) {
  while (node) {
    const Js65SourceInfo *parent = node->parent;
    std::free(const_cast<char *>(node->ident));
    std::free(const_cast<char *>(node->file));
    std::free(const_cast<void *>(static_cast<const void *>(node)));
    node = parent;
  }
}

std::string_view utf8Arg(jsi::Runtime &rt, const jsi::Value *args, size_t count, size_t i, std::string &storage) {
  if (i < count && args[i].isString()) {
    storage = args[i].getString(rt).utf8(rt);
    return storage;
  }
  return {};
}

// request + result-building bindings, specific to the library entry.
void installLibBindings(jsi::Runtime &rt, HostContext &ctx, ResultBuilder &builder) {
  js65core::setFn(rt, "__js65_request", 0,
      [&ctx](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        return jsi::String::createFromUtf8(rt, ctx.request);
      });

  js65core::setFn(rt, "__js65_baseRom", 0,
      [&ctx](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        return js65core::makeUint8Array(rt, ctx.baseRom);
      });

  // Polled by the TS core at per-line / per-chunk boundaries; reads the host-owned cancel
  // flag, which another thread may flip while this compile is running under the lock.
  js65core::setFn(rt, "__js65_cancelled", 0,
      [&ctx](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t) -> jsi::Value {
        return jsi::Value(ctx.cancelFlag != nullptr && *ctx.cancelFlag != 0);
      });

  js65core::setFn(rt, "__js65_resultBegin", 1,
      [&builder](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        builder.success = (count >= 1 && args[0].isBool() && args[0].getBool()) ? 1 : 0;
        return jsi::Value::undefined();
      });

  // resultAdd functions are used to pass the result data from JS -> C++. We don't have a generalized
  // serialization for this, so we just loop over it in JS and call these "create" methods to add
  // to the current result buffer basically. 
  js65core::setFn(rt, "__js65_resultAddOutput", 3,
      [&builder](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 3 || !args[0].isString() || !args[2].isString())
          js65core::throwError(rt, "__js65_resultAddOutput: (name, data, type) expected");
        OutputFileBuilder ob;
        ob.name = args[0].getString(rt).utf8(rt);
        ob.data = js65core::getBytes(rt, args[1]);
        ob.type = args[2].getString(rt).utf8(rt);
        builder.outputs.push_back(std::move(ob));
        return jsi::Value::undefined();
      });

  js65core::setFn(rt, "__js65_resultAddMessage", 3,
      [&builder](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 2 || !args[0].isString() || !args[1].isString())
          js65core::throwError(rt, "__js65_resultAddMessage: (level, message, stack?) expected");
        MessageBuilder mb;
        mb.level = args[0].getString(rt).utf8(rt);
        mb.message = args[1].getString(rt).utf8(rt);
        mb.hasStack = count >= 3 && args[2].isString();
        if (mb.hasStack) mb.stack = args[2].getString(rt).utf8(rt);
        builder.messages.push_back(std::move(mb));
        return jsi::Value(static_cast<double>(builder.messages.size() - 1));
      });

  js65core::setFn(rt, "__js65_resultAddSourceFrame", 5,
      [&builder](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t count) -> jsi::Value {
        if (count < 5 || !args[0].isNumber())
          js65core::throwError(rt, "__js65_resultAddSourceFrame: (messageIndex, ident, file, line, column) expected");
        auto index = static_cast<size_t>(args[0].getNumber());
        if (index >= builder.messages.size())
          js65core::throwError(rt, "__js65_resultAddSourceFrame: message index out of range");
        SourceFrameBuilder frame;
        frame.hasIdent = args[1].isString();
        if (frame.hasIdent) frame.ident = args[1].getString(rt).utf8(rt);
        std::string scratch;
        frame.file = utf8Arg(rt, args, count, 2, scratch);
        frame.line = args[3].isNumber() ? static_cast<int32_t>(args[3].getNumber()) : 0;
        frame.column = args[4].isNumber() ? static_cast<int32_t>(args[4].getNumber()) : 0;
        builder.messages[index].frames.push_back(std::move(frame));
        return jsi::Value::undefined();
      });
}

} // namespace

extern "C" JS65_EXPORT const Js65Result *js65_compile(
    void *ctx,
    const char *requestJson,
    const uint8_t *baseRom,
    int32_t baseRomLen,
    Js65ReadFn readText,
    Js65ReadFn readBinary,
    const int32_t *cancelFlag) {
  std::lock_guard<std::mutex> lock(g_compileMutex);

  HostContext host;
  host.readText = readText;
  host.readBinary = readBinary;
  host.readCtx = ctx;
  host.cancelFlag = cancelFlag;
  host.request = requestJson ? requestJson : "";
  if (baseRom && baseRomLen > 0)
    host.baseRom.assign(baseRom, baseRom + baseRomLen);
  host.args = {"--lib"};

  ResultBuilder builder;
  bool ok = js65core::runJs65Core(host, [&builder](jsi::Runtime &rt, HostContext &c) {
    installLibBindings(rt, c, builder);
  });
  if (!ok)
    return nullptr;
  return buildResult(builder);
}

extern "C" JS65_EXPORT void js65_free_result(const Js65Result *result) {
  if (!result)
    return;
  for (int32_t i = 0; i < result->outputCount; ++i) {
    const Js65OutputFile &o = result->outputs[i];
    std::free(const_cast<char *>(o.name));
    std::free(const_cast<char *>(o.type));
    std::free(const_cast<uint8_t *>(o.data));
  }
  std::free(const_cast<Js65OutputFile *>(result->outputs));
  for (int32_t i = 0; i < result->messageCount; ++i) {
    const Js65Message &m = result->messages[i];
    std::free(const_cast<char *>(m.level));
    std::free(const_cast<char *>(m.message));
    std::free(const_cast<char *>(m.stack));
    freeSourceChain(m.source);
  }
  std::free(const_cast<Js65Message *>(result->messages));
  std::free(const_cast<Js65Result *>(result));
}
