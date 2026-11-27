/* EARS Requirements Writer 가 넣는 도우미 — TC 하나씩 실행하기.
 * 환경 변수 EARS_TC 에 TC ID 를 쉼표로 적으면 그 TC 만 실행하고, 비어 있으면 모두 실행한다.
 * 시험 코드에서: if (ears_tc_selected("TC-OTP-01-1-001")) { ... 이 TC ... }
 * 단계마다 실제 출력: ears_actual_i(tc, 단계, "신호", 값) / ears_actual_f(...) — 앱이 읽어 절차표의 '실제 출력' 칸에 보인다(판정에는 쓰지 않음).
 * (도우미 v2)
 */
#ifndef EARS_TC_H
#define EARS_TC_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static inline int ears_tc_selected(const char *id)
{
    const char *want = getenv("EARS_TC");
    const char *p;
    size_t n;
    if ((want == NULL) || (want[0] == '\0')) {
        return 1;
    }
    n = strlen(id);
    p = want;
    while ((p = strstr(p, id)) != NULL) {
        const int start_ok = (p == want) || (p[-1] == ',');
        const int end_ok = (p[n] == '\0') || (p[n] == ',');
        if (start_ok && end_ok) {
            return 1;
        }
        p += n;
    }
    return 0;
}

/* 단계(1부터, 절차표 steps 의 순서)마다 시험 대상의 실제 출력값을 한 줄씩 찍는다. */
static inline void ears_actual_i(const char *tc, int step, const char *name, long long value)
{
    (void)printf("EARS_ACTUAL %s %d %s=%lld\n", tc, step, name, value);
}

static inline void ears_actual_f(const char *tc, int step, const char *name, double value)
{
    (void)printf("EARS_ACTUAL %s %d %s=%.6g\n", tc, step, name, value);
}

#endif
