/* 통합 시험 INT-01 (U-01 입력 취득 → U-02 경고 조건 판정)
 * 대상 요구사항: REQ-SBR-01-1@v2, REQ-SBR-01-2@v2, REQ-SBR-01-4@v1,
 *               REQ-SBR-01-5@v1 (vehicle_speed 가 200 km/h 초과이면 경고 명령 FALSE)
 *
 * 범위 안 유닛(U-01, U-02)은 실제 함수를 그대로 연결한다.
 * 1 Cycle = sbr_acquire_inputs (U-01) 한 번 → sbr_judge_warning (U-02) 한 번.
 * 범위 경계의 출력은 sbr_judge_warning 의 반환값(warning_result)이며,
 * 경고 명령 출력 유닛(U-03)은 이 통합 범위 밖이라 부르지 않는다.
 * 단위 환산: vehicle_speed 는 1 km/h/LSB 이므로 정수값이 km/h 와 같다.
 * 경계값은 수용 기준의 숫자를 그대로 쓴다: 경고 하한 15 km/h, 유효 상한 200 km/h.
 *
 * @no-method interface REQ-SBR-01-5: 인터페이스 시험은 권장 방법이며 이 통합 시험은 입력 취득과 판정의 연결을 요구사항 기준으로 확인한다
 * @no-method interface REQ-SBR-01-1: 인터페이스 시험은 권장 방법이며 이 통합 시험은 입력 취득과 판정의 연결을 요구사항 기준으로 확인한다
 * @no-method interface REQ-SBR-01-2: 인터페이스 시험은 권장 방법이며 이 통합 시험은 입력 취득과 판정의 연결을 요구사항 기준으로 확인한다
 * @no-method interface REQ-SBR-01-4: 인터페이스 시험은 권장 방법이며 이 통합 시험은 입력 취득과 판정의 연결을 요구사항 기준으로 확인한다
 */

#include <stdio.h>
#include <stdbool.h>
#include <stdint.h>

#include "ears_tc.h"
#include "seatbelt_reminder.h"

int ears_suite_int_01(void);

/* 1 Cycle 실행: U-01 → U-02. 판정 결과를 돌려주고 취득된 입력을 observed 에 남긴다. */
static bool run_cycle(uint8_t speed, bool occupied, bool buckled, sbr_input_t *observed)
{
    bool result;

    observed->vehicle_speed = 0U;
    observed->passenger_occupied = false;
    observed->seatbelt_buckled = false;

    sbr_acquire_inputs(observed, speed, occupied, buckled);
    result = sbr_judge_warning(observed);
    return result;
}

/* 한 단계 실행 후 실제 출력을 찍고 기대값과 비교한다. 일치하면 1, 아니면 0. */
static int run_step(const char *tc, int step, uint8_t speed, bool occupied,
                    bool buckled, bool expected)
{
    sbr_input_t observed;
    bool got = run_cycle(speed, occupied, buckled, &observed);

    ears_actual_i(tc, step, "vehicle_speed", (long long)observed.vehicle_speed);
    ears_actual_i(tc, step, "passenger_occupied", (long long)observed.passenger_occupied);
    ears_actual_i(tc, step, "seatbelt_buckled", (long long)observed.seatbelt_buckled);
    ears_actual_i(tc, step, "warning_result", (long long)got);

    if (got != expected) {
        printf("  %s: expected warning_result=%d, got warning_result=%d "
               "(vehicle_speed=%d, passenger_occupied=%d, seatbelt_buckled=%d)\n",
               tc, (int)expected, (int)got, (int)speed, (int)occupied, (int)buckled);
        return 0;
    }
    return 1;
}

static int finish(const char *tc, int ok)
{
    printf("%s %s\n", tc, ok ? "pass" : "fail");
    return ok ? 0 : 1;
}

