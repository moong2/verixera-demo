/*
 * 시험 묶음: REQ-CTL-01-7, REQ-CTL-01-8 (센서 고장 플래그 갱신)
 *
 * 기대 결과는 요구사항 문장과 수용 기준에서만 정했다. 구현 코드(src 의 .c 파일)는 보지 않았다.
 * 입력 신호 이름과 단위는 신호 표(BL-002)를 따른다: temp_c [°C], sensor_valid, reset_request.
 * 출력으로 확인하는 신호는 sensor_fault 이다(상태 구조체 멤버로 관찰).
 * 직전 호출의 무효 여부는 제어기 상태에 따로 저장되지 않는다. 그래서 직전 호출이
 * 무효였음은 REQ-CTL-01-6 에 따라 sensor_fault == true 로 먼저 확인한 뒤 다음 호출을 한다.
 * 정지 래치가 비활성인 조합은 무효 호출 뒤에는 ctl_step 만으로 만들 수 없으므로
 * (REQ-CTL-02-2), 해당 시험은 호출 사이에 stop_latch 를 직접 false 로 설정한다.
 */
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include "ears_tc.h"
#include "controller.h"

/* @no-method interface REQ-CTL-01-7: NULL 인자 동작과 자료형 범위는 설계 인터페이스 절에만 있고 수용 기준에 없어 이 요구사항의 기대값으로 정할 수 없다. 질문으로 돌린다. */
/* @no-method interface REQ-CTL-01-8: NULL 인자 동작과 자료형 범위는 설계 인터페이스 절에만 있고 수용 기준에 없어 이 요구사항의 기대값으로 정할 수 없다. 질문으로 돌린다. */

static void report(const char *tc, int ok, int *fails)
{
    printf("%s %s\n", tc, ok ? "pass" : "fail");
    if (!ok) {
        (*fails)++;
    }
}

static void check_fault(const char *tc, int step, const ctl_state_t *s, bool expected, int *ok)
{
    ears_actual_i(tc, step, "sensor_fault", s->sensor_fault ? 1LL : 0LL);
    if (s->sensor_fault != expected) {
        printf("  %s: step %d expected sensor_fault=%d, got=%d\n",
               tc, step, expected ? 1 : 0, s->sensor_fault ? 1 : 0);
        *ok = 0;
    }
}

int ears_suite_ctl_01(void);

