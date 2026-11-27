/*
 * SW 수준 시험: 안전벨트 경고 제어기 (REQ-SBR-01-1, -2, -3, -4, -5)
 *
 * SW 외부 경계만 사용한다.
 *   입력(STIMULUS)       : vehicle_speed, passenger_occupied, seatbelt_buckled
 *   출력(EXPECTED_OUTPUT): warning_cmd
 * 유닛 사이 값 warning_result 는 판정하지 않고 다음 호출로 넘기기만 한다.
 * 기대값은 모두 요구사항 수용 기준의 숫자(km/h)에서 정했다.
 *   경고 기준 15 km/h, 상한 200 km/h (200 km/h 초과는 범위 밖, 경고 명령 FALSE)
 *
 * 한 번의 판단 실행 = 입력 취득, 경고 조건 판정, 경고 명령 출력을 차례로 호출.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#include "ears_tc.h"
#include "seatbelt_reminder.h"

int ears_suite_sw(void);

typedef struct {
    uint8_t vehicle_speed;
    bool passenger_occupied;
    bool seatbelt_buckled;
    bool expected_warning_cmd;
} cycle_t;

/* 판단을 한 번 실행하고 출력된 warning_cmd 를 돌려준다 */
static bool run_cycle(sbr_state_t *state, uint8_t speed, bool occupied,
                      bool buckled)
{
    sbr_input_t input;
    sbr_acquire_inputs(&input, speed, occupied, buckled);
    sbr_output_warning(state, sbr_judge_warning(&input));
    return state->warning_cmd;
}

/* 초기화 뒤 주어진 입력열을 차례로 실행하며 매 회차의 warning_cmd 를 확인한다.
 * 단계 1 = 초기화, 단계 2 부터 회차 순서 */
static int run_seq(const char *tc, const cycle_t *seq, int n)
{
    sbr_state_t state;
    int ok = 1;
    int i;

    sbr_init_output(&state);
    for (i = 0; i < n; i++) {
        bool got = run_cycle(&state, seq[i].vehicle_speed,
                             seq[i].passenger_occupied,
                             seq[i].seatbelt_buckled);
        ears_actual_i(tc, i + 2, "warning_cmd", (long long)got);
        if (got != seq[i].expected_warning_cmd) {
            ok = 0;
            printf("  %s: expected warning_cmd=%d, got warning_cmd=%d "
                   "(vehicle_speed=%u, passenger_occupied=%d, seatbelt_buckled=%d)\n",
                   tc, (int)seq[i].expected_warning_cmd, (int)got,
                   (unsigned)seq[i].vehicle_speed,
                   (int)seq[i].passenger_occupied,
                   (int)seq[i].seatbelt_buckled);
        }
    }
    printf("%s %s\n", tc, ok ? "pass" : "fail");
    return ok ? 0 : 1;
}

#define SEQ_LEN(a) ((int)(sizeof(a) / sizeof((a)[0])))

