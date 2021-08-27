cmake_minimum_required (VERSION 2.6)
# The version number.
set (Launcher_VERSION_MAJOR 0)
set (Launcher_VERSION_MINOR 1)

#
# stolen from beldexd cmake
#

# ARCH defines the target architecture, either by an explicit identifier or
# one of the following two keywords. By default, ARCH a value of 'native':
# target arch = host arch, binary is not portable. When ARCH is set to the
# string 'default', no -march arg is passed, which creates a binary that is
# portable across processors in the same family as host processor.  In cases
# when ARCH is not set to an explicit identifier, cmake's builtin is used
# to identify the target architecture, to direct logic in this cmake script.
# Since ARCH is a cached variable, it will not be set on first cmake invocation.
if (NOT ARCH OR ARCH STREQUAL "" OR ARCH STREQUAL "native" OR ARCH STREQUAL "default")
  set(ARCH_ID "${CMAKE_SYSTEM_PROCESSOR}")
else()
  set(ARCH_ID "${ARCH}")
endif()
string(TOLOWER "${ARCH_ID}" ARM_ID)
string(SUBSTRING "${ARM_ID}" 0 3 ARM_TEST)
if (ARM_TEST STREQUAL "arm")
  set(ARM 1)
  string(SUBSTRING "${ARM_ID}" 0 5 ARM_TEST)
  if (ARM_TEST STREQUAL "armv6")
    set(ARM6 1)
  endif()
  if (ARM_TEST STREQUAL "armv7")
    set(ARM7 1)
  endif()
endif()

if (ARM_ID STREQUAL "aarch64" OR ARM_ID STREQUAL "arm64" OR ARM_ID STREQUAL "armv8-a")
  set(ARM 1)
  set(ARM8 1)
  set(ARCH "armv8-a")
endif()

if(ARCH_ID STREQUAL "ppc64le")
  set(PPC64LE 1)
  set(PPC64   0)
  set(PPC     0)
endif()

if(ARCH_ID STREQUAL "powerpc64" OR ARCH_ID STREQUAL "ppc64")
  set(PPC64LE 0)
  set(PPC64   1)
  set(PPC     0)
endif()

if(ARCH_ID STREQUAL "powerpc" OR ARCH_ID STREQUAL "ppc")
  set(PPC64LE 0)
  set(PPC64   0)
  set(PPC     1)
endif()

if(ARCH_ID STREQUAL "s390x")
  set(S390X 1)
endif()

if(WIN32 OR ARM OR PPC64LE OR PPC64 OR PPC)
  set(OPT_FLAGS_RELEASE "-O2")
else()
  set(OPT_FLAGS_RELEASE "-Ofast")
endif()

option(NO_AES "Explicitly disable AES support" ${NO_AES})

  if(NO_AES)
    message(STATUS "AES support explicitly disabled")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -DNO_AES")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DNO_AES")
  elseif(NOT ARM AND NOT PPC64LE AND NOT PPC64 AND NOT PPC AND NOT S390X)
    message(STATUS "AES support enabled")
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -maes")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -maes")
  elseif(PPC64LE OR PPC64 OR PPC)
    message(STATUS "AES support not available on POWER")
  elseif(S390X)
    message(STATUS "AES support not available on s390x")
  elseif(ARM6)
    message(STATUS "AES support not available on ARMv6")
  elseif(ARM7)
    message(STATUS "AES support not available on ARMv7")
  elseif(ARM8)
    CHECK_CXX_ACCEPTS_FLAG("-march=${ARCH}+crypto" ARCH_PLUS_CRYPTO)
    if(ARCH_PLUS_CRYPTO)
      message(STATUS "Crypto extensions enabled for ARMv8")
      set(ARCH_FLAG "-march=${ARCH}+crypto")
    else()
      message(STATUS "Crypto extensions unavailable on your ARMv8 device")
    endif()
  else()
    message(STATUS "AES support disabled")
  endif()

