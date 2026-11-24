/*
 * BL-004 기준 정지 래치 시험.
 * 기대값은 승인된 요구사항과 수용 기준에서만 도출했다.
 * 구현 파일은 참조하지 않았다.
 *
 * REQ-CTL-02-1@v2 는 감지 센서 활성 여부와 무관하게 래치를 활성화하므로,
 * 이 요구사항의 시험은 detect_active 를 받는 ctl_step_detect 로 실행하고
 * detect_active 를 false 와 true 로 나누어 입력한다.
 * 나머지 요구사항(02-2, 02-3, 02-4)의 시험은 기존 ctl_step 으로 실행한다.
 *
 * 입력 유효성의 정의는 같은 Baseline의 REQ-CTL-01-3 ~
 * REQ-CTL-01-5를 따른다. 해제 허용 조건에서 실제 해제되는 값은
 * 같은 Baseline의 REQ-CTL-03-1@v2에 따른다.
 * 참고 요구사항을 별도 검증하는 추적 링크는 추가하지 않는다.
 *
 * 경계 인접값은 double 경계에 인접하는 십진 상수로 지정한다.
 * 자료형의 유한 최솟값과 최댓값은 -DBL_MAX와 DBL_MAX로 주입한다.
 * NaN과 양수 및 음수 무한대도 별도로 주입한다.
 *
 * @no-method fault-injection REQ-CTL-02-4: 유지 의무가 유효 입력에만 적용된다. 무효 입력의 안전 동작은 REQ-CTL-02-2 시험에서 확인한다.
 *
 * NULL 상태 포인터의 동작은 헤더에만 있고 승인된 요구사항의
 * 수용 기준에는 없으므로 기대값을 추측하여 시험하지 않는다.
 * 유효성 판정 함수 자체는 이번 시험 대상이 아니다.
 * 분기 커버리지와 MC/DC 달성을 실행 없이 주장하지 않는다.
 */
#include <float.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>

#include "ears_tc.h"
#include "../src/controller.h"

int ears_suite_ctl_02(void);

/*
 * @trace-exempt: 선택된 시험의 공통 실행, 관측 및 판정 절차이다.
 * 초기화는 1단계이다. 활성 상태 준비가 필요하면 2단계에서
 * 유효 80도를 넣어 래치를 확인한다. 마지막 단계에서 시험 입력을
 * 넣고 동일 호출의 래치 값을 확인한다.
 * use_detect 가 true 이면 ctl_step_detect 를 detect_active 와 함께 부르고,
 * false 이면 ctl_step 을 부른다.
 */
static int run_core(const char *tc, bool prepare_active,
                    double temp_c, bool sensor_valid, bool reset_request,
                    bool use_detect, bool detect_active,
                    bool expected)
{
    ctl_state_t state;
    bool prepared = true;
    bool actual;
    int step = 2;
    int failed;

    ctl_init(&state);

    if (prepare_active) {
        ctl_step(&state, 80.0, true, false);
        prepared = state.stop_latch;
        ears_actual_i(tc, 2, "stop_latch", (long long)prepared);
        step = 3;
    }

    if (use_detect) {
        ctl_step_detect(&state, temp_c, sensor_valid, reset_request,
                        detect_active);
    } else {
        ctl_step(&state, temp_c, sensor_valid, reset_request);
    }
    actual = state.stop_latch;
    ears_actual_i(tc, step, "stop_latch", (long long)actual);

    failed = (!prepared || actual != expected) ? 1 : 0;
    if (failed != 0) {
        printf("  %s: expected stop_latch=%d, got=%d; "
               "prepare_active=%d, expected_prepared_stop_latch=%d, "
               "prepared_stop_latch=%d; "
               "temp_c=%.17g, sensor_valid=%d, reset_request=%d, "
               "use_detect=%d, detect_active=%d\n",
               tc, (int)expected, (int)actual,
               (int)prepare_active, (int)prepare_active, (int)prepared,
               temp_c, (int)sensor_valid, (int)reset_request,
               (int)use_detect, (int)detect_active);
    }
    printf("%s %s\n", tc, failed != 0 ? "fail" : "pass");
    return failed;
}

/* @trace-exempt: ctl_step 을 사용하는 시험 실행 보조 함수이다. */
static int run_case(const char *tc, bool prepare_active,
                    double temp_c, bool sensor_valid, bool reset_request,
                    bool expected)
{
    return run_core(tc, prepare_active, temp_c, sensor_valid, reset_request,
                    false, false, expected);
}

/* @trace-exempt: ctl_step_detect 를 사용하는 시험 실행 보조 함수이다. */
static int run_detect(const char *tc, bool prepare_active,
                      double temp_c, bool sensor_valid, bool reset_request,
                      bool detect_active, bool expected)
{
    return run_core(tc, prepare_active, temp_c, sensor_valid, reset_request,
                    true, detect_active, expected);
}

