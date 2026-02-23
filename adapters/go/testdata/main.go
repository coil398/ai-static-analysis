package main

import (
	"fmt"

	"example.com/testproject/pkg"
)

func main() {
	s := pkg.NewService()
	fmt.Println(s.Hello())
}
