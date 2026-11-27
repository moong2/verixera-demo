/* 통합 시험 INT-03: U-01 입력 취득 → U-02 경고 조건 판정 → U-03 경고 명령 출력.
 * 범위 안 유닛은 실제 코드를 그대로 연결하고, 유닛 사이 신호는 직접 쓰지 않는다.
 * 1 Cycle = sbr_acquire_inputs → sbr_judge_warning → sbr_output_warning 을 한 번씩 부른다.
 * 기대값은 요구사항 수용 기준의 숫자(경고 기준 속도 15 km/h, 속도 상한 200 km/h)에서 직접 정한다.
 * 시나리오의 첫 단계는 sbr_init_output 호출이다. 거짓 기대값을 의미 있게 만들려고
 * 필요하면 경고를 켜는 1 Cycle 을 먼저 실행(사전 조건)한 뒤 시험 입력을 넣는다.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "ears_tc.h"
#include "seatbelt_reminder.h"

int ears_suite_int_03(void);

typedef struct {
    uint8_t speed;   /* vehicle_speed, km/h */
    bool occupied;   /* passenger_occupied */
    bool buckled;    /* seatbelt_buckled */
    bool expect;     /* 기대 warning_cmd */
} sc_step_t;

#define SC_COUNT(a) ((int)(sizeof(a) / sizeof((a)[0])))

/* 초기화 후 각 단계마다 1 Cycle 을 실행하고 warning_cmd 를 기대값과 비교한다.
 * 단계 1 은 초기화(기록만), 단계 2 부터 입력 1 Cycle. */
static int run_scenario(const char *tc, const sc_step_t *s, int n)
{
    sbr_state_t st = { false };
    int ok = 1;
    int i;

    sbr_init_output(&st);
    ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);

    for (i = 0; i < n; i++) {
        sbr_input_t in = { 0U, false, false };
        bool result;

        sbr_acquire_inputs(&in, s[i].speed, s[i].occupied, s[i].buckled);
        result = sbr_judge_warning(&in);
        sbr_output_warning(&st, result);

        ears_actual_i(tc, i + 2, "warning_cmd", (long long)st.warning_cmd);
        ears_actual_i(tc, i + 2, "warning_result", (long long)result);

        if (st.warning_cmd != s[i].expect) {
            printf("  %s: expected warning_cmd=%d, got warning_cmd=%d (step=%d speed=%u occupied=%d buckled=%d)\n",
                   tc, (int)s[i].expect, (int)st.warning_cmd, i + 2,
                   (unsigned)s[i].speed, (int)s[i].occupied, (int)s[i].buckled);
            ok = 0;
        }
    }
    printf("%s %s\n", tc, ok ? "pass" : "fail");
    return ok;
}