/* @trace-exempt: 앱이 호출하는 시험 묶음 진입점이다. */
int ears_suite_ctl_02(void)
{
    int bad = 0;

    /* @testcase TC-CTL-02-1-001
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, boundary, interface
     * 감지 센서 비활성, 유효 75도에서 동일 호출에 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-1-001")) {
        bad |= run_detect("TC-CTL-02-1-001", false, 75.0, true, false,
                          false, true);
    }

    /* @testcase TC-CTL-02-1-002
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, interface
     * 유효 74.9도, 리셋 없음에서 이 요구로는 활성화되지 않는다. */
    if (ears_tc_selected("TC-CTL-02-1-002")) {
        bad |= run_detect("TC-CTL-02-1-002", false, 74.9, true, false,
                          false, false);
    }

    /* @testcase TC-CTL-02-1-003
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, boundary, interface
     * 75도의 바로 위에서 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-1-003")) {
        bad |= run_detect("TC-CTL-02-1-003", false,
                          75.00000000000001, true, false, false, true);
    }

    /* @testcase TC-CTL-02-1-004
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, boundary, interface
     * 유효 상한 150도에서 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-1-004")) {
        bad |= run_detect("TC-CTL-02-1-004", false, 150.0, true, false,
                          false, true);
    }

    /* @testcase TC-CTL-02-1-005
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, fault-injection, interface
     * 고온과 센서 무효가 겹쳐도 안전 쪽으로 활성화한다.
     * 무효 입력의 기대값은 REQ-CTL-02-2 에 따른다. */
    if (ears_tc_selected("TC-CTL-02-1-005")) {
        bad |= run_detect("TC-CTL-02-1-005", false, 80.0, false, false,
                          false, true);
    }

    /* @testcase TC-CTL-02-1-006
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, boundary, interface
     * 75도의 바로 아래이며 리셋이 없으면 비활성이다. */
    if (ears_tc_selected("TC-CTL-02-1-006")) {
        bad |= run_detect("TC-CTL-02-1-006", false,
                          74.99999999999999, true, false, false, false);
    }

    /* @testcase TC-CTL-02-1-007
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, interface, error-guessing
     * 리셋 요청과 과열이 동시에 들어와도 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-1-007")) {
        bad |= run_detect("TC-CTL-02-1-007", false, 75.0, true, true,
                          false, true);
    }

    /* @testcase TC-CTL-02-1-008
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, boundary, interface
     * 감지 센서 활성, 유효 75도에서 동일 호출에 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-1-008")) {
        bad |= run_detect("TC-CTL-02-1-008", false, 75.0, true, false,
                          true, true);
    }

    /* @testcase TC-CTL-02-1-009
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, boundary, interface
     * 감지 센서 활성, 유효 150도에서 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-1-009")) {
        bad |= run_detect("TC-CTL-02-1-009", false, 150.0, true, false,
                          true, true);
    }

    /* @testcase TC-CTL-02-1-010
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, interface
     * 감지 센서 활성이어도 유효 74.9도이면 이 요구로는 활성화되지 않는다. */
    if (ears_tc_selected("TC-CTL-02-1-010")) {
        bad |= run_detect("TC-CTL-02-1-010", false, 74.9, true, false,
                          true, false);
    }

    /* @testcase TC-CTL-02-1-011
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, boundary, interface
     * 감지 센서 활성, 75도의 바로 위에서 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-1-011")) {
        bad |= run_detect("TC-CTL-02-1-011", false,
                          75.00000000000001, true, false, true, true);
    }

    /* @testcase TC-CTL-02-1-012
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, boundary, interface
     * 감지 센서 활성, 75도의 바로 아래에서는 활성화되지 않는다. */
    if (ears_tc_selected("TC-CTL-02-1-012")) {
        bad |= run_detect("TC-CTL-02-1-012", false,
                          74.99999999999999, true, false, true, false);
    }

    /* @testcase TC-CTL-02-1-013
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, fault-injection, interface
     * 감지 센서 활성이어도 센서 무효이면 안전 쪽으로 활성화한다.
     * 무효 입력의 기대값은 REQ-CTL-02-2 에 따른다. */
    if (ears_tc_selected("TC-CTL-02-1-013")) {
        bad |= run_detect("TC-CTL-02-1-013", false, 80.0, false, false,
                          true, true);
    }

    /* @testcase TC-CTL-02-1-014
     * @verifies REQ-CTL-02-1@v2
     * @method requirement, equivalence, interface, error-guessing
     * 감지 센서 활성, 리셋 요청과 유효 75도가 동시에 들어와도 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-1-014")) {
        bad |= run_detect("TC-CTL-02-1-014", false, 75.0, true, true,
                          true, true);
    }

    /* @testcase TC-CTL-02-2-001
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, equivalence, fault-injection, interface
     * 정상 온도라도 센서 플래그가 거짓이면 활성화한다. */
    if (ears_tc_selected("TC-CTL-02-2-001")) {
        bad |= run_case("TC-CTL-02-2-001", false, 25.0, false, false, true);
    }

    /* @testcase TC-CTL-02-2-002
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, equivalence, fault-injection, interface, error-guessing
     * NaN 입력을 안전 쪽으로 처리한다. */
    if (ears_tc_selected("TC-CTL-02-2-002")) {
        bad |= run_case("TC-CTL-02-2-002", false, NAN, true, false, true);
    }

    /* @testcase TC-CTL-02-2-003
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, equivalence, fault-injection, interface
     * 수용 기준의 상한 초과 대표값을 주입한다. */
    if (ears_tc_selected("TC-CTL-02-2-003")) {
        bad |= run_case("TC-CTL-02-2-003", false, 150.1, true, false, true);
    }

    /* @testcase TC-CTL-02-2-004
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, equivalence, fault-injection, interface, error-guessing
     * 양의 무한대를 주입한다. */
    if (ears_tc_selected("TC-CTL-02-2-004")) {
        bad |= run_case("TC-CTL-02-2-004", false, INFINITY, true, false, true);
    }

    /* @testcase TC-CTL-02-2-005
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, equivalence, fault-injection, interface, error-guessing
     * 음의 무한대를 주입한다. */
    if (ears_tc_selected("TC-CTL-02-2-005")) {
        bad |= run_case("TC-CTL-02-2-005", false, -INFINITY, true, false, true);
    }

    /* @testcase TC-CTL-02-2-006
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, boundary, interface, fault-injection
     * 유효 상한의 바로 위를 주입한다. */
    if (ears_tc_selected("TC-CTL-02-2-006")) {
        bad |= run_case("TC-CTL-02-2-006", false,
                        150.00000000000003, true, false, true);
    }

    /* @testcase TC-CTL-02-2-007
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, boundary, interface
     * 유효 상한의 바로 아래는 유효한 과열 입력이다. */
    if (ears_tc_selected("TC-CTL-02-2-007")) {
        bad |= run_case("TC-CTL-02-2-007", false,
                        149.99999999999997, true, false, true);
    }

    /* @testcase TC-CTL-02-2-008
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, boundary, equivalence, interface, fault-injection
     * 유효 하한의 바로 아래를 주입한다. */
    if (ears_tc_selected("TC-CTL-02-2-008")) {
        bad |= run_case("TC-CTL-02-2-008", false,
                        -40.00000000000001, true, false, true);
    }

    /* @testcase TC-CTL-02-2-009
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, boundary, interface, fault-injection
     * double의 유한 최댓값을 주입한다. */
    if (ears_tc_selected("TC-CTL-02-2-009")) {
        bad |= run_case("TC-CTL-02-2-009", false, DBL_MAX, true, false, true);
    }

    /* @testcase TC-CTL-02-2-010
     * @verifies REQ-CTL-02-2@v1
     * @method requirement, boundary, interface, fault-injection, error-guessing
     * double의 가장 작은 유한값과 리셋 요청을 함께 주입한다. */
    if (ears_tc_selected("TC-CTL-02-2-010")) {
        bad |= run_case("TC-CTL-02-2-010", false, -DBL_MAX, true, true, true);
    }

    /* @testcase TC-CTL-02-3-001
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, equivalence, interface
     * 래치 활성 후 냉각되어도 리셋 없이는 유지한다. */
    if (ears_tc_selected("TC-CTL-02-3-001")) {
        bad |= run_case("TC-CTL-02-3-001", true, 25.0, true, false, true);
    }

    /* @testcase TC-CTL-02-3-002
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, equivalence, interface
     * 유효 69.9도와 리셋 요청에서 해제한다.
     * 실제 해제값은 같은 Baseline의 REQ-CTL-03-1@v2에 따른다. */
    if (ears_tc_selected("TC-CTL-02-3-002")) {
        bad |= run_case("TC-CTL-02-3-002", true, 69.9, true, true, false);
    }

    /* @testcase TC-CTL-02-3-003
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, boundary, interface
     * 정확히 70도이면 리셋 요청에도 유지한다. */
    if (ears_tc_selected("TC-CTL-02-3-003")) {
        bad |= run_case("TC-CTL-02-3-003", true, 70.0, true, true, true);
    }

    /* @testcase TC-CTL-02-3-004
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, equivalence, interface
     * 해제 조건 중 리셋 항만 거짓이면 유지한다. */
    if (ears_tc_selected("TC-CTL-02-3-004")) {
        bad |= run_case("TC-CTL-02-3-004", true, 69.9, true, false, true);
    }

    /* @testcase TC-CTL-02-3-005
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, equivalence, interface, fault-injection
     * 해제 조건 중 입력 유효 항만 거짓이면 유지한다. */
    if (ears_tc_selected("TC-CTL-02-3-005")) {
        bad |= run_case("TC-CTL-02-3-005", true, 69.9, false, true, true);
    }

    /* @testcase TC-CTL-02-3-006
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, boundary, interface
     * 70도의 바로 위이면 유지한다. */
    if (ears_tc_selected("TC-CTL-02-3-006")) {
        bad |= run_case("TC-CTL-02-3-006", true,
                        70.00000000000001, true, true, true);
    }

    /* @testcase TC-CTL-02-3-007
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, equivalence, interface, fault-injection
     * 리셋 없음, 입력 무효, 저온 조합이다. */
    if (ears_tc_selected("TC-CTL-02-3-007")) {
        bad |= run_case("TC-CTL-02-3-007", true, 69.9, false, false, true);
    }

    /* @testcase TC-CTL-02-3-008
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, equivalence, interface
     * 리셋 없음, 입력 유효, 70도 이상 조합이다. */
    if (ears_tc_selected("TC-CTL-02-3-008")) {
        bad |= run_case("TC-CTL-02-3-008", true, 70.0, true, false, true);
    }

    /* @testcase TC-CTL-02-3-009
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, equivalence, interface, fault-injection
     * 리셋 없음, 입력 무효, 70도 이상 조합이다. */
    if (ears_tc_selected("TC-CTL-02-3-009")) {
        bad |= run_case("TC-CTL-02-3-009", true, 70.0, false, false, true);
    }

    /* @testcase TC-CTL-02-3-010
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, equivalence, interface, fault-injection
     * 리셋 있음, 입력 무효, 70도 이상 조합이다. */
    if (ears_tc_selected("TC-CTL-02-3-010")) {
        bad |= run_case("TC-CTL-02-3-010", true, 70.0, false, true, true);
    }

    /* @testcase TC-CTL-02-3-011
     * @verifies REQ-CTL-02-3@v2
     * @method requirement, boundary, interface
     * 70도의 바로 아래에서 리셋 요청으로 해제한다.
     * 실제 해제값은 같은 Baseline의 REQ-CTL-03-1@v2에 따른다. */
    if (ears_tc_selected("TC-CTL-02-3-011")) {
        bad |= run_case("TC-CTL-02-3-011", true,
                        69.99999999999999, true, true, false);
    }

    /* @testcase TC-CTL-02-4-001
     * @verifies REQ-CTL-02-4@v2
     * @method requirement, equivalence, interface
     * 비활성 상태에서 유효 74.9도와 리셋 없음이면 유지한다. */
    if (ears_tc_selected("TC-CTL-02-4-001")) {
        bad |= run_case("TC-CTL-02-4-001", false, 74.9, true, false, false);
    }

    /* @testcase TC-CTL-02-4-002
     * @verifies REQ-CTL-02-4@v2
     * @method requirement, equivalence, boundary, interface
     * 유효 하한 -40도에서 비활성을 유지한다. */
    if (ears_tc_selected("TC-CTL-02-4-002")) {
        bad |= run_case("TC-CTL-02-4-002", false, -40.0, true, false, false);
    }

    /* @testcase TC-CTL-02-4-003
     * @verifies REQ-CTL-02-4@v2
     * @method requirement, boundary, interface
     * 75도의 바로 아래에서 비활성을 유지한다.
     * 경계와 바로 위의 활성화는 REQ-CTL-02-1 시험에서 확인한다. */
    if (ears_tc_selected("TC-CTL-02-4-003")) {
        bad |= run_case("TC-CTL-02-4-003", false,
                        74.99999999999999, true, false, false);
    }

    /* @testcase TC-CTL-02-4-004
     * @verifies REQ-CTL-02-4@v2
     * @method requirement, boundary, interface
     * -40도의 바로 위에서 비활성을 유지한다.
     * 바로 아래의 무효 입력은 REQ-CTL-02-2 시험에서 확인한다. */
    if (ears_tc_selected("TC-CTL-02-4-004")) {
        bad |= run_case("TC-CTL-02-4-004", false,
                        -39.99999999999999, true, false, false);
    }

    /* @testcase TC-CTL-02-4-005
     * @verifies REQ-CTL-02-4@v2
     * @method requirement, equivalence, interface, error-guessing
     * 추가된 수용 기준인 유효 74.9도와 리셋 요청의 조합에서도
     * 비활성을 유지한다. */
    if (ears_tc_selected("TC-CTL-02-4-005")) {
        bad |= run_case("TC-CTL-02-4-005", false, 74.9, true, true, false);
    }

    return bad != 0 ? 1 : 0;
}
