#pragma once
#include <cstdio>
#include <cstdlib>
#ifdef QSB_SSL_TEST
#include <set>
inline bool qsb_ssl_fail(int line){
 static std::set<int> seen;
 if(seen.insert(line).second)std::fprintf(stderr,"SSL_SITE %d\n",line);
 const char *fail=std::getenv("QSB_SSL_TEST_FAIL_LINE");
 return fail&&std::atoi(fail)==line;
}
#define QSB_SSL_EVAL(expr) (qsb_ssl_fail(__LINE__)?decltype(expr){}:(expr))
#else
#define QSB_SSL_EVAL(expr) (expr)
#endif
inline void qsb_ssl_require(bool ok){if(!ok){std::fprintf(stderr,"QSB_RANGE_INCOMPLETE: OpenSSL table operation failed\n");std::exit(2);}}
// Expression executes once. Diagnostic injection is absent from release builds.
#define QSB_SSL_PTR(expr) ([&](){auto value=QSB_SSL_EVAL(expr);qsb_ssl_require(value!=nullptr);return value;}())
#define QSB_SSL_OK(expr) ([&](){auto value=QSB_SSL_EVAL(expr);qsb_ssl_require(value==1);return value;}())
#define QSB_SSL_SIZE(expr,size) ([&](){auto value=QSB_SSL_EVAL(expr);qsb_ssl_require(value==(size));return value;}())