#
# end stolen from beldexd cmake
#

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -DPOSIX")

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++14 -fPIC -fpermissive")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DDEFAULT_DB_TYPE=\\\"lmdb\\\"")
#set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DBELDEX_VERSION_MAJOR=2 -DBELDEX_VERSION_MINOR=0 -DBELDEX_VERSION_PATCH=3")
#set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DBELDEX_VERSION=\\\"2.0.3-rc\\\" -DBELDEX_RELEASE_NAME=\\\"putnamehere\\\" -DBELDEX_VERSION_FULL=\\\"Wouldntyouliketoknow\\\"")

message(STATUS "CXX FLAGS => ${CMAKE_CXX_FLAGS}")

# We start in src/launcher/cmake
#include_directories ("..")

include_directories ("beldex/src")
include_directories ("beldex/contrib/epee/include")
include_directories ("beldex/external")
include_directories ("beldex/external/easylogging++")
include_directories ("beldex/external/unbound/libunbound")
include_directories ("beldex/external/rapidjson/include")
include_directories ("beldex/external/db_drivers/liblmdb")
# FIXME: requires beldex to be attempted to be built
find_path(
    TRANSLATION_FILES_INCLUDE_DIR
    NAMES "translation_files.h"
    PATHS "beldex/build/release/translations" "beldex/build/Linux/dev/release/translations" "beldex/build/Darwin/dev/release/translations" "beldex/build/release/translations"
)
message(STATUS "beldex translation files => ${TRANSLATION_FILES_INCLUDE_DIR}")
include_directories(${TRANSLATION_FILES_INCLUDE_DIR})
if(NOT TRANSLATION_FILES_INCLUDE_DIR)
  message(FATAL_ERROR "beldex configure stage not ran, run make in src/beldex or set TRANSLATION_FILES_INCLUDE_DIR")
endif()

include_directories ("beldex/build/release/translations")
include_directories ("beldex/build/release/external/miniupnp/miniupnpc")
# dev version
include_directories ("beldex/build/Linux/dev/release/translations")
include_directories ("beldex/build/Linux/dev/release/external/miniupnp/miniupnpc")
include_directories ("beldex/build/Darwin/dev/release/translations")
include_directories ("beldex/build/Darwin/dev/release/external/miniupnp/miniupnpc")

FIND_PACKAGE( Boost 1.58
  COMPONENTS
    chrono
    filesystem
    program_options
    regex
    serialization
    system
    thread
  REQUIRED
)

message(STATUS "Boost include => ${Boost_INCLUDE_DIR}")
#message(STATUS "Boost library => ${Boost_LIBRARY_DIR}") # empty on mac/linux
message(STATUS "Boost libraries => ${Boost_LIBRARIES}")
include_directories(${Boost_INCLUDE_DIR})

#find_path(
#    BOOST_INCLUDE_DIR
#    NAMES "boost/program_options/parsers.hpp"
#    PATHS "../../../depbuild/boost_1_64_0" /usr/local /usr
#)
#include_directories(${BOOST_INCLUDE_DIR})
#message(STATUS "boost include => ${BOOST_INCLUDE_DIR}")

#find_path(
#    BOOST_LIB_DIR
#    NAMES "libboost_chrono.a"
#    PATHS "../../../depbuild/boost_1_64_0/stage/lib" /usr/lib/x86_64-linux-gnu /usr/local /usr
#)
#link_directories(${BOOST_LIB_DIR})
#message(STATUS "boost lib => ${BOOST_LIB_DIR}")

# boost 1.61 (and higher) needs -D_GLIBCXX_USE_CXX11_ABI=1
#set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -D_GLIBCXX_USE_CXX11_ABI=1")

find_path(
    UNBOUND_LIB_DIR
    NAMES "libunbound.a"
    PATHS "../depbuild/unbound-1.8.1/.libs" /usr/local /usr
)
message(STATUS "unbound => ${UNBOUND_LIB_DIR}")
link_directories(${UNBOUND_LIB_DIR})

