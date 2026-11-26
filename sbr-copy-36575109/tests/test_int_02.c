/*
 * INT-02 통합 시험: U-02(경고 조건 판정) -> U-03(경고 명령 출력)
 *
 * 범위 안 유닛(U-02, U-03)은 실제 코드를 그대로 연결한다.
 * 1 Cycle = sbr_judge_warning(U-02) 한 번 + sbr_output_warning(U-03) 한 번.
 * 입력(STIMULUS)은 sbr_input_t 에 직접 채우고, 유닛 사이 신호 warning_result 는
 * 읽어서 기록만 한다(덮어쓰지 않는다). 판정은 경계 출력 warning_cmd 로 한다.
 *
 * 값은 수용 기준의 숫자를 그대로 쓴다. 단위는 vehicle_speed 가 km/h, 1 km/h/LSB 이다.
 * 경고 기준 속도는 15 km/h, 유효 범위 상한은 200 km/h 이다(REQ-SBR-01-1@v2, REQ-SBR-01-2@v2).
 *
 * REQ-SBR-01-5(200 km/h 초과이면 warning_cmd = FALSE)의 시험은 이 파일 끝부분에 있다.
 * 범위 밖 속도(201~255)에서 warning_result 의 값은 요구사항에 없으므로 기록만 하고 판정하지 않는다.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "ears_tc.h"
#include "seatbelt_reminder.h"

int ears_suite_int_02(void);

/* 1 Cycle 실행: 입력 -> U-02 -> warning_result -> U-03 -> warning_cmd */
static bool do_cycle(const char *tc, int step, sbr_state_t *st, uint8_t speed,
                     bool occ, bool belt)
{
    sbr_input_t in;
    bool result;

    in.vehicle_speed = speed;
    in.passenger_occupied = occ;
    in.seatbelt_buckled = belt;

    result = sbr_judge_warning(&in);
    sbr_output_warning(st, result);

    ears_actual_i(tc, step, "warning_result", (long long)result);
    ears_actual_i(tc, step, "warning_cmd", (long long)st->warning_cmd);
    return st->warning_cmd;
}

/* 기대값과 비교하고 실패 시 진단 줄을 출력한다. 일치하면 1, 아니면 0 */
static int match(const char *tc, int step, bool expected, bool got)
{
    if (expected != got) {
        printf("  %s: expected warning_cmd=%d, got warning_cmd=%d (step=%d)\n",
               tc, (int)expected, (int)got, step);
        return 0;
    }
    return 1;
}

/* 결과 줄을 출력하고 실패면 1 을 돌려준다 */
static int finish(const char *tc, int ok)
{
    printf("%s %s\n", tc, ok ? "pass" : "fail");
    return ok ? 0 : 1;
}

/* 초기화 한 단계 + 판단 한 번의 단일 시나리오 */
static int single(const char *tc, uint8_t speed, bool occ, bool belt, bool expected)
{
    sbr_state_t st;
    bool got;
    int ok;

    sbr_init_output(&st);
    ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);
    got = do_cycle(tc, 2, &st, speed, occ, belt);
    ok = match(tc, 2, expected, got);
    return finish(tc, ok);
}

