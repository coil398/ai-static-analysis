#include "greet.hpp"

namespace testproject {

std::string Greeter::greet(const std::string& name) const {
    return "Hello, " + name + "!";
}

}  // namespace testproject
