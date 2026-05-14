#ifndef TESTPROJECT_GREET_HPP
#define TESTPROJECT_GREET_HPP

#include <string>

namespace testproject {

class Greeter {
public:
    std::string greet(const std::string& name) const;
};

}  // namespace testproject

#endif
