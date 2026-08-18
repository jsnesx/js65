
// SPDX-License-Identifier: MPL-2.0

using System.Reflection;

namespace js65;

/// <summary>
/// The default disk based resolve callback, shared by every desktop engine. Each engine
/// installs these unless the caller passes its own <see cref="Js65Callbacks"/>.
/// </summary>
public static class Js65FileSystemCallbacks
{
    /// <summary>The disk-backed callbacks a desktop engine uses when the caller supplies none.</summary>
    public static Js65Callbacks Default => new()
    {
        OnFileResolveText = ResolveText,
        OnFileResolveBinary = ResolveBinary,
    };

    private static string? ExeBasePath => Path.GetDirectoryName(Assembly.GetEntryAssembly()!.Location);

    /// <summary>Resolve relative to the running executable's directory.</summary>
    public static Js65ResolvedText? ResolveText(IReadOnlyList<string> basePaths, string file)
    {
        var found = Find(basePaths, file);
        return found is null ? null : new Js65ResolvedText(found.Value.BaseIndex, File.ReadAllText(found.Value.FullPath));
    }

    /// <inheritdoc cref="ResolveText"/>
    public static Js65ResolvedBinary? ResolveBinary(IReadOnlyList<string> basePaths, string file)
    {
        var found = Find(basePaths, file);
        return found is null ? null : new Js65ResolvedBinary(found.Value.BaseIndex, File.ReadAllBytes(found.Value.FullPath));
    }

    /// <summary>
    /// First base whose combination with <paramref name="file"/> exists on disk. Returns
    /// null when no base has the file.
    /// </summary>
    private static (int BaseIndex, string FullPath)? Find(IReadOnlyList<string> basePaths, string file)
    {
        for (var i = 0; i < basePaths.Count; i++)
        {
            var fullPath = Path.GetFullPath(Path.Combine(ExeBasePath!, basePaths[i], file));
            if (File.Exists(fullPath)) return (i, fullPath);
        }
        return null;
    }
}
