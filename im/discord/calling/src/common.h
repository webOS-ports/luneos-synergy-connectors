// common.h — shared helpers for the Discord voice client (webOS/ARMv7 foundation).
//
// Small, dependency-free utilities used across every layer: logging, a byte-vector
// alias, hex dump, monotonic-ms clock. Kept header-only on purpose.
#pragma once

#include <cstdint>
#include <cstdio>
#include <cstdarg>
#include <ctime>
#include <string>
#include <vector>

namespace dv {

using Bytes = std::vector<uint8_t>;

inline uint64_t now_ms() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)ts.tv_nsec / 1000000ull;
}

// Single logging entry point so on-device runs get one greppable prefix ("dvoice:").
inline void logf(const char* level, const char* fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    fprintf(stderr, "dvoice[%s]: %s\n", level, buf);
}

#define DV_INFO(...)  ::dv::logf("info", __VA_ARGS__)
#define DV_WARN(...)  ::dv::logf("warn", __VA_ARGS__)
#define DV_ERR(...)   ::dv::logf("err",  __VA_ARGS__)

inline std::string hex(const uint8_t* p, size_t n, size_t max = 32) {
    static const char* h = "0123456789abcdef";
    std::string s;
    size_t lim = n < max ? n : max;
    for (size_t i = 0; i < lim; ++i) {
        s.push_back(h[p[i] >> 4]);
        s.push_back(h[p[i] & 0xf]);
    }
    if (n > max) s += "..";
    return s;
}

} // namespace dv