int ears_suite_int_02(void)
{
    int failed = 0;

    /* ---- REQ-SBR-01-1: 탑승 AND 미착용 AND 15~200 km/h 이면 TRUE ---- */

    /* @testcase TC-INT-02-SBR-01-1-001
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-02
     * @method requirement, boundary
     * 속도 14 km/h (하한 경계 바로 아래) -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-1-001")) {
        failed += single("TC-INT-02-SBR-01-1-001", 14, true, false, false);
    }

    /* @testcase TC-INT-02-SBR-01-1-002
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-02
     * @method requirement, boundary
     * 속도 15 km/h (하한 경계) -> TRUE */
    if (ears_tc_selected("TC-INT-02-SBR-01-1-002")) {
        failed += single("TC-INT-02-SBR-01-1-002", 15, true, false, true);
    }

    /* @testcase TC-INT-02-SBR-01-1-003
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-02
     * @method requirement, boundary
     * 속도 16 km/h (하한 경계 바로 위) -> TRUE */
    if (ears_tc_selected("TC-INT-02-SBR-01-1-003")) {
        failed += single("TC-INT-02-SBR-01-1-003", 16, true, false, true);
    }

    /* @testcase TC-INT-02-SBR-01-1-004
     * @verifies REQ-SBR-01-1@v2
     * @level integration
     * @target INT-02
     * @method requirement, boundary
     * 속도 200 km/h (상한 경계) -> TRUE */
    if (ears_tc_selected("TC-INT-02-SBR-01-1-004")) {
        failed += single("TC-INT-02-SBR-01-1-004", 200, true, false, true);
    }

    /* ---- REQ-SBR-01-2: 비탑승 OR 착용 OR 15 km/h 미만 이면 FALSE ---- */

    /* @testcase TC-INT-02-SBR-01-2-001
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-02
     * @method requirement, equivalence
     * 비탑승, 미착용, 50 km/h -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-2-001")) {
        failed += single("TC-INT-02-SBR-01-2-001", 50, false, false, false);
    }

    /* @testcase TC-INT-02-SBR-01-2-002
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-02
     * @method requirement, equivalence
     * 탑승, 착용, 50 km/h -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-2-002")) {
        failed += single("TC-INT-02-SBR-01-2-002", 50, true, true, false);
    }

    /* @testcase TC-INT-02-SBR-01-2-003
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-02
     * @method requirement, boundary
     * 탑승, 미착용, 0 km/h -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-2-003")) {
        failed += single("TC-INT-02-SBR-01-2-003", 0, true, false, false);
    }

    /* @testcase TC-INT-02-SBR-01-2-004
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-02
     * @method equivalence, error-guessing
     * 비탑승, 착용, 50 km/h (두 조건 동시 충족) -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-2-004")) {
        failed += single("TC-INT-02-SBR-01-2-004", 50, false, true, false);
    }

    /* @testcase TC-INT-02-SBR-01-2-005
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-02
     * @method boundary
     * 탑승, 착용, 200 km/h (상한 경계에서도 착용이면 FALSE) -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-2-005")) {
        failed += single("TC-INT-02-SBR-01-2-005", 200, true, true, false);
    }

    /* @testcase TC-INT-02-SBR-01-2-006
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-02
     * @method boundary
     * 탑승, 미착용, 14 km/h (15 km/h 미만 구간의 상단 경계) -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-2-006")) {
        failed += single("TC-INT-02-SBR-01-2-006", 14, true, false, false);
    }

    /* @testcase TC-INT-02-SBR-01-2-007
     * @verifies REQ-SBR-01-2@v2
     * @level integration
     * @target INT-02
     * @method error-guessing
     * 탑승, 미착용, 10 km/h (이전 버전의 기준 속도, 15 km/h 로 바뀐 뒤에는 15 미만) -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-2-007")) {
        failed += single("TC-INT-02-SBR-01-2-007", 10, true, false, false);
    }

    /* ---- REQ-SBR-01-3: 초기화 직후 FALSE (이번 요청 대상 아님, 바꾸지 않음) ---- */

    /* @testcase TC-INT-02-SBR-01-3-001
     * @verifies REQ-SBR-01-3@v1
     * @level integration
     * @target INT-02
     * @method requirement, error-guessing
     * 경고가 TRUE 인 상태를 만든 뒤 초기화하면 warning_cmd = FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-3-001")) {
        const char *tc = "TC-INT-02-SBR-01-3-001";
        sbr_state_t st;
        bool got;
        int ok = 1;

        sbr_init_output(&st);
        ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);

        got = do_cycle(tc, 2, &st, 30, true, false);
        ok = match(tc, 2, true, got) && ok;

        sbr_init_output(&st);
        ears_actual_i(tc, 3, "warning_cmd", (long long)st.warning_cmd);
        ok = match(tc, 3, false, st.warning_cmd) && ok;

        failed += finish(tc, ok);
    }

    /* ---- REQ-SBR-01-4: 매 실행마다 그 실행의 입력으로 다시 정한다 ---- */

    /* @testcase TC-INT-02-SBR-01-4-001
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-02
     * @method requirement
     * 1회차 탑승/미착용/30 -> TRUE, 2회차 탑승/착용/30 -> FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-4-001")) {
        const char *tc = "TC-INT-02-SBR-01-4-001";
        sbr_state_t st;
        bool got;
        int ok = 1;

        sbr_init_output(&st);
        ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);

        got = do_cycle(tc, 2, &st, 30, true, false);
        ok = match(tc, 2, true, got) && ok;

        got = do_cycle(tc, 3, &st, 30, true, true);
        ok = match(tc, 3, false, got) && ok;

        failed += finish(tc, ok);
    }

    /* @testcase TC-INT-02-SBR-01-4-002
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-02
     * @method error-guessing
     * 순서를 뒤바꾼 경우: 1회차 착용 -> FALSE, 2회차 미착용 -> TRUE */
    if (ears_tc_selected("TC-INT-02-SBR-01-4-002")) {
        const char *tc = "TC-INT-02-SBR-01-4-002";
        sbr_state_t st;
        bool got;
        int ok = 1;

        sbr_init_output(&st);
        ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);

        got = do_cycle(tc, 2, &st, 30, true, true);
        ok = match(tc, 2, false, got) && ok;

        got = do_cycle(tc, 3, &st, 30, true, false);
        ok = match(tc, 3, true, got) && ok;

        failed += finish(tc, ok);
    }

    /* @testcase TC-INT-02-SBR-01-4-003
     * @verifies REQ-SBR-01-4@v1
     * @level integration
     * @target INT-02
     * @method boundary, error-guessing
     * 속도만 바뀌는 연속 실행: 30 -> TRUE, 14 -> FALSE, 15 -> TRUE (이전 값이 남지 않음) */
    if (ears_tc_selected("TC-INT-02-SBR-01-4-003")) {
        const char *tc = "TC-INT-02-SBR-01-4-003";
        sbr_state_t st;
        bool got;
        int ok = 1;

        sbr_init_output(&st);
        ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);

        got = do_cycle(tc, 2, &st, 30, true, false);
        ok = match(tc, 2, true, got) && ok;

        got = do_cycle(tc, 3, &st, 14, true, false);
        ok = match(tc, 3, false, got) && ok;

        got = do_cycle(tc, 4, &st, 15, true, false);
        ok = match(tc, 4, true, got) && ok;

        failed += finish(tc, ok);
    }

    /* ---- REQ-SBR-01-5: 200 km/h 초과이면 warning_cmd = FALSE ---- */

    /* @testcase TC-INT-02-SBR-01-5-001
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-02
     * @method requirement, boundary
     * 탑승, 미착용, 201 km/h (상한 경계 바로 위) -> warning_cmd = FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-5-001")) {
        failed += single("TC-INT-02-SBR-01-5-001", 201, true, false, false);
    }

    /* @testcase TC-INT-02-SBR-01-5-002
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-02
     * @method requirement, boundary
     * 탑승, 미착용, 255 km/h (uint8_t 최대값, 범위 밖) -> warning_cmd = FALSE */
    if (ears_tc_selected("TC-INT-02-SBR-01-5-002")) {
        failed += single("TC-INT-02-SBR-01-5-002", 255, true, false, false);
    }

    /* @testcase TC-INT-02-SBR-01-5-003
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-02
     * @method boundary, error-guessing
     * 경계 전후 연속 실행(탑승, 미착용): 200 -> TRUE, 201 -> FALSE, 200 -> TRUE
     * (200 의 TRUE 는 REQ-SBR-01-1 수용 범위. 범위 밖에서 꺼지고 다시 돌아오면 켜진다) */
    if (ears_tc_selected("TC-INT-02-SBR-01-5-003")) {
        const char *tc = "TC-INT-02-SBR-01-5-003";
        sbr_state_t st;
        bool got;
        int ok = 1;

        sbr_init_output(&st);
        ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);

        got = do_cycle(tc, 2, &st, 200, true, false);
        ok = match(tc, 2, true, got) && ok;

        got = do_cycle(tc, 3, &st, 201, true, false);
        ok = match(tc, 3, false, got) && ok;

        got = do_cycle(tc, 4, &st, 200, true, false);
        ok = match(tc, 4, true, got) && ok;

        failed += finish(tc, ok);
    }

    /* @testcase TC-INT-02-SBR-01-5-004
     * @verifies REQ-SBR-01-5@v1
     * @level integration
     * @target INT-02
     * @method error-guessing
     * 경고가 TRUE 인 상태(30 km/h)에서 255 km/h 로 바뀌면 warning_cmd = FALSE (이전 TRUE 가 남지 않음) */
    if (ears_tc_selected("TC-INT-02-SBR-01-5-004")) {
        const char *tc = "TC-INT-02-SBR-01-5-004";
        sbr_state_t st;
        bool got;
        int ok = 1;

        sbr_init_output(&st);
        ears_actual_i(tc, 1, "warning_cmd", (long long)st.warning_cmd);

        got = do_cycle(tc, 2, &st, 30, true, false);
        ok = match(tc, 2, true, got) && ok;

        got = do_cycle(tc, 3, &st, 255, true, false);
        ok = match(tc, 3, false, got) && ok;

        failed += finish(tc, ok);
    }

    return failed != 0 ? 1 : 0;
}
