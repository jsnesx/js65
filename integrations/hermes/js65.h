/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Stable C ABI for the js65 shared library (js65.dll / libjs65.so / libjs65.dylib).
// A native host (e.g. the .NET js65.hermes engine) calls js65_compile to assemble and
// link a request, supplying two function pointers that service .include / .incbin reads
// so includes can come from anywhere the host chooses, not just disk.
//
// The result is an explicit struct tree, not an opaque blob: every field has a fixed
// offset so any language can marshal it directly. Explicit padding members pin the
// layout so it does not shift with compiler alignment choices. All pointers below are
// owned by the library and remain valid until js65_free_result; strings are UTF-8 and
// NUL-terminated; a pointer documented as nullable is NULL when the value is absent.

#ifndef JS65_H
#define JS65_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#define JS65_EXPORT __declspec(dllexport)
#else
#define JS65_EXPORT __attribute__((visibility("default")))
#endif

// User provided File-read callback. Return 0 on success and set *outData/*outLen to a buffer that
// stays valid until the next callback call or until js65_compile returns; the library
// copies it before either happens. Return nonzero for not-found/error, which the
// assembler reports as a diagnostic. Text is UTF-8 bytes (no NUL terminator required).
//
//   userData  - the opaque pointer passed as ctx to js65_compile
//   basePath  - the include base directory being searched (may be empty)
//   relPath   - the file requested by the directive
typedef int32_t (*Js65ReadFn)(
    void *userData,
    const char *basePath,
    const char *relPath,
    const uint8_t **outData,
    int32_t *outLen);

// For the following types, we order each of the fields by pointers first then data second
// so that way we don't need to deal with differences betweeen 32bit and 64bit struct alignments.
// On 64bit, all pointers will be aligned to 8 byte boundaries.

// A source location, with parent pointing up the include / macro-expansion stack.
typedef struct Js65SourceInfo {
  const struct Js65SourceInfo *parent;  // nullable: next-outer frame
  const char *ident;                    // nullable: symbol/macro name at this frame
  const char *file;
  int32_t line;
  int32_t column;
} Js65SourceInfo;

// One diagnostic produced during assembly/linking.
typedef struct Js65Message {
  const char *level;            // "error" | "warning" | "info"
  const char *message;
  const char *stack;            // nullable: JS stack trace when captured
  const Js65SourceInfo *source; // nullable: where it originated
} Js65Message;

// One named output produced by a compile. `type` tags the artifact kind.
// "binary" (linked ROM / IPS), "object" (serialized .o), "debug" (debug info,
// e.g. MLB labels), "source", and more in future (e.g. "listing").
typedef struct Js65OutputFile {
  const char *name;
  const char *type;     // artifact kind: "binary" | "object" | "debug" | "source" | ...
  const uint8_t *data;  // dataLength bytes (NULL when empty)
  int32_t dataLength;
} Js65OutputFile;

// The outcome of one js65_compile call.
typedef struct Js65Result {
  const Js65OutputFile *outputs; // nullable list of output files (length in outputCount)
  const Js65Message *messages;   // nullable list of messages (length in messageCount)
  int32_t success;               // nonzero if assembly produced no errors
  int32_t messageCount;
  int32_t outputCount;
} Js65Result;

// Assemble and link one request. Only returns NULL if the js runtime init fails.
// * ctx is a user provided opaque pointer that will be passed into the callbacks.
// * requestJson is the combined input/action + options serialized as a string so that js65
// can validate the inputs as if they are untrusted (so you don't have to)
// For more details on the requestJson structure, see what the `Assembler.cs` class builds
// * baseRom is the image we are patching, it can be NULL if you aren't patching anything.
// * cancelFlag (nullable) points to host-owned memory that, when set to a nonzero value from
// another thread, cooperatively cancels the in-flight compile: the assembler observes it at
// per-line / per-chunk boundaries and returns a normal failure result (a "Compilation
// cancelled" message). Pass NULL to disable cancellation. The pointed-to int
// must stay valid for the duration of the call; the library only reads it.
//
// Not thread-safe: the call re-inits the single-threaded Hermes runtime, so callers must
// serialize concurrent js65_compile calls.
JS65_EXPORT const Js65Result *js65_compile(
    void *ctx,
    const char *requestJson,
    const uint8_t *baseRom,
    int32_t baseRomLen,
    Js65ReadFn readText,
    Js65ReadFn readBinary,
    const int32_t *cancelFlag);

// Free a result returned by js65_compile.
JS65_EXPORT void js65_free_result(const Js65Result *result);

#ifdef __cplusplus
} // extern "C"
#endif

#endif // JS65_H