int ears_suite_int_03(void)
{
    int failed = 0;

    /* ===== REQ-SBR-01-1@v2 ===== */

    /* @testcase TC-INT-03-SBR-01-1-001
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-03
     * @method requirement, boundary
     * 경계 바로 아래: 탑승, 미착용, 14 km/h 이면 FALSE (사전에 경고를 켠 뒤 꺼지는지 확인)
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-1-001")) {
        static const sc_step_t sc[] = {
            { 50U, true, false, true },
            { 14U, true, false, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-1-001", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-1-002
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-03
     * @method requirement, boundary
     * 경계: 탑승, 미착용, 15 km/h 이면 TRUE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-1-002")) {
        static const sc_step_t sc[] = {
            { 15U, true, false, true }
        };
        if (!run_scenario("TC-INT-03-SBR-01-1-002", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-1-003
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-03
     * @method requirement, boundary
     * 경계 바로 위: 탑승, 미착용, 16 km/h 이면 TRUE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-1-003")) {
        static const sc_step_t sc[] = {
            { 16U, true, false, true }
        };
        if (!run_scenario("TC-INT-03-SBR-01-1-003", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-1-004
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-03
     * @method requirement, boundary
     * 상한 경계: 탑승, 미착용, 200 km/h 이면 TRUE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-1-004")) {
        static const sc_step_t sc[] = {
            { 200U, true, false, true }
        };
        if (!run_scenario("TC-INT-03-SBR-01-1-004", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* ===== REQ-SBR-01-2@v2 ===== */

    /* @testcase TC-INT-03-SBR-01-2-001
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-03
     * @method requirement, equivalence
     * 비탑승(passenger_occupied = FALSE), 미착용, 50 km/h 이면 FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-2-001")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 50U, false, false, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-2-001", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-2-002
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-03
     * @method requirement, equivalence
     * 탑승, 착용(seatbelt_buckled = TRUE), 50 km/h 이면 FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-2-002")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 50U, true, true, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-2-002", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-2-003
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-03
     * @method requirement, boundary
     * 탑승, 미착용, 0 km/h 이면 FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-2-003")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 0U, true, false, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-2-003", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-2-004
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-03
     * @method boundary, equivalence
     * 속도 상한 200 km/h 에서 탑승, 착용이면 FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-2-004")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 200U, true, true, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-2-004", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-2-005
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-03
     * @method boundary, equivalence
     * 속도 경계 15 km/h 이어도 비탑승이면 FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-2-005")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 15U, false, false, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-2-005", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-2-006
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-03
     * @method equivalence, error-guessing
     * 비탑승이면서 착용(상태 조합이 모순)인 입력, 50 km/h 이면 FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-2-006")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 50U, false, true, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-2-006", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-2-007
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-03
     * @method boundary, equivalence
     * 속도 경계 15 km/h 이어도 착용이면 FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-2-007")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 15U, true, true, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-2-007", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* ===== REQ-SBR-01-3@v1 ===== */

    /* @testcase TC-INT-03-SBR-01-3-001
     * @verifies REQ-SBR-01-3@v1
     * @level integration
     * @target INT-03
     * @method requirement, error-guessing
     * 경고가 켜진 상태(탑승, 미착용, 50 km/h)에서 초기화하면 warning_cmd = FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-3-001")) {
        const char *tc = "TC-INT-03-SBR-01-3-001";
        sbr_state_t st = { false };
        sbr_input_t in = { 0U, false, false };
        bool result;
        int ok = 1;

        sbr_init_output(&st);
        ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);

        sbr_acquire_inputs(&in, 50U, true, false);
        result = sbr_judge_warning(&in);
        sbr_output_warning(&st, result);
        ears_actual_i(tc, 2, "warning_cmd", (long long)st.warning_cmd);
        ears_actual_i(tc, 2, "warning_result", (long long)result);
        if (!st.warning_cmd) {
            printf("  %s: precondition expected warning_cmd=1, got warning_cmd=0\n", tc);
            ok = 0;
        }

        sbr_init_output(&st);
        ears_actual_i(tc, 3, "warning_cmd", (long long)st.warning_cmd);
        if (st.warning_cmd) {
            printf("  %s: expected warning_cmd=0, got warning_cmd=1 (after init)\n", tc);
            ok = 0;
        }
        printf("%s %s\n", tc, ok ? "pass" : "fail");
        if (!ok) { failed = 1; }
    }

    /* ===== REQ-SBR-01-4@v1 ===== */

    /* @testcase TC-INT-03-SBR-01-4-001
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-03
     * @method requirement
     * 1회차 탑승, 미착용, 30 km/h 이면 TRUE, 이어서 2회차 탑승, 착용, 30 km/h 이면 FALSE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-4-001")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 30U, true, true, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-4-001", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-4-002
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-03
     * @method error-guessing
     * 순서를 뒤집은 경우: 1회차 착용이면 FALSE, 2회차 미착용이면 다시 TRUE (이전 결과에 묶이지 않음)
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-4-002")) {
        static const sc_step_t sc[] = {
            { 30U, true, true, false },
            { 30U, true, false, true }
        };
        if (!run_scenario("TC-INT-03-SBR-01-4-002", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-4-003
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-03
     * @method error-guessing, boundary
     * 속도만 바꿔 가며 매 회차 다시 정한다: 30 km/h TRUE, 14 km/h FALSE, 15 km/h TRUE
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-4-003")) {
        static const sc_step_t sc[] = {
            { 30U, true, false, true },
            { 14U, true, false, false },
            { 15U, true, false, true }
        };
        if (!run_scenario("TC-INT-03-SBR-01-4-003", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* ===== REQ-SBR-01-5@v1 ===== */

    /* @testcase TC-INT-03-SBR-01-5-001
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-03
     * @method requirement, boundary
     * 수용 기준 1: 탑승, 미착용, 201 km/h(범위 밖 바로 위) 이면 FALSE.
     * 사전 조건으로 50 km/h 1 Cycle 에서 경고를 TRUE 로 켠 뒤 꺼지는지 확인한다.
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-5-001")) {
        static const sc_step_t sc[] = {
            { 50U, true, false, true },
            { 201U, true, false, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-5-001", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-5-002
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-03
     * @method requirement, boundary, error-guessing
     * 수용 기준 2: 탑승, 미착용, 255 km/h(uint8_t 최대값) 이면 FALSE.
     * 사전 조건으로 50 km/h 1 Cycle 에서 경고를 TRUE 로 켠 뒤 꺼지는지 확인한다.
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-5-002")) {
        static const sc_step_t sc[] = {
            { 50U, true, false, true },
            { 255U, true, false, false }
        };
        if (!run_scenario("TC-INT-03-SBR-01-5-002", sc, SC_COUNT(sc))) { failed = 1; }
    }

    /* @testcase TC-INT-03-SBR-01-5-003
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-03
     * @method boundary, error-guessing
     * 경계 전후를 한 시나리오로: 200 km/h 는 TRUE(REQ-SBR-01-1 의 상한), 201 km/h 는 FALSE,
     * 다시 200 km/h 로 돌아오면 TRUE (범위 밖 판정이 이전 결과에 묶이지 않음)
     */
    if (ears_tc_selected("TC-INT-03-SBR-01-5-003")) {
        static const sc_step_t sc[] = {
            { 200U, true, false, true },
            { 201U, true, false, false },
            { 200U, true, false, true }
        };
        if (!run_scenario("TC-INT-03-SBR-01-5-003", sc, SC_COUNT(sc))) { failed = 1; }
    }

    return failed;
}
