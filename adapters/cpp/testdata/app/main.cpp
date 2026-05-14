#include <iostream>
#include "greet.hpp"

int main() {
    testproject::Greeter g;
    std::cout << g.greet("world") << std::endl;
    return 0;
}
