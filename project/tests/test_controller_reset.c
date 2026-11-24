/*
 * 리셋·정지 래치 및 동일 호출 갱신 시험.
 * 대상 시험의 기대값은 BL-004의 요구사항 문장과 수용 기준에서 도출했다.
 *
 * 표 기반 시험은 호출마다 상태 구조체를 직접 구성한다.
 * stop_cmd의 시작값은 stop_latch의 시작값과 같게 둔다.
 * 초기 상태 구성은 시험 대상 함수 호출이 아니므로 별도 단계로 세지 않는다.
 * 각 행은 ctl_step 1회 호출이며 단계 번호는 1부터 시작한다.
 *
 * 대상 밖 초기화·입력 유효성·동일 호출 갱신 시험은 유지했다.
 */
#include <float.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>

#include "ears_tc.h"
#include "../src/controller.h"

static int g_failures = 0;

/* @trace-exempt: 시험 결과를 출력하고 실패 횟수를 누적하는 보조 함수이다. */
static void finish(const char *tc, bool ok)
{
    printf("%s %s\n", tc, ok ? "pass" : "fail");
    if (!ok) {
        g_failures++;
    }
}

/* 시험 보조: 출력·내부 상태 신호 하나를 기록하고 기대값과 비교한다. */
static bool ctl01_expect_bool(const char *tc, int step, const char *name, bool got, bool expected)
{
    ears_actual_i(tc, step, name, (long long)got);
    if (got != expected) {
        printf("  %s: step %d %s expected %d, got %d\n", tc, step, name,
               (int)expected, (int)got);
        return false;
    }
    return true;
}

/* 시험 보조: 입력 유효성 판정 결과를 기록하고 기대값과 비교한다. */
static bool ctl01_expect_valid(const char *tc, int step, double temp_c, bool sensor_valid,
                               bool expected)
{
    bool got = ctl_is_input_valid(temp_c, sensor_valid);
    return ctl01_expect_bool(tc, step, "ctl_is_input_valid(반환)", got, expected);
}

typedef struct {
    double temp_c;
    bool sensor_valid;
    bool reset_request;
    bool initial_latch;
    bool initial_fault;
    bool expected;
} ctl_case_t;

/*
 * @trace-exempt: 요구사항에서 도출한 입력 행렬을 실행하는 시험 보조 함수이다.
 * fault_output이 true이면 sensor_fault만, 아니면 stop_latch만 확인한다.
 * 한 행의 실패가 이후 행의 실행을 막지 않는다.
 */
static bool run_cases(const char *tc, const ctl_case_t *cases, size_t count,
                      bool fault_output)
{
    size_t i;
    int step = 1;
    bool ok = true;

    for (i = 0U; i < count; ++i) {
        ctl_state_t s = {
            cases[i].initial_latch,
            cases[i].initial_fault,
            cases[i].initial_latch
        };
        bool got;
        const char *name;

        ctl_step(&s, cases[i].temp_c, cases[i].sensor_valid, cases[i].reset_request);
        if (fault_output) {
            got = s.sensor_fault;
            name = "sensor_fault";
        } else {
            got = s.stop_latch;
            name = "stop_latch";
        }
        ears_actual_i(tc, step, name, (long long)got);
        if (got != cases[i].expected) {
            printf("  %s: 단계=%d %s 기대=%d 실제=%d "
                   "(temp_c=%.17g sensor_valid=%d reset_request=%d "
                   "시작 stop_latch=%d sensor_fault=%d)\n",
                   tc, step, name, (int)cases[i].expected, (int)got,
                   cases[i].temp_c, (int)cases[i].sensor_valid,
                   (int)cases[i].reset_request, (int)cases[i].initial_latch,
                   (int)cases[i].initial_fault);
            ok = false;
        }
        ++step;
    }
    return ok;
}

/* ===================== 유지하는 대상 밖 시험 ===================== */

