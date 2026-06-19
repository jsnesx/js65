
using System.Reflection;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using js65;
using Microsoft.ClearScript;
using Microsoft.ClearScript.JavaScript;
using Microsoft.ClearScript.V8;

namespace js65;

[SupportedOSPlatform("windows")]
[SupportedOSPlatform("linux")]
[SupportedOSPlatform("macos")]
public class ClearScriptEngine : Assembler, IDisposable
{
    private readonly V8ScriptEngine _engine;

    /// <summary>
    /// Initialize the Clearscript backed assembler engine.
    /// </summary>
    /// <param name="options"></param>
    /// <param name="useFileSystemCallbacks"></param>
    /// <param name="debugJavascript">Sets clearscript flags to debug the internal javascript</param>
    public ClearScriptEngine(Js65Options? options = null, bool useFileSystemCallbacks = true, bool debugJavascript = false) : base(options)
    {
        // If you need to debug the javascript, add these flags and connect to the debugger through vscode.
        // follow this tutorial for how https://clearscript.clearfoundry.net/Details/Build.html#_Debugging_with_ClearScript_2
        var overrideDebug = false;
        var debugFlags = debugJavascript || overrideDebug
            ? V8ScriptEngineFlags.EnableDebugging | V8ScriptEngineFlags.EnableRemoteDebugging |
              V8ScriptEngineFlags.AwaitDebuggerAndPauseOnStart
            : 0;
        _engine = new V8ScriptEngine(debugFlags);

        _engine.DocumentSettings.AccessFlags = DocumentAccessFlags.EnableAllLoading;

        // Bare V8 ships no TextEncoder/TextDecoder, which the assembler uses to encode
        // text outputs, so install a small polyfill
        _engine.Execute(/* language=javascript */ TextCodecPolyfill);

        // Load the js65 code from the embedded resources
        var libassembler = ReadResource(typeof(ClearScriptEngine).Assembly, "js65.libassembler.js");
        _engine.DocumentSettings.AddSystemDocument("@system/libassembler", ModuleCategory.Standard,libassembler);

        // Setup the filesystem callbacks
        if (!useFileSystemCallbacks) return;
        Callbacks = new()
        {
            OnFileReadText = LoadTextFileCallback,
            OnFileReadBinary = LoadBinaryFileCallback
        };
    }
    
