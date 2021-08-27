cmake_minimum_required (VERSION 2.6)
#project (mnode_launcher)
# The version number.
#set (Launcher_VERSION_MAJOR 0)
#set (Launcher_VERSION_MINOR 1)

add_subdirectory(src/belnet)
#set(CMAKE_PREFIX_PATH src/beldex)
#set(CMAKE_MODULE_PATH src/beldex/cmake)
add_subdirectory(src/beldex)
