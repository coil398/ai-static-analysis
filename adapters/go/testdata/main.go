package main

import (
	"fmt"

	"example.com/testproject/pkg"
)

func main() {
	s := pkg.NewService()
	fmt.Println(s.Hello())

	// Call SayHello via Greeter interface to generate interface dispatch call edge
	g := &pkg.ConsoleGreeter{}
	fmt.Println(pkg.SayHello(g))
}