/* @no-method boundary REQ-CTL-01-1: 초기화에는 수치 임계값이 없다. */

/* @testcase TC-CTL-01-1-001
 * @verifies REQ-CTL-01-1@v1
 * @method requirement
 * 세 멤버가 모두 true 인 상태에서 ctl_init 호출 후 정지 명령, 센서 고장 플래그, 정지 래치가 모두 false */
static void tc_ctl_01_1_001(void)
{
    const char *tc = "TC-CTL-01-1-001";
    ctl_state_t s = { true, true, true };
    bool ok = true;
    ctl_init(&s);
    ok = ctl01_expect_bool(tc, 1, "stop_cmd", s.stop_cmd, false) && ok;
    ok = ctl01_expect_bool(tc, 1, "sensor_fault", s.sensor_fault, false) && ok;
    ok = ctl01_expect_bool(tc, 1, "stop_latch", s.stop_latch, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-1-002
 * @verifies REQ-CTL-01-1@v1
 * @method equivalence, error-guessing
 * 멤버를 하나씩만 true 로 둔 세 초기 상태(각 구간의 대표)에서 ctl_init 호출 후 모두 false */
static void tc_ctl_01_1_002(void)
{
    const char *tc = "TC-CTL-01-1-002";
    ctl_state_t s;
    bool ok = true;

    s.stop_cmd = true;
    s.sensor_fault = false;
    s.stop_latch = false;
    ctl_init(&s);
    ok = ctl01_expect_bool(tc, 1, "stop_cmd", s.stop_cmd, false) && ok;
    ok = ctl01_expect_bool(tc, 1, "sensor_fault", s.sensor_fault, false) && ok;
    ok = ctl01_expect_bool(tc, 1, "stop_latch", s.stop_latch, false) && ok;

    s.stop_cmd = false;
    s.sensor_fault = true;
    s.stop_latch = false;
    ctl_init(&s);
    ok = ctl01_expect_bool(tc, 2, "stop_cmd", s.stop_cmd, false) && ok;
    ok = ctl01_expect_bool(tc, 2, "sensor_fault", s.sensor_fault, false) && ok;
    ok = ctl01_expect_bool(tc, 2, "stop_latch", s.stop_latch, false) && ok;

    s.stop_cmd = false;
    s.sensor_fault = false;
    s.stop_latch = true;
    ctl_init(&s);
    ok = ctl01_expect_bool(tc, 3, "stop_cmd", s.stop_cmd, false) && ok;
    ok = ctl01_expect_bool(tc, 3, "sensor_fault", s.sensor_fault, false) && ok;
    ok = ctl01_expect_bool(tc, 3, "stop_latch", s.stop_latch, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-1-003
 * @verifies REQ-CTL-01-1@v1
 * @method interface, fault-injection
 * 무효 인자 NULL 로 ctl_init 을 불러도 죽지 않고, 이후 정상 상태에 대한 초기화는 그대로 동작한다 */
static void tc_ctl_01_1_003(void)
{
    const char *tc = "TC-CTL-01-1-003";
    ctl_state_t s = { true, true, true };
    bool ok = true;
    ctl_init(NULL);
    ctl_init(&s);
    ok = ctl01_expect_bool(tc, 2, "stop_cmd", s.stop_cmd, false) && ok;
    ok = ctl01_expect_bool(tc, 2, "sensor_fault", s.sensor_fault, false) && ok;
    ok = ctl01_expect_bool(tc, 2, "stop_latch", s.stop_latch, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-3-001
 * @verifies REQ-CTL-01-3@v1
 * @method requirement, equivalence, interface, fault-injection
 * 센서 유효성 플래그 false 이고 온도 25.0 °C 이면 입력 무효 */
static void tc_ctl_01_3_001(void)
{
    const char *tc = "TC-CTL-01-3-001";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, 25.0, false, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-3-002
 * @verifies REQ-CTL-01-3@v1
 * @method boundary, fault-injection
 * 센서 유효성 플래그 false 이면 온도 값과 무관하게 입력 무효: 유효 범위 경계(−40.0, 150.0)와 그 바로 밖(−40.000001, 150.000001),
 * 그리고 NaN, +∞ 에서도 무효 */
static void tc_ctl_01_3_002(void)
{
    const char *tc = "TC-CTL-01-3-002";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, -40.000001, false, false) && ok;
    ok = ctl01_expect_valid(tc, 2, -40.0, false, false) && ok;
    ok = ctl01_expect_valid(tc, 3, 25.0, false, false) && ok;
    ok = ctl01_expect_valid(tc, 4, 150.0, false, false) && ok;
    ok = ctl01_expect_valid(tc, 5, 150.000001, false, false) && ok;
    ok = ctl01_expect_valid(tc, 6, (double)NAN, false, false) && ok;
    ok = ctl01_expect_valid(tc, 7, (double)INFINITY, false, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-4-001
 * @verifies REQ-CTL-01-4@v1
 * @method requirement, fault-injection
 * 센서 유효성 플래그 true 여도 온도가 NaN, +∞, −∞ 이면 입력 무효 */
static void tc_ctl_01_4_001(void)
{
    const char *tc = "TC-CTL-01-4-001";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, (double)NAN, true, false) && ok;
    ok = ctl01_expect_valid(tc, 2, (double)INFINITY, true, false) && ok;
    ok = ctl01_expect_valid(tc, 3, -(double)INFINITY, true, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-4-002
 * @verifies REQ-CTL-01-4@v1
 * @method requirement, equivalence
 * 센서 유효성 플래그 true 여도 온도가 −40.0 °C 미만(대표 −40.1) 또는 150.0 °C 초과(대표 150.1)이면 입력 무효 */
static void tc_ctl_01_4_002(void)
{
    const char *tc = "TC-CTL-01-4-002";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, -40.1, true, false) && ok;
    ok = ctl01_expect_valid(tc, 2, 150.1, true, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-4-003
 * @verifies REQ-CTL-01-4@v1
 * @method boundary, interface
 * 범위 경계 바로 밖(−40.000001, 150.000001)과 double 의 최대·최소 유한값(±DBL_MAX)은 플래그 true 여도 입력 무효 */
static void tc_ctl_01_4_003(void)
{
    const char *tc = "TC-CTL-01-4-003";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, -40.000001, true, false) && ok;
    ok = ctl01_expect_valid(tc, 2, 150.000001, true, false) && ok;
    ok = ctl01_expect_valid(tc, 3, -DBL_MAX, true, false) && ok;
    ok = ctl01_expect_valid(tc, 4, DBL_MAX, true, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-5-001
 * @verifies REQ-CTL-01-5@v1
 * @method requirement, equivalence, interface
 * 센서 유효성 플래그 true, 온도 25.0 °C(유효 구간의 대표값)이면 입력 유효 */
static void tc_ctl_01_5_001(void)
{
    const char *tc = "TC-CTL-01-5-001";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, 25.0, true, true) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-5-002
 * @verifies REQ-CTL-01-5@v1
 * @method boundary, interface
 * 플래그 true 에서 유효 범위 경계 −40.0 °C, 150.0 °C 와 그 바로 안쪽(−39.999999, 149.999999)은 입력 유효 */
static void tc_ctl_01_5_002(void)
{
    const char *tc = "TC-CTL-01-5-002";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, -40.0, true, true) && ok;
    ok = ctl01_expect_valid(tc, 2, 150.0, true, true) && ok;
    ok = ctl01_expect_valid(tc, 3, -39.999999, true, true) && ok;
    ok = ctl01_expect_valid(tc, 4, 149.999999, true, true) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-5-003
 * @verifies REQ-CTL-01-5@v1
 * @method boundary
 * 플래그 true 에서 유효 범위 경계 바로 밖(−40.000001, 150.000001)은 세 조건 중 하나가 불충족이므로 입력 유효가 아님 */
static void tc_ctl_01_5_003(void)
{
    const char *tc = "TC-CTL-01-5-003";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, -40.000001, true, false) && ok;
    ok = ctl01_expect_valid(tc, 2, 150.000001, true, false) && ok;
    finish(tc, ok);
}

/* @testcase TC-CTL-01-5-004
 * @verifies REQ-CTL-01-5@v1
 * @method error-guessing, fault-injection
 * 세 조건 각각을 하나씩만 불충족: 플래그 false(25.0 °C), NaN(플래그 true), +∞ 와 −∞(플래그 true)는 모두 입력 유효가 아님 */
static void tc_ctl_01_5_004(void)
{
    const char *tc = "TC-CTL-01-5-004";
    bool ok = true;
    ok = ctl01_expect_valid(tc, 1, 25.0, false, false) && ok;
    ok = ctl01_expect_valid(tc, 2, (double)NAN, true, false) && ok;
    ok = ctl01_expect_valid(tc, 3, (double)INFINITY, true, false) && ok;
    ok = ctl01_expect_valid(tc, 4, -(double)INFINITY, true, false) && ok;
    finish(tc, ok);
}

/* ===================== 묶음 실행 ===================== */

/*
 * @no-method boundary REQ-CTL-01-2: 동일 호출 내 갱신이라는 요구에는 수치 임계값이 없다. 온도 경계와 자료형 극값은 나머지 대상 요구사항의 시험에서 다룬다.
 *
 * 래치 시험의 반대 조건 기대값은 같은 Baseline의 입력 유효성 규칙,
 * 래치 유지 규칙과 리셋 규칙을 함께 적용한다.
 * REQ-CTL-01-6의 유효 입력 대조군은 REQ-CTL-01-7의 고장 해제 규칙을 따른다.
 * NULL 호출은 기존 인터페이스 시험을 유지한 것이며 장비 응답 시간 시험이 아니다.
 * 표 기반 시험의 경계 간격은 수용 기준과 같은 0.1 °C를 사용한다.
 * DBL_MIN은 가장 작은 양의 정규값이며 음의 최솟값은 -DBL_MAX로 별도 시험한다.
 */

int ears_suite_controller_reset(void);

int ears_suite_controller_reset(void)
{
    g_failures = 0;

    /* @testcase TC-CTL-01-2-001
     * @verifies REQ-CTL-01-2@v1
     * @method requirement, equivalence, interface, fault-injection
     * 초기화 후 무효 입력 1회 호출 직후 출력과 두 내부 상태를 확인한다. */
    if (ears_tc_selected("TC-CTL-01-2-001")) {
        const char *tc = "TC-CTL-01-2-001";
        ctl_state_t s;
        bool ok = true;

        ctl_init(&s);
        ctl_step(&s, 20.0, false, false);
        ok = ctl01_expect_bool(tc, 2, "stop_cmd", s.stop_cmd, true) && ok;
        ok = ctl01_expect_bool(tc, 2, "sensor_fault", s.sensor_fault, true) && ok;
        ok = ctl01_expect_bool(tc, 2, "stop_latch", s.stop_latch, true) && ok;
        finish(tc, ok);
    }

    /* @testcase TC-CTL-01-2-002
     * @verifies REQ-CTL-01-2@v1
     * @method requirement, equivalence, interface, error-guessing
     * 과열 활성화 다음 호출에서 냉각·리셋 입력이 지연 없이 반영되는지 확인한다. */
    if (ears_tc_selected("TC-CTL-01-2-002")) {
        const char *tc = "TC-CTL-01-2-002";
        ctl_state_t s;
        bool ok = true;

        ctl_init(&s);
        ctl_step(&s, 80.0, true, false);
        ok = ctl01_expect_bool(tc, 2, "stop_cmd", s.stop_cmd, true) && ok;
        ok = ctl01_expect_bool(tc, 2, "sensor_fault", s.sensor_fault, false) && ok;
        ok = ctl01_expect_bool(tc, 2, "stop_latch", s.stop_latch, true) && ok;

        ctl_step(&s, 25.0, true, true);
        ok = ctl01_expect_bool(tc, 3, "stop_cmd", s.stop_cmd, false) && ok;
        ok = ctl01_expect_bool(tc, 3, "sensor_fault", s.sensor_fault, false) && ok;
        ok = ctl01_expect_bool(tc, 3, "stop_latch", s.stop_latch, false) && ok;
        finish(tc, ok);
    }

    /* @testcase TC-CTL-01-2-003
     * @verifies REQ-CTL-01-2@v1
     * @method interface, fault-injection
     * NULL 호출 후 정상 포인터 호출의 출력·상태를 확인한다. */
    if (ears_tc_selected("TC-CTL-01-2-003")) {
        const char *tc = "TC-CTL-01-2-003";
        ctl_state_t s;
        bool ok = true;

        ctl_init(&s);
        ctl_step(NULL, 25.0, true, false);
        ctl_step(&s, 25.0, true, false);
        ok = ctl01_expect_bool(tc, 3, "stop_cmd", s.stop_cmd, false) && ok;
        ok = ctl01_expect_bool(tc, 3, "sensor_fault", s.sensor_fault, false) && ok;
        ok = ctl01_expect_bool(tc, 3, "stop_latch", s.stop_latch, false) && ok;
        finish(tc, ok);
    }

    /* @testcase TC-CTL-01-6-001
     * @verifies REQ-CTL-01-6@v1
     * @method requirement, equivalence, boundary, interface, fault-injection, error-guessing
     * 무효 원인별 고장 설정과 경계의 유효 대조군, 자료형 극값을 확인한다. */
    if (ears_tc_selected("TC-CTL-01-6-001")) {
        static const ctl_case_t cases[] = {
            { 25.0,              false, false, false, false, true  },
            { (double)NAN,       true,  false, false, false, true  },
            { (double)INFINITY,  true,  false, false, false, true  },
            { -(double)INFINITY, true,  false, false, false, true  },
            { -40.1,             true,  false, false, false, true  },
            { -40.0,             true,  false, false, true,  false },
            { -39.9,             true,  false, false, true,  false },
            { 149.9,             true,  false, false, true,  false },
            { 150.0,             true,  false, false, true,  false },
            { 150.1,             true,  false, false, false, true  },
            { -DBL_MAX,          true,  false, false, false, true  },
            { DBL_MAX,           true,  false, false, false, true  },
            { DBL_MIN,           true,  false, false, true,  false },
            { 0.0,               true,  false, false, true,  false },
            { 25.0,              false, true,  true,  true,  true  }
        };
        finish("TC-CTL-01-6-001",
               run_cases("TC-CTL-01-6-001", cases,
                         sizeof cases / sizeof cases[0], true));
    }

    /* @testcase TC-CTL-03-1-001
     * @verifies REQ-CTL-03-1@v2
     * @method requirement, equivalence, boundary, interface, fault-injection, error-guessing
     * 해제 수용 기준(69.9, −40.0 해제, 70.0 유지), 리셋·유효성 조건의 독립 영향 및 극값을 확인한다. */
    if (ears_tc_selected("TC-CTL-03-1-001")) {
        static const ctl_case_t cases[] = {
            { 69.9,     true,  true,  true,  false, false },
            { -40.0,    true,  true,  true,  false, false },
            { 70.0,     true,  true,  true,  false, true  },
            { 70.1,     true,  true,  true,  false, true  },
            { 25.0,     true,  true,  true,  false, false },
            { 25.0,     true,  false, true,  false, true  },
            { 25.0,     false, true,  true,  false, true  },
            { -39.9,    true,  true,  true,  false, false },
            { -DBL_MAX, true,  true,  true,  false, true  },
            { DBL_MAX,  true,  true,  true,  false, true  },
            { DBL_MIN,  true,  true,  true,  false, false },
            { 69.9,     true,  true,  false, false, false },
            { -40.1,    true,  true,  true,  false, true  }
        };
        finish("TC-CTL-03-1-001",
               run_cases("TC-CTL-03-1-001", cases,
                         sizeof cases / sizeof cases[0], false));
    }

    /* @testcase TC-CTL-03-2-001
     * @verifies REQ-CTL-03-2@v2
     * @method requirement, equivalence, boundary, interface, fault-injection
     * 유지 수용 기준(70.0, 70.1, 74.9, 150.0)과 리셋 요청 양쪽 값, 경계 반대편 및 고장 대조군을 확인한다. */
    if (ears_tc_selected("TC-CTL-03-2-001")) {
        static const ctl_case_t cases[] = {
            { 70.0,     true,  true,  true, false, true  },
            { 70.1,     true,  true,  true, false, true  },
            { 74.9,     true,  true,  true, false, true  },
            { 150.0,    true,  true,  true, false, true  },
            { 72.5,     true,  true,  true, false, true  },
            { 100.0,    true,  true,  true, false, true  },
            { 70.0,     true,  false, true, false, true  },
            { 150.0,    true,  false, true, false, true  },
            { 80.0,     false, true,  true, false, true  },
            { -DBL_MAX, true,  true,  true, false, true  },
            { DBL_MAX,  true,  true,  true, false, true  },
            { 69.9,     true,  true,  true, false, false },
            { 149.9,    true,  true,  true, false, true  },
            { 150.1,    true,  true,  true, false, true  }
        };
        finish("TC-CTL-03-2-001",
               run_cases("TC-CTL-03-2-001", cases,
                         sizeof cases / sizeof cases[0], false));
    }

    /* @testcase TC-CTL-03-3-001
     * @verifies REQ-CTL-03-3@v1
     * @method requirement, equivalence, boundary, interface, fault-injection, error-guessing
     * 무효 입력의 각 원인(플래그 false, NaN 등)과 중첩, 리셋 요청 양쪽 값 및 유효 경계 대조군을 확인한다. */
    if (ears_tc_selected("TC-CTL-03-3-001")) {
        static const ctl_case_t cases[] = {
            { 20.0,              false, true,  true, false, true  },
            { (double)NAN,       true,  true,  true, false, true  },
            { (double)INFINITY,  true,  true,  true, false, true  },
            { -(double)INFINITY, true,  true,  true, false, true  },
            { -40.1,             true,  true,  true, false, true  },
            { 150.1,             true,  true,  true, false, true  },
            { 20.0,              false, false, true, false, true  },
            { (double)NAN,       true,  false, true, false, true  },
            { (double)NAN,       false, true,  true, false, true  },
            { -DBL_MAX,          true,  true,  true, false, true  },
            { DBL_MAX,           true,  true,  true, false, true  },
            { -40.0,             true,  true,  true, false, false },
            { 150.0,             true,  true,  true, false, true  },
            { -39.9,             true,  true,  true, false, false },
            { 149.9,             true,  true,  true, false, true  },
            { (double)INFINITY,  true,  false, true, false, true  },
            { -(double)INFINITY, true,  false, true, false, true  },
            { -40.1,             true,  false, true, false, true  },
            { 150.1,             true,  false, true, false, true  }
        };
        finish("TC-CTL-03-3-001",
               run_cases("TC-CTL-03-3-001", cases,
                         sizeof cases / sizeof cases[0], false));
    }

    /* @testcase TC-CTL-03-4-001
     * @verifies REQ-CTL-03-4@v1
     * @method requirement, equivalence, boundary, interface, fault-injection, error-guessing
     * 리셋과 과열(75.0 °C 이상)·무효 입력의 동시 발생 시 활성화 우선순위를 확인한다.
     * 시작 래치가 비활성인 경우와 활성인 경우를 모두 포함한다.
     * 74.9 °C의 비활성 시작 대조군은 TC-CTL-03-4-003에서 확인한다. */
    if (ears_tc_selected("TC-CTL-03-4-001")) {
        static const ctl_case_t cases[] = {
            { 75.0,              true,  true, false, false, true  },
            { 20.0,              false, true, false, false, true  },
            { 75.1,              true,  true, false, false, true  },
            { (double)NAN,       true,  true, false, false, true  },
            { (double)INFINITY,  true,  true, false, false, true  },
            { -(double)INFINITY, true,  true, false, false, true  },
            { 100.0,             true,  true, false, false, true  },
            { 150.0,             true,  true, false, false, true  },
            { -40.1,             true,  true, false, false, true  },
            { 150.1,             true,  true, false, false, true  },
            { -DBL_MAX,          true,  true, false, false, true  },
            { DBL_MAX,           true,  true, false, false, true  },
            { 69.9,              true,  true, false, false, false },
            { 74.9,              true,  true, true,  false, true  },
            { -40.0,             true,  true, false, false, false },
            { -39.9,             true,  true, false, false, false },
            { 149.9,             true,  true, false, false, true  },
            { 75.0,              true,  true, true,  false, true  },
            { 20.0,              false, true, true,  false, true  },
            { 150.0,             true,  true, true,  false, true  }
        };
        finish("TC-CTL-03-4-001",
               run_cases("TC-CTL-03-4-001", cases,
                         sizeof cases / sizeof cases[0], false));
    }

    /* @testcase TC-CTL-03-4-003
     * @verifies REQ-CTL-03-4@v1
     * @method requirement, equivalence, boundary, interface
     * 비활성 시작·유효 74.9 °C·리셋 요청이면 래치는 비활성이다. 75.0 미만이므로
     * 이 호출에서 새로 활성화하지 않는다는 REQ-CTL-02-4@v2 의 기준과 일치한다.
     * 75.0 °C와 75.1 °C는 TC-CTL-03-4-001에서 확인한다. */
    if (ears_tc_selected("TC-CTL-03-4-003")) {
        static const ctl_case_t cases[] = {
            { 74.9, true, true, false, false, false }
        };
        finish("TC-CTL-03-4-003",
               run_cases("TC-CTL-03-4-003", cases,
                         sizeof cases / sizeof cases[0], false));
    }

    if (ears_tc_selected("TC-CTL-01-1-001")) { tc_ctl_01_1_001(); }
    if (ears_tc_selected("TC-CTL-01-1-002")) { tc_ctl_01_1_002(); }
    if (ears_tc_selected("TC-CTL-01-1-003")) { tc_ctl_01_1_003(); }
    if (ears_tc_selected("TC-CTL-01-3-001")) { tc_ctl_01_3_001(); }
    if (ears_tc_selected("TC-CTL-01-3-002")) { tc_ctl_01_3_002(); }
    if (ears_tc_selected("TC-CTL-01-4-001")) { tc_ctl_01_4_001(); }
    if (ears_tc_selected("TC-CTL-01-4-002")) { tc_ctl_01_4_002(); }
    if (ears_tc_selected("TC-CTL-01-4-003")) { tc_ctl_01_4_003(); }
    if (ears_tc_selected("TC-CTL-01-5-001")) { tc_ctl_01_5_001(); }
    if (ears_tc_selected("TC-CTL-01-5-002")) { tc_ctl_01_5_002(); }
    if (ears_tc_selected("TC-CTL-01-5-003")) { tc_ctl_01_5_003(); }
    if (ears_tc_selected("TC-CTL-01-5-004")) { tc_ctl_01_5_004(); }

    return (g_failures == 0) ? 0 : 1;
}
