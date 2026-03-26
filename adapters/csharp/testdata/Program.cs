using TestProject.Services;

var service = new Service("Hello");
var message = service.Greet("World");
Console.WriteLine(message);
