/* 동승석 안전벨트 경고 제어기 단위 시험
 * 대상 요구사항: REQ-SBR-01-1@v2, REQ-SBR-01-2@v2, REQ-SBR-01-3@v1, REQ-SBR-01-4@v1,
 *               REQ-SBR-01-5@v1
 * 기대 결과는 요구사항 문장과 수용 기준의 값(15 km/h, 200 km/h, 201 km/h, 255 km/h)에서만 정했다.
 * 경고 기준 속도는 15 km/h 이상, 유효 속도 상한은 200 km/h 이다(수용 기준의 숫자를 그대로 썼다).
 * 판단 한 번 = sbr_acquire_inputs -> sbr_judge_warning -> sbr_output_warning.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "ears_tc.h"
#include "seatbelt_reminder.h"

int ears_suite_sbr_01(void);

/* 판단을 한 번 실행하고 출력된 warning_cmd 를 돌려준다. */
static bool run_once(sbr_state_t *st, uint8_t speed, bool occ, bool belt)
{
    sbr_input_t in = { 0U, false, false };
    sbr_acquire_inputs(&in, speed, occ, belt);
    sbr_output_warning(st, sbr_judge_warning(&in));
    return st->warning_cmd;
}

/* 한 단계를 실행하고 실제 출력을 기록한다. 기대와 다르면 1 을 돌려준다. */
static int seq_step(const char *tc, int step, sbr_state_t *st, uint8_t speed,
                    bool occ, bool belt, bool expected)
{
    bool got = run_once(st, speed, occ, belt);
    ears_actual_i(tc, step, "warning_cmd", (long long)got);
    if (got != expected) {
        printf("  %s: expected warning_cmd=%d, got warning_cmd=%d "
               "(speed=%d, occupied=%d, buckled=%d)\n",
               tc, (int)expected, (int)got, (int)speed, (int)occ, (int)belt);
        return 1;
    }
    return 0;
}

static int finish(const char *tc, int bad)
{
    printf("%s %s\n", tc, bad ? "fail" : "pass");
    return bad ? 1 : 0;
}

/* 한 번만 판단하는 시험. 이전 출력이 기대와 반대가 되게 미리 채워 두어 출력이 실제로 다시 정해지는지 본다. */
static int check_single(const char *tc, uint8_t speed, bool occ, bool belt,
                        bool expected)
{
    sbr_state_t st;
    st.warning_cmd = !expected;
    return finish(tc, seq_step(tc, 1, &st, speed, occ, belt, expected));
}