find_path(
    OPENSSL_LIB_DIR
    NAMES "libssl.a"
    PATHS "../depbuild/openssl-1.1.1" /usr/local /usr
)
link_directories(${OPENSSL_LIB_DIR})
message(STATUS "libssl.a => ${OPENSSL_LIB_DIR}")

find_path(
    ZMQ_LIB_DIR
    NAMES "libzmq.a"
    PATHS /usr/local/lib /usr/lib
)
link_directories(${ZMQ_LIB_DIR})
message(STATUS "libzmq.a => ${ZMQ_LIB_DIR}")


find_path(
    OPENSSL_DIR
    NAMES "include/openssl/conf.h"
    PATHS "../depbuild/openssl-1.1.1" /usr/local /usr
)
include_directories("${OPENSSL_DIR}/include")
message(STATUS "openssl => ${OPENSSL_DIR}")

#
# Beldex
#

set(MINI_BELDEX_COMMON_SRC
  beldex/src/common/aligned.c
  beldex/src/common/base58.cpp
  beldex/src/common/command_line.cpp
  beldex/src/common/download.cpp
  beldex/src/common/dns_utils.cpp
#  beldex/src/common/exp2.cpp
  beldex/src/common/i18n.cpp
  beldex/src/common/beldex.cpp
  beldex/src/common/notify.cpp
  beldex/src/common/password.cpp
  beldex/src/common/pruning.cpp
  beldex/src/common/perf_timer.cpp
  beldex/src/common/util.cpp
  beldex/src/common/round.cpp
  beldex/src/common/rules.cpp
  beldex/src/common/spawn.cpp
  beldex/src/common/updates.cpp
  beldex/src/common/threadpool.cpp
)
add_library(mini_beldex_common ${MINI_BELDEX_COMMON_SRC})
target_link_libraries(mini_beldex_common unbound)

set(MINI_BELDEX_CRYPTO_SRC
  beldex/src/crypto/chacha.c
  beldex/src/crypto/crypto.cpp
  beldex/src/crypto/crypto-ops.c
  beldex/src/crypto/keccak.c
  beldex/src/crypto/tree-hash.c
  beldex/src/crypto/skein.c
  beldex/src/crypto/jh.c
  beldex/src/crypto/groestl.c
  beldex/src/crypto/random.c
  beldex/src/crypto/crypto-ops-data.c
  beldex/src/crypto/hash.c
  beldex/src/crypto/blake256.c
  # FIXME: intel vs arm
  beldex/src/crypto/cn_slow_hash_hard_intel.cpp
  # FIXME: software only support
  beldex/src/crypto/cn_slow_hash_soft.cpp
  # linux needed
  beldex/src/crypto/crypto_ops_builder/verify.c
)
add_library(mini_beldex_crypto ${MINI_BELDEX_CRYPTO_SRC})

set(MINI_BELDEX_DAEMON_SRC
  beldex/src/daemon/daemon.cpp
  beldex/src/daemon/command_server.cpp
  beldex/src/daemon/command_parser_executor.cpp
  beldex/src/daemon/rpc_command_executor.cpp
  beldex/src/daemon/executor.cpp
)
add_library(mini_beldex_daemon ${MINI_BELDEX_DAEMON_SRC})

set(MINI_BELDEX_SERIALIZATION_SRC
  beldex/src/serialization/json_object.cpp
)
add_library(mini_beldex_serialization ${MINI_BELDEX_SERIALIZATION_SRC})
target_link_libraries(mini_beldex_daemon
  ssl crypto
  ${Boost_LIBRARIES}
  mini_beldex_common
)

