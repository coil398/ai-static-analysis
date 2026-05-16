cmake_minimum_required(VERSION 3.10)
project(testproject CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include_directories(include)

add_library(greet STATIC lib/greet.cpp)
add_executable(app app/main.cpp)
target_link_libraries(app PRIVATE greet)
