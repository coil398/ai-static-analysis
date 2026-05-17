namespace TestProject.Services;

public class Service : IService
{
    private readonly string _prefix;

    public Service(string prefix)
    {
        _prefix = prefix;
    }

    public string Greet(string name)
    {
        return $"{_prefix}, {name}!";
    }
}