int ears_suite_sbr_01(void)
{
    int failures = 0;

    /* ---- REQ-SBR-01-1@v2 ---- */

    /* @testcase TC-SBR-01-1-001
     * @verifies REQ-SBR-01-1@v2
     * @method requirement, boundary
     * 경계 바로 아래: 14 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-1-001")) {
        failures += check_single("TC-SBR-01-1-001", 14U, true, false, false);
    }

    /* @testcase TC-SBR-01-1-002
     * @verifies REQ-SBR-01-1@v2
     * @method requirement, boundary
     * 하한 경계: 15 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SBR-01-1-002")) {
        failures += check_single("TC-SBR-01-1-002", 15U, true, false, true);
    }

    /* @testcase TC-SBR-01-1-003
     * @verifies REQ-SBR-01-1@v2
     * @method requirement, boundary
     * 경계 바로 위: 16 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SBR-01-1-003")) {
        failures += check_single("TC-SBR-01-1-003", 16U, true, false, true);
    }

    /* @testcase TC-SBR-01-1-004
     * @verifies REQ-SBR-01-1@v2
     * @method requirement, boundary
     * 상한 경계: 200 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SBR-01-1-004")) {
        failures += check_single("TC-SBR-01-1-004", 200U, true, false, true);
    }

    /* @testcase TC-SBR-01-1-005
     * @verifies REQ-SBR-01-1@v2
     * @method equivalence
     * 유효 구간의 대표값: 탑승, 미착용, 100 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SBR-01-1-005")) {
        failures += check_single("TC-SBR-01-1-005", 100U, true, false, true);
    }

    /* ---- REQ-SBR-01-2@v2 ---- */

    /* @testcase TC-SBR-01-2-001
     * @verifies REQ-SBR-01-2@v2
     * @method requirement, equivalence
     * 미탑승, 미착용, 50 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-2-001")) {
        failures += check_single("TC-SBR-01-2-001", 50U, false, false, false);
    }

    /* @testcase TC-SBR-01-2-002
     * @verifies REQ-SBR-01-2@v2
     * @method requirement, equivalence
     * 탑승, 착용, 50 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-2-002")) {
        failures += check_single("TC-SBR-01-2-002", 50U, true, true, false);
    }

    /* @testcase TC-SBR-01-2-003
     * @verifies REQ-SBR-01-2@v2
     * @method requirement, boundary, error-guessing
     * 탑승, 미착용, 0 km/h (자료형 최소) 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-2-003")) {
        failures += check_single("TC-SBR-01-2-003", 0U, true, false, false);
    }

    /* @testcase TC-SBR-01-2-004
     * @verifies REQ-SBR-01-2@v2
     * @method equivalence
     * 미탑승, 착용, 50 km/h 이면 FALSE (OR 조건의 두 항이 모두 참) */
    if (ears_tc_selected("TC-SBR-01-2-004")) {
        failures += check_single("TC-SBR-01-2-004", 50U, false, true, false);
    }

    /* @testcase TC-SBR-01-2-005
     * @verifies REQ-SBR-01-2@v2
     * @method boundary
     * 탑승, 착용, 200 km/h (상한 경계) 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-2-005")) {
        failures += check_single("TC-SBR-01-2-005", 200U, true, true, false);
    }

    /* @testcase TC-SBR-01-2-006
     * @verifies REQ-SBR-01-2@v2
     * @method boundary
     * 탑승, 미착용, 14 km/h (15 km/h 미만의 경계 바로 아래) 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-2-006")) {
        failures += check_single("TC-SBR-01-2-006", 14U, true, false, false);
    }

    /* @testcase TC-SBR-01-2-007
     * @verifies REQ-SBR-01-2@v2
     * @method boundary, equivalence
     * 미탑승, 미착용, 200 km/h (상한 경계에서도 미탑승이면) FALSE */
    if (ears_tc_selected("TC-SBR-01-2-007")) {
        failures += check_single("TC-SBR-01-2-007", 200U, false, false, false);
    }

    /* ---- REQ-SBR-01-3@v1 ---- */

    /* @testcase TC-SBR-01-3-001
     * @verifies REQ-SBR-01-3@v1
     * @method requirement
     * 이전 값이 TRUE 인 상태에서 초기화하면 warning_cmd = FALSE */
    if (ears_tc_selected("TC-SBR-01-3-001")) {
        sbr_state_t st;
        int bad = 0;
        st.warning_cmd = true;
        sbr_init_output(&st);
        ears_actual_i("TC-SBR-01-3-001", 1, "warning_cmd", (long long)st.warning_cmd);
        if (st.warning_cmd != false) {
            printf("  TC-SBR-01-3-001: expected warning_cmd=0, got warning_cmd=%d\n",
                   (int)st.warning_cmd);
            bad = 1;
        }
        failures += finish("TC-SBR-01-3-001", bad);
    }

    /* @testcase TC-SBR-01-3-002
     * @verifies REQ-SBR-01-3@v1
     * @method requirement, error-guessing
     * 경고가 실제로 켜진 뒤 초기화하면 warning_cmd = FALSE */
    if (ears_tc_selected("TC-SBR-01-3-002")) {
        sbr_state_t st;
        int bad = 0;
        st.warning_cmd = false;
        bad += seq_step("TC-SBR-01-3-002", 1, &st, 30U, true, false, true);
        sbr_init_output(&st);
        ears_actual_i("TC-SBR-01-3-002", 2, "warning_cmd", (long long)st.warning_cmd);
        if (st.warning_cmd != false) {
            printf("  TC-SBR-01-3-002: expected warning_cmd=0, got warning_cmd=%d\n",
                   (int)st.warning_cmd);
            bad = 1;
        }
        failures += finish("TC-SBR-01-3-002", bad);
    }

    /* ---- REQ-SBR-01-4@v1 ---- */

    /* @testcase TC-SBR-01-4-001
     * @verifies REQ-SBR-01-4@v1
     * @method requirement
     * 수용 기준 순서: 1회차 (탑승, 미착용, 30) TRUE, 2회차 (탑승, 착용, 30) FALSE
     * 단계 1 은 초기화 호출이고 단계 2, 3 이 판단 실행이다. */
    if (ears_tc_selected("TC-SBR-01-4-001")) {
        sbr_state_t st;
        int bad = 0;
        sbr_init_output(&st);
        bad += seq_step("TC-SBR-01-4-001", 2, &st, 30U, true, false, true);
        bad += seq_step("TC-SBR-01-4-001", 3, &st, 30U, true, true, false);
        failures += finish("TC-SBR-01-4-001", bad);
    }

    /* @testcase TC-SBR-01-4-002
     * @verifies REQ-SBR-01-4@v1
     * @method error-guessing
     * 상태가 뒤바뀐 순서: 1회차 FALSE 다음 2회차 TRUE
     * 단계 1 은 초기화 호출이다. */
    if (ears_tc_selected("TC-SBR-01-4-002")) {
        sbr_state_t st;
        int bad = 0;
        sbr_init_output(&st);
        bad += seq_step("TC-SBR-01-4-002", 2, &st, 30U, true, true, false);
        bad += seq_step("TC-SBR-01-4-002", 3, &st, 30U, true, false, true);
        failures += finish("TC-SBR-01-4-002", bad);
    }

    /* @testcase TC-SBR-01-4-003
     * @verifies REQ-SBR-01-4@v1
     * @method error-guessing, boundary
     * 속도만 바뀌어도 매 실행마다 다시 정해진다: 30 TRUE, 14 FALSE, 15 TRUE
     * 단계 1 은 초기화 호출이다. */
    if (ears_tc_selected("TC-SBR-01-4-003")) {
        sbr_state_t st;
        int bad = 0;
        sbr_init_output(&st);
        bad += seq_step("TC-SBR-01-4-003", 2, &st, 30U, true, false, true);
        bad += seq_step("TC-SBR-01-4-003", 3, &st, 14U, true, false, false);
        bad += seq_step("TC-SBR-01-4-003", 4, &st, 15U, true, false, true);
        failures += finish("TC-SBR-01-4-003", bad);
    }

    /* @testcase TC-SBR-01-4-004
     * @verifies REQ-SBR-01-4@v1
     * @method interface
     * 취득 단계는 이번 실행의 세 값을 변환 없이 그대로 전달한다 */
    if (ears_tc_selected("TC-SBR-01-4-004")) {
        sbr_input_t in = { 0U, false, false };
        int bad = 0;

        sbr_acquire_inputs(&in, 137U, true, false);
        ears_actual_i("TC-SBR-01-4-004", 1, "vehicle_speed", (long long)in.vehicle_speed);
        ears_actual_i("TC-SBR-01-4-004", 1, "passenger_occupied", (long long)in.passenger_occupied);
        ears_actual_i("TC-SBR-01-4-004", 1, "seatbelt_buckled", (long long)in.seatbelt_buckled);
        if (in.vehicle_speed != 137U || in.passenger_occupied != true ||
            in.seatbelt_buckled != false) {
            printf("  TC-SBR-01-4-004: expected speed=137 occupied=1 buckled=0, "
                   "got speed=%d occupied=%d buckled=%d\n",
                   (int)in.vehicle_speed, (int)in.passenger_occupied,
                   (int)in.seatbelt_buckled);
            bad = 1;
        }

        sbr_acquire_inputs(&in, 0U, false, true);
        ears_actual_i("TC-SBR-01-4-004", 2, "vehicle_speed", (long long)in.vehicle_speed);
        ears_actual_i("TC-SBR-01-4-004", 2, "passenger_occupied", (long long)in.passenger_occupied);
        ears_actual_i("TC-SBR-01-4-004", 2, "seatbelt_buckled", (long long)in.seatbelt_buckled);
        if (in.vehicle_speed != 0U || in.passenger_occupied != false ||
            in.seatbelt_buckled != true) {
            printf("  TC-SBR-01-4-004: expected speed=0 occupied=0 buckled=1, "
                   "got speed=%d occupied=%d buckled=%d\n",
                   (int)in.vehicle_speed, (int)in.passenger_occupied,
                   (int)in.seatbelt_buckled);
            bad = 1;
        }
        failures += finish("TC-SBR-01-4-004", bad);
    }

    /* ---- REQ-SBR-01-5@v1 ----
     * 속도 200 km/h 초과(범위 밖)이면 탑승·미착용이어도 warning_cmd = FALSE (안전 쪽 동작). */

    /* @testcase TC-SBR-01-5-001
     * @verifies REQ-SBR-01-5@v1
     * @method requirement, boundary
     * 수용 기준 1: 탑승, 미착용, 201 km/h (상한 200 바로 위) 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-5-001")) {
        failures += check_single("TC-SBR-01-5-001", 201U, true, false, false);
    }

    /* @testcase TC-SBR-01-5-002
     * @verifies REQ-SBR-01-5@v1
     * @method requirement, boundary
     * 수용 기준 2: 탑승, 미착용, 255 km/h (자료형 최대) 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-5-002")) {
        failures += check_single("TC-SBR-01-5-002", 255U, true, false, false);
    }

    /* @testcase TC-SBR-01-5-003
     * @verifies REQ-SBR-01-5@v1
     * @method equivalence, error-guessing
     * 범위 밖 구간의 대표값: 탑승, 미착용, 230 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SBR-01-5-003")) {
        failures += check_single("TC-SBR-01-5-003", 230U, true, false, false);
    }

    /* @testcase TC-SBR-01-5-004
     * @verifies REQ-SBR-01-5@v1
     * @method boundary, error-guessing
     * 상한 경계 전후 순서: 200 TRUE, 201 FALSE, 200 TRUE (경고가 켜진 뒤 범위 밖이 되면 꺼지고, 다시 범위 안이면 켜진다) */
    if (ears_tc_selected("TC-SBR-01-5-004")) {
        sbr_state_t st;
        int bad = 0;
        st.warning_cmd = false;
        bad += seq_step("TC-SBR-01-5-004", 1, &st, 200U, true, false, true);
        bad += seq_step("TC-SBR-01-5-004", 2, &st, 201U, true, false, false);
        bad += seq_step("TC-SBR-01-5-004", 3, &st, 200U, true, false, true);
        failures += finish("TC-SBR-01-5-004", bad);
    }

    return failures != 0 ? 1 : 0;
}
