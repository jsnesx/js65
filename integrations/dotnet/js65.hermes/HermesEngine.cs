
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace js65;

/// Assembler frontend backed by the Static Hermes (shermes) native build of js65: a
/// smaller but slower alternative to ClearScript for desktop use.

[SupportedOSPlatform("windows")]
[SupportedOSPlatform("linux")]
[SupportedOSPlatform("macos")]
public partial class HermesEngine : Assembler, IDisposable
{
    // Base name passed to [LibraryImport]; the resolver below maps it to the per-platform
    // file under the app directory or runtimes/{rid}/native.
    private const string LibraryName = "js65";

    /// Environment variable that, when set to an existing file, overrides library discovery.
    /// Useful for development against a locally built shared library.
    public const string LibraryPathEnvVar = "JS65_HERMES_PATH";

    // js65_compile re-inits the single-threaded Hermes runtime, so calls must not overlap. A
    // SemaphoreSlim (rather than lock) lets a queued compile honor its CancellationToken while
    // it waits for an in-flight compile to release the gate.
    private static readonly SemaphoreSlim CompileGate = new(1, 1);

    private readonly Js65ResolveFn _resolveText;
    private readonly Js65ResolveFn _resolveBinary;
    private readonly IntPtr _resolveTextPtr;
    private readonly IntPtr _resolveBinaryPtr;

    // Pins the buffer most recently handed to the native side until it has been copied
    // (the native read binding copies synchronously before the next callback / return).
    private GCHandle _pinned;

    static HermesEngine()
    {
        NativeLibrary.SetDllImportResolver(typeof(HermesEngine).Assembly, ResolveLibrary);
    }

    /// <param name="options"></param>
    /// <param name="callbacks">Resolve callbacks for <c>.include</c>/<c>.incbin</c>. Defaults to
    /// <see cref="Js65FileSystemCallbacks.Default"/>, which reads relative to the executable.</param>
    public HermesEngine(Js65Options? options = null, Js65Callbacks? callbacks = null)
        : base(options, callbacks ?? Js65FileSystemCallbacks.Default)
    {
        _resolveText = ResolveTextThunk;
        _resolveBinary = ResolveBinaryThunk;
        _resolveTextPtr = Marshal.GetFunctionPointerForDelegate(_resolveText);
        _resolveBinaryPtr = Marshal.GetFunctionPointerForDelegate(_resolveBinary);
    }

