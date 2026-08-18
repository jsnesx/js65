// The desktop target only ever runs the ClearScript/Hermes engines, which are themselves
// annotated for these three platforms. Without this the net8.0 build is platform-neutral and
// CA1416 flags every engine construction in DesktopExample.cs.
[assembly: System.Runtime.Versioning.SupportedOSPlatform("windows")]
[assembly: System.Runtime.Versioning.SupportedOSPlatform("linux")]
[assembly: System.Runtime.Versioning.SupportedOSPlatform("macos")]
