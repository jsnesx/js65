
using System.Collections;
using System.Dynamic;

namespace js65;

public record Js65Callbacks
{
    public const string STDIN = "//stdin";
    public const string STDOUT = "//stdout";
    public delegate string FileReadText(string basePath, string file);
    public delegate byte[] FileReadBinary(string basePath, string file);
    public FileReadText? OnFileReadText { get; set; }
    public FileReadBinary? OnFileReadBinary { get; set; }
}

public record Js65Options
{
    public IEnumerable<string> includePaths = new List<string>();
    public bool lineContinuations = false;
    public bool numberSeperators = false;
    public bool skipSourceAnnotations = false;
}

public abstract class Assembler(Js65Options? options = null, Js65Callbacks? callbacks = null)
{
    public Js65Options Options = options ?? new Js65Options();
    public Js65Callbacks? Callbacks = callbacks;
    public List<AsmModule> Modules { get; } = new();

    public void Add(AsmModule asmModule)
    {
        Modules.Add(asmModule);
    }

    public AsmModule Module()
    {
        var mod = new AsmModule();
        Add(mod);
        return mod;
    }

    public abstract Task<byte[]?> Apply(byte[] rom);

    protected List<List<ExpandoObject>> IntoExpandoObject()
    {
        var modules = new List<List<ExpandoObject>>();
        foreach (var module in Modules)
        {
            var outmodule = new List<ExpandoObject>();
            foreach (var dict in module.Actions)
            {
                outmodule.Add(dict.ToExpandoObject());
            }
            modules.Add(outmodule);
        }
        return modules;
    }
}

internal static class DictionaryExtensions
{
    public static ExpandoObject ToExpandoObject(this IDictionary<string, object> dictionary)
    {
        var bag = new ExpandoObject();
        var dict = bag as IDictionary<string, object>;
        foreach (var kvp in dictionary)
        {
            switch (kvp.Value)
            {
                case IDictionary<string, object> objects:
                {
                    var inner = objects.ToExpandoObject() as IDictionary<string, object>;
                    dict.Add(kvp.Key, inner);
                    break;
                }
                case ICollection list:
                {
                    var itemList = new List<object>();
                    foreach (var item in list)
                    {
                        if (item is IDictionary<string, object> objs)
                        {
                            var bagitem = objs.ToExpandoObject();
                            itemList.Add(bagitem);
                        }
                        else
                        {
                            itemList.Add(item);
                        }
                    }

                    dict.Add(kvp.Key, itemList);
                    break;
                }
                default:
                    dict.Add(kvp.Key, kvp.Value);
                    break;
            }
        }

        return bag;
    }
}