set(MINI_BELDEX_CN_CORE_SRC
  beldex/src/cryptonote_core/blockchain.cpp
  beldex/src/cryptonote_core/cryptonote_core.cpp
  beldex/src/cryptonote_core/cryptonote_tx_utils.cpp
  beldex/src/cryptonote_core/master_node_quorum_cop.cpp
  beldex/src/cryptonote_core/master_node_list.cpp
  beldex/src/cryptonote_core/master_node_rules.cpp
  beldex/src/cryptonote_core/master_node_deregister.cpp
  beldex/src/cryptonote_core/tx_pool.cpp
)
add_library(mini_beldex_cn_core ${MINI_BELDEX_CN_CORE_SRC})
target_link_libraries(mini_beldex_cn_core
  mini_beldex_ringct
)

set(MINI_BELDEX_CN_BASIC_SRC
  beldex/src/cryptonote_basic/account.cpp
  beldex/src/cryptonote_basic/cryptonote_basic_impl.cpp
  beldex/src/cryptonote_basic/cryptonote_format_utils.cpp
  beldex/src/cryptonote_basic/difficulty.cpp
  beldex/src/cryptonote_basic/hardfork.cpp
  beldex/src/cryptonote_basic/miner.cpp
#  beldex/src/cryptonote_basic/master_node_deregister.cpp
)
add_library(mini_beldex_cn_basic ${MINI_BELDEX_CN_BASIC_SRC})
target_link_libraries(mini_beldex_cn_core mini_beldex_common)

set(MINI_BELDEX_CN_PROTO_SRC
  beldex/src/cryptonote_protocol/cryptonote_protocol_handler-base.cpp
  beldex/src/cryptonote_protocol/block_queue.cpp
  beldex/src/cryptonote_protocol/cryptonote_protocol_handler.inl
)
target_link_libraries(mini_beldex_cn_basic
  mini_beldex_crypto
  mini_beldex_common
)
add_library(mini_beldex_cn_proto ${MINI_BELDEX_CN_PROTO_SRC})

set(MINI_BELDEX_EPEE_SRC
  beldex/contrib/epee/src/buffer.cpp
  beldex/contrib/epee/src/connection_basic.cpp
  beldex/contrib/epee/src/network_throttle-detail.cpp
  beldex/contrib/epee/src/http_auth.cpp
  beldex/contrib/epee/src/hex.cpp
  beldex/contrib/epee/src/memwipe.c
  beldex/contrib/epee/src/mlog.cpp
  beldex/contrib/epee/src/mlocker.cpp
  beldex/contrib/epee/src/network_throttle.cpp
  beldex/contrib/epee/src/net_utils_base.cpp
  beldex/contrib/epee/src/string_tools.cpp
  beldex/contrib/epee/src/wipeable_string.cpp
)
add_library(mini_beldex_epee ${MINI_BELDEX_EPEE_SRC})

# can't call this mini...
set(MINI_BELDEX_UPNP_SRC
  beldex/external/miniupnp/miniupnpc/connecthostport.c
  beldex/external/miniupnp/miniupnpc/igd_desc_parse.c
  beldex/external/miniupnp/miniupnpc/miniupnpc.c
  beldex/external/miniupnp/miniupnpc/minissdpc.c
  beldex/external/miniupnp/miniupnpc/minisoap.c
  beldex/external/miniupnp/miniupnpc/minixml.c
  beldex/external/miniupnp/miniupnpc/miniwget.c
  beldex/external/miniupnp/miniupnpc/portlistingparse.c
  beldex/external/miniupnp/miniupnpc/receivedata.c
  beldex/external/miniupnp/miniupnpc/upnpc.c
  beldex/external/miniupnp/miniupnpc/upnpcommands.c
  beldex/external/miniupnp/miniupnpc/upnpdev.c
  beldex/external/miniupnp/miniupnpc/upnperrors.c
  beldex/external/miniupnp/miniupnpc/upnpreplyparse.c
)
add_library(mini_beldex_upnp ${MINI_BELDEX_UPNP_SRC})