    public override async Task<Js65CompileResult> Apply(byte[] rom, CancellationToken ct = default)
    {
        var req = BuildRequest();

        await CompileGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return await Task.Run(() =>
            {
                // Host-owned cancel flag the native side polls (via __js65_cancelled). Pinned so
                // its address stays valid for the whole call
                var cancel = new int[1];
                var cancelHandle = GCHandle.Alloc(cancel, GCHandleType.Pinned);
                using var reg = ct.Register(() => Volatile.Write(ref cancel[0], 1));
                try
                {
                    var resultPtr = js65_compile(
                        IntPtr.Zero, req, rom, rom.Length, _resolveTextPtr, _resolveBinaryPtr,
                        cancelHandle.AddrOfPinnedObject());
                    FreePinned();
                    if (resultPtr == IntPtr.Zero)
                        throw new InvalidOperationException("The js65 shared library failed to run the compile.");
                    try
                    {
                        // On cancel the native side still returned a clean failure result; surface
                        // the idiomatic .NET cancellation signal to the caller instead.
                        ct.ThrowIfCancellationRequested();
                        return MarshalResult(resultPtr);
                    }
                    finally
                    {
                        js65_free_result(resultPtr);
                    }
                }
                finally
                {
                    cancelHandle.Free();
                }
            }, ct).ConfigureAwait(false);
        }
        finally
        {
            CompileGate.Release();
        }
    }

    [LibraryImport(LibraryName, StringMarshalling = StringMarshalling.Utf8)]
    private static partial IntPtr js65_compile(
        IntPtr ctx,
        string requestJson,
        [In] byte[] baseRom,
        int baseRomLen,
        IntPtr resolveText,
        IntPtr resolveBinary,
        IntPtr cancelFlag);

    [LibraryImport(LibraryName)]
    private static partial void js65_free_result(IntPtr result);

    // Mirrors of the C ABI structs in js65.h: pointers first, then int32s, so the field
    // offsets match the native side on 64-bit targets with no padding.
    [StructLayout(LayoutKind.Sequential)]
    private struct Js65ResultNative
    {
        public IntPtr outputs;
        public IntPtr messages;
        public int success;
        public int messageCount;
        public int outputCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Js65OutputFileNative
    {
        public IntPtr name;
        public IntPtr type;
        public IntPtr data;
        public int dataLength;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Js65MessageNative
    {
        public IntPtr level;
        public IntPtr message;
        public IntPtr stack;
        public IntPtr source;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Js65SourceInfoNative
    {
        public IntPtr parent;
        public IntPtr ident;
        public IntPtr file;
        public int line;
        public int column;
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int Js65ResolveFn(IntPtr ctx, IntPtr basePaths, int basePathCount, IntPtr relPath,
                                       out int outBase, out IntPtr outData, out int outLen);

    private int ResolveTextThunk(IntPtr ctx, IntPtr basePaths, int basePathCount, IntPtr relPath,
                                 out int outBase, out IntPtr outData, out int outLen)
        => Resolve(text: true, basePaths, basePathCount, relPath, out outBase, out outData, out outLen);

    private int ResolveBinaryThunk(IntPtr ctx, IntPtr basePaths, int basePathCount, IntPtr relPath,
                                   out int outBase, out IntPtr outData, out int outLen)
        => Resolve(text: false, basePaths, basePathCount, relPath, out outBase, out outData, out outLen);

    private int Resolve(bool text, IntPtr basePaths, int basePathCount, IntPtr relPath,
                        out int outBase, out IntPtr outData, out int outLen)
    {
        outBase = 0;
        outData = IntPtr.Zero;
        outLen = 0;
        try
        {
            FreePinned();
            var bases = new string[basePathCount < 0 ? 0 : basePathCount];
            for (var i = 0; i < bases.Length; i++)
                bases[i] = Marshal.PtrToStringUTF8(Marshal.ReadIntPtr(basePaths, i * IntPtr.Size)) ?? "";
            var relPathStr = Marshal.PtrToStringUTF8(relPath) ?? "";

            int? hitIndex;
            byte[]? bytes;
            if (text)
            {
                var hit = Callbacks?.OnFileResolveText?.Invoke(bases, relPathStr);
                hitIndex = hit?.BaseIndex;
                bytes = hit is null ? null : Encoding.UTF8.GetBytes(hit.Content);
            }
            else
            {
                var hit = Callbacks?.OnFileResolveBinary?.Invoke(bases, relPathStr);
                hitIndex = hit?.BaseIndex;
                bytes = hit?.Content;
            }

            if (bytes is null || hitIndex is null) return -1;
            if (hitIndex.Value < 0 || hitIndex.Value >= bases.Length) return -1;
            outBase = hitIndex.Value;

            if (bytes.Length == 0) return 0; // outData stays null; native treats len 0 as empty.

            _pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            outData = _pinned.AddrOfPinnedObject();
            outLen = bytes.Length;
            return 0;
        }
        catch
        {
            return -1;
        }
    }

    private void FreePinned()
    {
        if (_pinned.IsAllocated) _pinned.Free();
    }

    private static Js65CompileResult MarshalResult(IntPtr resultPtr)
    {
        var native = Marshal.PtrToStructure<Js65ResultNative>(resultPtr);

        var outputs = new Js65OutputFile[native.outputCount];
        var outputSize = Marshal.SizeOf<Js65OutputFileNative>();
        for (var i = 0; i < native.outputCount; i++)
        {
            var output = Marshal.PtrToStructure<Js65OutputFileNative>(native.outputs + i * outputSize);
            var data = output.dataLength > 0 ? new byte[output.dataLength] : [];
            if (output.dataLength > 0)
                Marshal.Copy(output.data, data, 0, output.dataLength);
            outputs[i] = new Js65OutputFile
            {
                name = Marshal.PtrToStringUTF8(output.name) ?? "",
                type = Marshal.PtrToStringUTF8(output.type) ?? "binary",
                data = data,
            };
        }

        var messages = new Js65AssemblerMessage[native.messageCount];
        var messageSize = Marshal.SizeOf<Js65MessageNative>();
        for (var i = 0; i < native.messageCount; i++)
        {
            var msg = Marshal.PtrToStructure<Js65MessageNative>(native.messages + i * messageSize);
            messages[i] = new Js65AssemblerMessage
            {
                level = Marshal.PtrToStringUTF8(msg.level) ?? "error",
                message = Marshal.PtrToStringUTF8(msg.message) ?? "",
                stack = Marshal.PtrToStringUTF8(msg.stack),
                source = MarshalSource(msg.source),
            };
        }

        return new Js65CompileResult
        {
            success = native.success != 0,
            outputs = outputs,
            messages = messages,
        };
    }

    private static Js65SourceInfo? MarshalSource(IntPtr sourcePtr)
    {
        if (sourcePtr == IntPtr.Zero) return null;
        var native = Marshal.PtrToStructure<Js65SourceInfoNative>(sourcePtr);
        return new Js65SourceInfo
        {
            ident = Marshal.PtrToStringUTF8(native.ident),
            file = Marshal.PtrToStringUTF8(native.file) ?? "",
            line = native.line,
            column = native.column,
            parent = MarshalSource(native.parent),
        };
    }

    // Search order: an env override, the app directory, then runtimes/{rid}/native (the
    // NuGet layout). Falls back to the platform's default search if none match.
    private static IntPtr ResolveLibrary(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (libraryName != LibraryName) return IntPtr.Zero;
        foreach (var candidate in CandidatePaths())
            if (File.Exists(candidate) && NativeLibrary.TryLoad(candidate, out var handle))
                return handle;
        return IntPtr.Zero;
    }

    private static IEnumerable<string> CandidatePaths()
    {
        var fileName = NativeFileName();

        var overridePath = Environment.GetEnvironmentVariable(LibraryPathEnvVar);
        if (!string.IsNullOrEmpty(overridePath))
            yield return overridePath;

        var baseDir = AppContext.BaseDirectory;
        var rid = RuntimeInformation.RuntimeIdentifier;
        yield return Path.Combine(baseDir, fileName);
        yield return Path.Combine(baseDir, "runtimes", rid, "native", fileName);
    }

    private static string NativeFileName()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return "js65.dll";
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) return "libjs65.dylib";
        return "libjs65.so";
    }

    public override void Dispose()
    {
        FreePinned();
        GC.SuppressFinalize(this);
    }
}