int ears_suite_int_01(void)
{
    int failures = 0;

    /* ===== REQ-SBR-01-1@v2 ===== */

    /* @testcase TC-INT-01-SBR-01-1-001
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-01
     * @method requirement, boundary
     * 수용 기준 1: 탑승, 미착용, 14 km/h (하한 15 바로 아래) → FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-1-001")) {
        const char *tc = "TC-INT-01-SBR-01-1-001";
        int ok = run_step(tc, 1, (uint8_t)14U, true, false, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-1-002
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-01
     * @method requirement, boundary
     * 수용 기준 2: 탑승, 미착용, 15 km/h (하한 경계) → TRUE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-1-002")) {
        const char *tc = "TC-INT-01-SBR-01-1-002";
        int ok = run_step(tc, 1, (uint8_t)15U, true, false, true);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-1-003
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-01
     * @method requirement, boundary
     * 수용 기준 3: 탑승, 미착용, 16 km/h (하한 바로 위) → TRUE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-1-003")) {
        const char *tc = "TC-INT-01-SBR-01-1-003";
        int ok = run_step(tc, 1, (uint8_t)16U, true, false, true);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-1-004
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-01
     * @method requirement, boundary
     * 수용 기준 4: 탑승, 미착용, 200 km/h (상한 경계) → TRUE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-1-004")) {
        const char *tc = "TC-INT-01-SBR-01-1-004";
        int ok = run_step(tc, 1, (uint8_t)200U, true, false, true);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-1-005
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-01
     * @method equivalence, boundary
     * 속도 구간 대표값: 0, 1, 14 (15 미만 → FALSE), 50, 100, 199 (15~200 구간 → TRUE)
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-1-005")) {
        const char *tc = "TC-INT-01-SBR-01-1-005";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)0U, true, false, false);
        ok &= run_step(tc, 2, (uint8_t)1U, true, false, false);
        ok &= run_step(tc, 3, (uint8_t)14U, true, false, false);
        ok &= run_step(tc, 4, (uint8_t)50U, true, false, true);
        ok &= run_step(tc, 5, (uint8_t)100U, true, false, true);
        ok &= run_step(tc, 6, (uint8_t)199U, true, false, true);
        failures += finish(tc, ok);
    }

    /* ===== REQ-SBR-01-2@v2 ===== */

    /* @testcase TC-INT-01-SBR-01-2-001
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-01
     * @method requirement
     * 수용 기준 1: 비탑승, 미착용, 50 km/h → FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-2-001")) {
        const char *tc = "TC-INT-01-SBR-01-2-001";
        int ok = run_step(tc, 1, (uint8_t)50U, false, false, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-2-002
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-01
     * @method requirement
     * 수용 기준 2: 탑승, 착용, 50 km/h → FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-2-002")) {
        const char *tc = "TC-INT-01-SBR-01-2-002";
        int ok = run_step(tc, 1, (uint8_t)50U, true, true, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-2-003
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-01
     * @method requirement, boundary
     * 수용 기준 3: 탑승, 미착용, 0 km/h → FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-2-003")) {
        const char *tc = "TC-INT-01-SBR-01-2-003";
        int ok = run_step(tc, 1, (uint8_t)0U, true, false, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-2-004
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-01
     * @method equivalence, boundary
     * 속도 15~200 구간에서 경고 조건이 아닌 조합(비탑승 또는 착용)은 경계 속도에서도 FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-2-004")) {
        const char *tc = "TC-INT-01-SBR-01-2-004";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)200U, false, false, false);
        ok &= run_step(tc, 2, (uint8_t)50U, false, true, false);
        ok &= run_step(tc, 3, (uint8_t)200U, false, true, false);
        ok &= run_step(tc, 4, (uint8_t)200U, true, true, false);
        ok &= run_step(tc, 5, (uint8_t)15U, true, true, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-2-005
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-01
     * @method equivalence, boundary, error-guessing
     * 속도 15 미만 구간(14, 1 km/h)에서는 탑승·착용 조합과 관계없이 FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-2-005")) {
        const char *tc = "TC-INT-01-SBR-01-2-005";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)14U, false, false, false);
        ok &= run_step(tc, 2, (uint8_t)14U, false, true, false);
        ok &= run_step(tc, 3, (uint8_t)14U, true, true, false);
        ok &= run_step(tc, 4, (uint8_t)14U, true, false, false);
        ok &= run_step(tc, 5, (uint8_t)1U, true, false, false);
        failures += finish(tc, ok);
    }

    /* ===== REQ-SBR-01-4@v1 ===== */

    /* @testcase TC-INT-01-SBR-01-4-001
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-01
     * @method requirement
     * 수용 기준: 1회차 탑승, 미착용, 30 km/h → TRUE. 이어서 2회차 탑승, 착용, 30 km/h → FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-4-001")) {
        const char *tc = "TC-INT-01-SBR-01-4-001";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)30U, true, false, true);
        ok &= run_step(tc, 2, (uint8_t)30U, true, true, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-4-002
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-01
     * @method error-guessing
     * 상태가 뒤바뀐 순서: 1회차 착용 → FALSE, 2회차 미착용 → TRUE (이전 결과가 남지 않음)
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-4-002")) {
        const char *tc = "TC-INT-01-SBR-01-4-002";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)30U, true, true, false);
        ok &= run_step(tc, 2, (uint8_t)30U, true, false, true);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-4-003
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-01
     * @method error-guessing
     * 세 입력이 번갈아 바뀌는 여러 회차: 매 회차 그 회차의 입력만으로 다시 판정된다.
     * 경고(30) → 비탑승(FALSE) → 경고(TRUE) → 저속 5(FALSE) → 경고(TRUE) → 착용(FALSE)
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-4-003")) {
        const char *tc = "TC-INT-01-SBR-01-4-003";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)30U, true, false, true);
        ok &= run_step(tc, 2, (uint8_t)30U, false, false, false);
        ok &= run_step(tc, 3, (uint8_t)30U, true, false, true);
        ok &= run_step(tc, 4, (uint8_t)5U, true, false, false);
        ok &= run_step(tc, 5, (uint8_t)30U, true, false, true);
        ok &= run_step(tc, 6, (uint8_t)30U, true, true, false);
        failures += finish(tc, ok);
    }

    /* ===== REQ-SBR-01-5@v1 ===== */

    /* @testcase TC-INT-01-SBR-01-5-001
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-01
     * @method requirement, boundary
     * 수용 기준 1: 탑승, 미착용, 201 km/h (상한 200 바로 위) → FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-5-001")) {
        const char *tc = "TC-INT-01-SBR-01-5-001";
        int ok = run_step(tc, 1, (uint8_t)201U, true, false, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-5-002
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-01
     * @method requirement, boundary
     * 수용 기준 2: 탑승, 미착용, 255 km/h (uint8_t 최대) → FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-5-002")) {
        const char *tc = "TC-INT-01-SBR-01-5-002";
        int ok = run_step(tc, 1, (uint8_t)255U, true, false, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-5-003
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-01
     * @method boundary
     * 경계 바로 아래·경계·바로 위: 199, 200 km/h 는 범위 안이므로 경고 조건이 성립하면 TRUE, 201 은 FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-5-003")) {
        const char *tc = "TC-INT-01-SBR-01-5-003";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)199U, true, false, true);
        ok &= run_step(tc, 2, (uint8_t)200U, true, false, true);
        ok &= run_step(tc, 3, (uint8_t)201U, true, false, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-5-004
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-01
     * @method equivalence, boundary
     * 범위 초과 구간(201~255)의 대표값 202, 230, 254 → FALSE
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-5-004")) {
        const char *tc = "TC-INT-01-SBR-01-5-004";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)202U, true, false, false);
        ok &= run_step(tc, 2, (uint8_t)230U, true, false, false);
        ok &= run_step(tc, 3, (uint8_t)254U, true, false, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-5-005
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-01
     * @method error-guessing
     * 범위 초과(201 km/h 이상)에서는 탑승·착용 조합과 관계없이 FALSE (안전 쪽 동작)
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-5-005")) {
        const char *tc = "TC-INT-01-SBR-01-5-005";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)201U, false, false, false);
        ok &= run_step(tc, 2, (uint8_t)201U, true, true, false);
        ok &= run_step(tc, 3, (uint8_t)201U, false, true, false);
        ok &= run_step(tc, 4, (uint8_t)255U, false, true, false);
        failures += finish(tc, ok);
    }

    /* @testcase TC-INT-01-SBR-01-5-006
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-01
     * @method error-guessing
     * 속도가 범위 안과 밖을 오가는 순서: 200(TRUE) → 201(FALSE) → 200(TRUE) → 255(FALSE) → 15(TRUE).
     * 이전 주기의 결과가 남지 않고 매 주기 새로 판정되는지 확인한다.
     */
    if (ears_tc_selected("TC-INT-01-SBR-01-5-006")) {
        const char *tc = "TC-INT-01-SBR-01-5-006";
        int ok = 1;
        ok &= run_step(tc, 1, (uint8_t)200U, true, false, true);
        ok &= run_step(tc, 2, (uint8_t)201U, true, false, false);
        ok &= run_step(tc, 3, (uint8_t)200U, true, false, true);
        ok &= run_step(tc, 4, (uint8_t)255U, true, false, false);
        ok &= run_step(tc, 5, (uint8_t)15U, true, false, true);
        failures += finish(tc, ok);
    }

    return failures != 0 ? 1 : 0;
}