int ears_suite_sw(void)
{
    int fail = 0;

    /* ---------------- REQ-SBR-01-1 ---------------- */

    /* @testcase TC-SW-SBR-01-1-001
     * @verifies REQ-SBR-01-1@v2
     * @level software
     * @target SW
     * @method requirement, boundary
     * 경계 바로 아래: 탑승, 미착용, 14 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-1-001")) {
        static const cycle_t c[] = { { 14, true, false, false } };
        fail |= run_seq("TC-SW-SBR-01-1-001", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-1-002
     * @verifies REQ-SBR-01-1@v2
     * @level software
     * @target SW
     * @method requirement, boundary
     * 하한 경계: 15 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SW-SBR-01-1-002")) {
        static const cycle_t c[] = { { 15, true, false, true } };
        fail |= run_seq("TC-SW-SBR-01-1-002", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-1-003
     * @verifies REQ-SBR-01-1@v2
     * @level software
     * @target SW
     * @method requirement, boundary
     * 경계 바로 위: 16 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SW-SBR-01-1-003")) {
        static const cycle_t c[] = { { 16, true, false, true } };
        fail |= run_seq("TC-SW-SBR-01-1-003", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-1-004
     * @verifies REQ-SBR-01-1@v2
     * @level software
     * @target SW
     * @method requirement, boundary
     * 상한 경계: 200 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SW-SBR-01-1-004")) {
        static const cycle_t c[] = { { 200, true, false, true } };
        fail |= run_seq("TC-SW-SBR-01-1-004", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-1-005
     * @verifies REQ-SBR-01-1@v2
     * @level software
     * @target SW
     * @method equivalence
     * 유효 구간 대표값: 100 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SW-SBR-01-1-005")) {
        static const cycle_t c[] = { { 100, true, false, true } };
        fail |= run_seq("TC-SW-SBR-01-1-005", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-1-006
     * @verifies REQ-SBR-01-1@v2
     * @level software
     * @target SW
     * @method boundary
     * 상한 바로 아래: 199 km/h 이면 TRUE */
    if (ears_tc_selected("TC-SW-SBR-01-1-006")) {
        static const cycle_t c[] = { { 199, true, false, true } };
        fail |= run_seq("TC-SW-SBR-01-1-006", c, SEQ_LEN(c));
    }

    /* ---------------- REQ-SBR-01-2 ---------------- */

    /* @testcase TC-SW-SBR-01-2-001
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method requirement, equivalence
     * 탑승자 없음(미착용, 50 km/h) 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-001")) {
        static const cycle_t c[] = { { 50, false, false, false } };
        fail |= run_seq("TC-SW-SBR-01-2-001", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-002
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method requirement, equivalence
     * 탑승, 착용, 50 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-002")) {
        static const cycle_t c[] = { { 50, true, true, false } };
        fail |= run_seq("TC-SW-SBR-01-2-002", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-003
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method requirement, boundary
     * 탑승, 미착용, 0 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-003")) {
        static const cycle_t c[] = { { 0, true, false, false } };
        fail |= run_seq("TC-SW-SBR-01-2-003", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-004
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method equivalence
     * 탑승자 없음과 착용이 함께(50 km/h) 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-004")) {
        static const cycle_t c[] = { { 50, false, true, false } };
        fail |= run_seq("TC-SW-SBR-01-2-004", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-005
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method boundary
     * 상한 200 km/h 에서도 탑승자 없음이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-005")) {
        static const cycle_t c[] = { { 200, false, false, false } };
        fail |= run_seq("TC-SW-SBR-01-2-005", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-006
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method boundary
     * 상한 200 km/h 에서도 착용이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-006")) {
        static const cycle_t c[] = { { 200, true, true, false } };
        fail |= run_seq("TC-SW-SBR-01-2-006", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-007
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method boundary
     * 속도 조건 경계 바로 아래: 탑승, 미착용, 14 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-007")) {
        static const cycle_t c[] = { { 14, true, false, false } };
        fail |= run_seq("TC-SW-SBR-01-2-007", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-008
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method boundary
     * 속도 경계 15 km/h 에서도 착용이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-008")) {
        static const cycle_t c[] = { { 15, true, true, false } };
        fail |= run_seq("TC-SW-SBR-01-2-008", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-009
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method boundary
     * 속도 경계 15 km/h 에서도 탑승자 없음이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-009")) {
        static const cycle_t c[] = { { 15, false, false, false } };
        fail |= run_seq("TC-SW-SBR-01-2-009", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-2-010
     * @verifies REQ-SBR-01-2@v2
     * @level software
     * @target SW
     * @method boundary
     * 이전 기준(10 km/h)이 남아 있지 않은지: 탑승, 미착용, 10 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-2-010")) {
        static const cycle_t c[] = { { 10, true, false, false } };
        fail |= run_seq("TC-SW-SBR-01-2-010", c, SEQ_LEN(c));
    }

    /* ---------------- REQ-SBR-01-3 ---------------- */

    /* @testcase TC-SW-SBR-01-3-001
     * @verifies REQ-SBR-01-3@v1
     * @level software
     * @target SW
     * @method requirement
     * 초기화 직후 warning_cmd = FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-3-001")) {
        sbr_state_t state;
        bool ok;
        sbr_init_output(&state);
        ears_actual_i("TC-SW-SBR-01-3-001", 1, "warning_cmd",
                      (long long)state.warning_cmd);
        ok = (state.warning_cmd == false);
        if (!ok) {
            printf("  TC-SW-SBR-01-3-001: expected warning_cmd=0, got warning_cmd=%d\n",
                   (int)state.warning_cmd);
        }
        printf("TC-SW-SBR-01-3-001 %s\n", ok ? "pass" : "fail");
        fail |= ok ? 0 : 1;
    }

    /* @testcase TC-SW-SBR-01-3-002
     * @verifies REQ-SBR-01-3@v1
     * @level software
     * @target SW
     * @method requirement, error-guessing
     * 경고가 켜진 상태(TRUE)에서 다시 초기화하면 warning_cmd = FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-3-002")) {
        sbr_state_t state;
        bool before;
        bool ok;
        sbr_init_output(&state);
        before = run_cycle(&state, 30, true, false);
        ears_actual_i("TC-SW-SBR-01-3-002", 2, "warning_cmd", (long long)before);
        sbr_init_output(&state);
        ears_actual_i("TC-SW-SBR-01-3-002", 3, "warning_cmd",
                      (long long)state.warning_cmd);
        ok = (before == true) && (state.warning_cmd == false);
        if (!ok) {
            printf("  TC-SW-SBR-01-3-002: expected warning_cmd=1 then 0 after init, "
                   "got %d then %d\n", (int)before, (int)state.warning_cmd);
        }
        printf("TC-SW-SBR-01-3-002 %s\n", ok ? "pass" : "fail");
        fail |= ok ? 0 : 1;
    }

    /* ---------------- REQ-SBR-01-4 ---------------- */

    /* @testcase TC-SW-SBR-01-4-001
     * @verifies REQ-SBR-01-4@v1
     * @level software
     * @target SW
     * @method requirement
     * 수용 기준 순서: 30 km/h 탑승 미착용 TRUE 다음 착용 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-4-001")) {
        static const cycle_t c[] = {
            { 30, true, false, true },
            { 30, true, true, false }
        };
        fail |= run_seq("TC-SW-SBR-01-4-001", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-4-002
     * @verifies REQ-SBR-01-4@v1
     * @level software
     * @target SW
     * @method error-guessing
     * 순서를 뒤집은 경우: 착용 FALSE 다음 미착용 TRUE */
    if (ears_tc_selected("TC-SW-SBR-01-4-002")) {
        static const cycle_t c[] = {
            { 30, true, true, false },
            { 30, true, false, true }
        };
        fail |= run_seq("TC-SW-SBR-01-4-002", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-4-003
     * @verifies REQ-SBR-01-4@v1
     * @level software
     * @target SW
     * @method error-guessing, boundary
     * 속도만 바뀌는 경우: 30 TRUE, 14 FALSE, 15 TRUE 로 매회 다시 정한다
     * (경고 기준 15 km/h 의 바로 아래와 경계) */
    if (ears_tc_selected("TC-SW-SBR-01-4-003")) {
        static const cycle_t c[] = {
            { 30, true, false, true },
            { 14, true, false, false },
            { 15, true, false, true }
        };
        fail |= run_seq("TC-SW-SBR-01-4-003", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-4-004
     * @verifies REQ-SBR-01-4@v1
     * @level software
     * @target SW
     * @method error-guessing
     * 탑승자가 내린 경우: 30 TRUE 다음 탑승 없음 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-4-004")) {
        static const cycle_t c[] = {
            { 30, true, false, true },
            { 30, false, false, false }
        };
        fail |= run_seq("TC-SW-SBR-01-4-004", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-4-005
     * @verifies REQ-SBR-01-4@v1
     * @level software
     * @target SW
     * @method equivalence
     * 같은 입력을 되풀이해도 매회 같은 결과(TRUE, TRUE) */
    if (ears_tc_selected("TC-SW-SBR-01-4-005")) {
        static const cycle_t c[] = {
            { 30, true, false, true },
            { 30, true, false, true }
        };
        fail |= run_seq("TC-SW-SBR-01-4-005", c, SEQ_LEN(c));
    }

    /* ---------------- REQ-SBR-01-5 ---------------- */

    /* @testcase TC-SW-SBR-01-5-001
     * @verifies REQ-SBR-01-5@v1
     * @level software
     * @target SW
     * @method requirement, boundary
     * 수용 기준: 탑승, 미착용, 201 km/h(상한 200 바로 위) 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-5-001")) {
        static const cycle_t c[] = { { 201, true, false, false } };
        fail |= run_seq("TC-SW-SBR-01-5-001", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-5-002
     * @verifies REQ-SBR-01-5@v1
     * @level software
     * @target SW
     * @method requirement, boundary
     * 수용 기준: 탑승, 미착용, 255 km/h(자료형 최대) 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-5-002")) {
        static const cycle_t c[] = { { 255, true, false, false } };
        fail |= run_seq("TC-SW-SBR-01-5-002", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-5-003
     * @verifies REQ-SBR-01-5@v1
     * @level software
     * @target SW
     * @method equivalence
     * 범위 밖 구간 대표값: 탑승, 미착용, 230 km/h 이면 FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-5-003")) {
        static const cycle_t c[] = { { 230, true, false, false } };
        fail |= run_seq("TC-SW-SBR-01-5-003", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-5-004
     * @verifies REQ-SBR-01-5@v1
     * @level software
     * @target SW
     * @method boundary, error-guessing
     * 경계 전후를 매회 다시 정한다: 200 TRUE, 201 FALSE, 200 TRUE */
    if (ears_tc_selected("TC-SW-SBR-01-5-004")) {
        static const cycle_t c[] = {
            { 200, true, false, true },
            { 201, true, false, false },
            { 200, true, false, true }
        };
        fail |= run_seq("TC-SW-SBR-01-5-004", c, SEQ_LEN(c));
    }

    /* @testcase TC-SW-SBR-01-5-005
     * @verifies REQ-SBR-01-5@v1
     * @level software
     * @target SW
     * @method error-guessing
     * 경고가 켜진 상태에서 범위 밖 속도가 들어오면 안전 쪽 FALSE:
     * 30 km/h TRUE 다음 255 km/h FALSE */
    if (ears_tc_selected("TC-SW-SBR-01-5-005")) {
        static const cycle_t c[] = {
            { 30, true, false, true },
            { 255, true, false, false }
        };
        fail |= run_seq("TC-SW-SBR-01-5-005", c, SEQ_LEN(c));
    }

    return fail;
}