    public override async Task<Js65CompileResult> Apply(byte[] rom, CancellationToken ct = default)
    {
        _engine.AddHostTypes(typeof(Task), typeof(Console), typeof(JavaScriptExtensions), typeof(Js65Callbacks), typeof(Js65Options));
        _engine.AddHostObject("FileCallbacks", Callbacks);
        // The JS polls hostCancel.IsCancellationRequested; a boxed CancellationToken still
        // reflects cancellation because the struct references the underlying token source.
        _engine.AddHostObject("hostCancel", ct);
        _engine.Script.requestJson = BuildRequest();

        // Hand the base ROM to JS as a real Uint8Array (no base64). Allocates it in the
        // engine, then copy the bytes in through a typed-array view.
        var baseRomObj = _engine.Evaluate($"new Uint8Array({rom.Length})");
        if (rom.Length > 0)
            ((ITypedArray<byte>)baseRomObj).WriteBytes(rom, 0, (ulong)rom.Length, 0);
        _engine.Script.baseRom = baseRomObj;

        _engine.Script.compileOutputs = null;
        _engine.Script.compileSuccess = false;
        _engine.Script.compileMessages = "[]";
        await Task.Run(() => {
            _engine.Execute(new DocumentInfo { Category = ModuleCategory.Standard },  /* language=javascript */ """
import { compileRequest } from '@system/libassembler'

// ClearScript hands a .NET byte[] back as a host array (indexed access + .Length);
// copy it into a real Uint8Array the assembler can slice/encode.
function toU8(hostBytes) {
    const n = hostBytes.Length;
    const u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = hostBytes[i];
    return u8;
}
const callbacks = {
    readText: (basePath, relPath) => FileCallbacks.OnFileReadText(basePath, relPath),
    readBinary: (basePath, relPath) => toU8(FileCallbacks.OnFileReadBinary(basePath, relPath)),
};
// Bare CancelSignal polling the host token (V8 ships no AbortController); the core reads
// .aborted at per-line / per-chunk boundaries so a long compile cancels cooperatively.
const signal = { get aborted() { return hostCancel.IsCancellationRequested; } };
// compileRequest deserializes the request, and catches any errors to return a proper CompileResult
(async () => {
    await compileRequest(requestJson, callbacks, baseRom.length ? baseRom : undefined, signal).then(result => {
        // Hand the whole outputs list (each { name, data:Uint8Array, type }) to the host;
        // the debug sidecar is just a 'debug'-typed entry, no separate field.
        compileOutputs = result.outputs;
        compileSuccess = result.success;
        compileMessages = JSON.stringify(result.messages || []);
    });
})();
""");
        }, ct).ConfigureAwait(true);
        // A cancelled compile returns a clean failure result; surface the .NET cancellation
        // signal to the caller instead.
        ct.ThrowIfCancellationRequested();
        var success = (bool)_engine.Script.compileSuccess;
        var messagesJson = (string)_engine.Script.compileMessages;
        var messages = JsonSerializer.Deserialize(messagesJson, Js65JsonContext.Default.Js65AssemblerMessageArray) ?? [];

        // Read each output's typed-array bytes back in C# types.
        dynamic jsOutputs = _engine.Script.compileOutputs;
        int count = (int)jsOutputs.length;
        var outputs = new Js65OutputFile[count];
        for (var i = 0; i < count; i++)
        {
            dynamic o = jsOutputs[i];
            var ta = (ITypedArray<byte>)o.data;
            var bytes = new byte[ta.Length];
            if (ta.Length > 0) ta.ReadBytes(0, (ulong)bytes.Length, bytes, 0);
            outputs[i] = new Js65OutputFile
            {
                name = (string)o.name,
                type = (string)o.type,
                data = bytes,
            };
        }
        return new Js65CompileResult
        {
            success = success,
            outputs = outputs,
            messages = messages
        };
    }

    // Minimal UTF-8 TextEncoder/TextDecoder for bare V8 (mirrors the Hermes host polyfill).
    // A bit annoying we need this in two places, but it shouldn't need to change ever.
    private const string TextCodecPolyfill = /* language=javascript */ """
if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class {
        encode(str) {
            const out = [];
            for (let i = 0; i < str.length; i++) {
                let cp = str.charCodeAt(i);
                if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
                    const lo = str.charCodeAt(i + 1);
                    if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i++; }
                }
                if (cp < 0x80) out.push(cp);
                else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
                else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
                else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
            }
            return new Uint8Array(out);
        }
    };
}
if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = class {
        decode(input) {
            const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
            let out = '';
            for (let i = 0; i < bytes.length;) {
                const b = bytes[i++];
                let cp;
                if (b < 0x80) cp = b;
                else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
                else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
                else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
                if (cp > 0xffff) { cp -= 0x10000; out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
                else out += String.fromCharCode(cp);
            }
            return out;
        }
    };
}
""";

    private static string ReadResource(Assembly assembly, string name)
    {
        // Format: "{Namespace}.{Folder}.{filename}.{Extension}"
        using var stream = assembly.GetManifestResourceStream(name)!;
        using StreamReader reader = new(stream);
        return reader.ReadToEnd();
    }

    private static string? ExeBasePath => Path.GetDirectoryName(Assembly.GetEntryAssembly()!.Location);

    private static string LoadTextFileCallback(string basePath, string relPath)
    {
        var fullPath = Path.GetFullPath(Path.Combine(ExeBasePath!, basePath, relPath));
        if (!File.Exists(fullPath))
            throw new FileNotFoundException($"Could not find file {fullPath}");
        var data = File.ReadAllText(fullPath);
        return data;
    }
    private static byte[] LoadBinaryFileCallback(string basePath, string relPath)
    {
        var fullPath = Path.GetFullPath(Path.Combine(ExeBasePath!, basePath, relPath));
        if (!File.Exists(fullPath))
            throw new FileNotFoundException($"Could not find file {fullPath}");
        var data = File.ReadAllBytes(fullPath);
        return data;
    }

    public override void Dispose()
    {
        _engine.Dispose();
    }
}
