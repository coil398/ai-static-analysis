package pkg

// Greeter defines an interface for greeting.
type Greeter interface {
	Greet() string
}

// ConsoleGreeter implements Greeter.
type ConsoleGreeter struct{}

// Greet returns a greeting string via ConsoleGreeter.
func (g *ConsoleGreeter) Greet() string {
	return "hello"
}

// SayHello calls g.Greet() via the Greeter interface.
func SayHello(g Greeter) string {
	return g.Greet()
}