set(MINI_BELDEX_P2P_SRC
  beldex/src/p2p/net_node.inl
  beldex/src/p2p/net_node.cpp
)
add_library(mini_beldex_p2p ${MINI_BELDEX_P2P_SRC})

set(MINI_BELDEX_RINGCT_SRC
  beldex/src/checkpoints/checkpoints.cpp
  beldex/src/device/device.cpp
  beldex/src/device/device_default.cpp
  beldex/src/ringct/bulletproofs.cc
  beldex/src/ringct/rctCryptoOps.c
  beldex/src/ringct/rctSigs.cpp
  beldex/src/ringct/rctOps.cpp
  beldex/src/ringct/rctTypes.cpp
  beldex/src/ringct/multiexp.cc
)
add_library(mini_beldex_ringct ${MINI_BELDEX_RINGCT_SRC})

set(MINI_BELDEX_RPC_SRC
  beldex/src/rpc/core_rpc_server.cpp
  beldex/src/rpc/rpc_args.cpp
  beldex/src/rpc/rpc_handler.cpp
  beldex/src/rpc/daemon_handler.cpp
  beldex/src/rpc/daemon_messages.cpp
  beldex/src/rpc/message.cpp
  beldex/src/rpc/zmq_server.cpp
  beldex/src/rpc/instanciations.cpp
)
add_library(mini_beldex_rpc ${MINI_BELDEX_RPC_SRC})
target_link_libraries(mini_beldex_rpc
  zmq
  ${Boost_LIBRARIES}
  mini_beldex_epee
  mini_beldex_cn_proto
  mini_beldex_upnp
  mini_beldex_p2p
)

set(MINI_BELDEX_SRC
  beldex/src/checkpoints/checkpoints.cpp
#  beldex/src/crypto/slow-hash.c
  beldex/src/blockchain_db/blockchain_db.cpp
  beldex/src/blockchain_db/lmdb/db_lmdb.cpp
  beldex/external/db_drivers/liblmdb/mdb.c
  beldex/external/db_drivers/liblmdb/midl.c
  beldex/external/easylogging++/easylogging++.cc
  beldex/build/release/version.cpp
)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -DAUTO_INITIALIZE_EASYLOGGINGPP")


add_library(mini_beldex ${MINI_BELDEX_SRC})
target_link_libraries(mini_beldex
  mini_beldex_common
  mini_beldex_crypto
  mini_beldex_daemon
  mini_beldex_cn_core
  mini_beldex_cn_basic
  mini_beldex_cn_proto
  mini_beldex_epee
  mini_beldex_upnp
  mini_beldex_rpc
  mini_beldex_serialization
)

#
# Belnet
#

add_subdirectory(belnet)

#
# Launcher
#

set(ABSEIL_DIR belnet/vendor/abseil-cpp)
include_directories(${ABSEIL_DIR})

add_executable(Launcher
  launcher/main.cpp
)
#find_library(MACOS_POWER_LIBRARY IOPowerSources)
target_include_directories (Launcher PUBLIC "belnet/llarp")
target_include_directories (Launcher PUBLIC "belnet/include")
target_include_directories (Launcher PUBLIC "belnet/crypto/include")
target_include_directories (Launcher PUBLIC "belnet/vendor/cppbackport-master/lib")


if (${CMAKE_SYSTEM_NAME} MATCHES "Darwin")
  message(STATUS "MacOS detected")
  TARGET_LINK_LIBRARIES(Launcher
    "-framework IOKit ../src/belnet/build/libbelnet-shared.dylib"
  )
endif()

if (${CMAKE_SYSTEM_NAME} MATCHES "Linux")
  message(STATUS "Linux detected")
  TARGET_LINK_LIBRARIES(Launcher
    "-lpthread"
  )
endif()

target_link_libraries(Launcher ${Boost_LIBRARIES})
TARGET_LINK_LIBRARIES(Launcher
  mini_beldex
)