int ears_suite_ctl_01(void)
{
    int fails = 0;

    /* @testcase TC-CTL-01-7-001
     * @verifies REQ-CTL-01-7@v1
     * @method requirement, equivalence
     * 직전 호출 무효(센서 고장 플래그 true) 후 온도 25.0 °C 의 유효 입력 → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-7-001")) {
        const char *tc = "TC-CTL-01-7-001";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, 25.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-7-002
     * @verifies REQ-CTL-01-7@v1
     * @method boundary
     * 유효 입력의 하한 경계 -40.0 °C → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-7-002")) {
        const char *tc = "TC-CTL-01-7-002";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, -40.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-7-003
     * @verifies REQ-CTL-01-7@v1
     * @method boundary
     * 유효 입력의 상한 경계 150.0 °C → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-7-003")) {
        const char *tc = "TC-CTL-01-7-003";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, 150.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-7-004
     * @verifies REQ-CTL-01-7@v1
     * @method fault-injection, error-guessing
     * 직전 호출이 온도 NaN 으로 무효(센서 고장 플래그 true)인 뒤 유효 입력 → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-7-004")) {
        const char *tc = "TC-CTL-01-7-004";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, NAN, true, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, 25.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-7-005
     * @verifies REQ-CTL-01-7@v1
     * @method error-guessing, equivalence
     * 직전 호출이 상한 초과 150.5 °C 로 무효인 뒤 유효 입력 25.0 °C → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-7-005")) {
        const char *tc = "TC-CTL-01-7-005";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 150.5, true, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, 25.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-7-006
     * @verifies REQ-CTL-01-7@v1
     * @method requirement, equivalence
     * 직전 무효 후 유효 입력이면 리셋 요청이 있어도 센서 고장 플래그 false (판정은 입력 유효성만으로 정해짐) */
    if (ears_tc_selected("TC-CTL-01-7-006")) {
        const char *tc = "TC-CTL-01-7-006";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, 25.0, true, true);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-8-001
     * @verifies REQ-CTL-01-8@v1
     * @method requirement, equivalence
     * 직전 호출 무효(센서 고장 플래그 true, 정지 래치 활성) 후 현재 유효 입력 → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-8-001")) {
        const char *tc = "TC-CTL-01-8-001";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, 25.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-8-002
     * @verifies REQ-CTL-01-8@v1
     * @method requirement
     * 직전 무효, 현재 유효, 정지 래치 비활성(호출 사이에 직접 설정) → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-8-002")) {
        const char *tc = "TC-CTL-01-8-002";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        s.stop_latch = false; /* 사전 상태: 정지 래치 비활성 */
        ctl_step(&s, 25.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-8-003
     * @verifies REQ-CTL-01-8@v1
     * @method boundary
     * 직전 상한 초과 150.5 °C 로 무효, 현재 상한 경계 150.0 °C 로 유효 (래치 활성) → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-8-003")) {
        const char *tc = "TC-CTL-01-8-003";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 150.5, true, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, 150.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-8-004
     * @verifies REQ-CTL-01-8@v1
     * @method boundary, fault-injection
     * 직전 온도 NaN 으로 무효, 현재 하한 경계 -40.0 °C 로 유효 (래치 비활성, 호출 사이에 직접 설정) → 센서 고장 플래그 false */
    if (ears_tc_selected("TC-CTL-01-8-004")) {
        const char *tc = "TC-CTL-01-8-004";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, NAN, true, false);
        check_fault(tc, 2, &s, true, &ok);
        s.stop_latch = false; /* 사전 상태: 정지 래치 비활성 */
        ctl_step(&s, -40.0, true, false);
        check_fault(tc, 3, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-8-005
     * @verifies REQ-CTL-01-8@v1
     * @method fault-injection
     * 무효 → 무효(NaN) → 유효 순서의 입력 열: 무효 구간은 고장 플래그 true, 마지막 유효 호출에서 false */
    if (ears_tc_selected("TC-CTL-01-8-005")) {
        const char *tc = "TC-CTL-01-8-005";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, NAN, true, false);
        check_fault(tc, 3, &s, true, &ok);
        ctl_step(&s, 25.0, true, false);
        check_fault(tc, 4, &s, false, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-8-006
     * @verifies REQ-CTL-01-8@v1
     * @method error-guessing
     * 직전 무효 후 현재도 무효(센서 유효성 플래그 False): 현재 입력이 유효하지 않으므로 센서 고장 플래그는 true 를 유지 */
    if (ears_tc_selected("TC-CTL-01-8-006")) {
        const char *tc = "TC-CTL-01-8-006";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 3, &s, true, &ok);
        report(tc, ok, &fails);
    }

    /* @testcase TC-CTL-01-8-007
     * @verifies REQ-CTL-01-8@v1
     * @method boundary, error-guessing
     * 직전 무효 후 하한 바로 아래 -40.5 °C (무효 입력) → 센서 고장 플래그 true 유지 */
    if (ears_tc_selected("TC-CTL-01-8-007")) {
        const char *tc = "TC-CTL-01-8-007";
        ctl_state_t s;
        int ok = 1;
        ctl_init(&s);
        ctl_step(&s, 25.0, false, false);
        check_fault(tc, 2, &s, true, &ok);
        ctl_step(&s, -40.5, true, false);
        check_fault(tc, 3, &s, true, &ok);
        report(tc, ok, &fails);
    }

    return fails ? 1 : 0;
}
