#include <stddef.h>

#include "controller.h"

/* 판정 기준 값: 모두 승인된 요구사항 문장에서 온 값이다. */
static const double CTL_TEMP_VALID_MIN_C = -40.0;      /* REQ-CTL-01-4, 01-5 */
static const double CTL_TEMP_VALID_MAX_C = 150.0;      /* REQ-CTL-01-4, 01-5 */
static const double CTL_TEMP_LATCH_SET_C = 75.0;       /* REQ-CTL-02-1@v2, REQ-CTL-02-4@v2, REQ-CTL-03-4@v1 */
static const double CTL_TEMP_LATCH_RELEASE_C = 70.0;   /* REQ-CTL-02-3@v2, 03-1@v2, 03-2@v2: 미만이면 해제 가능 */

/**
 * @implements SWD-CTL-003, SWD-CTL-004, SWD-CTL-005
 * @req     REQ-CTL-01-3@v1, REQ-CTL-01-4@v1, REQ-CTL-01-5@v1
 * @ears    UNWANTED/EVENT: 플래그 False 또는 온도가 NaN·±∞·범위 밖이면 무효, 플래그 True 이고 온도가 유효 범위 안이면 유효
 * @pre     없음 (모든 입력값을 받는다)
 * @post    반환값 true = 입력 유효
 * @range   temp_c: double [°C], 유효 범위 -40.0 이상 150.0 이하 (경계 포함)
 */
bool ctl_is_input_valid(double temp_c, bool sensor_valid)
{
    bool valid = false;

    if (!sensor_valid) {
        /* 센서 유효성 플래그 False: 온도와 무관하게 무효 (REQ-CTL-01-3) */
        valid = false;
    } else if ((temp_c >= CTL_TEMP_VALID_MIN_C) && (temp_c <= CTL_TEMP_VALID_MAX_C)) {
        /* NaN 은 비교가 모두 거짓, ±∞ 는 범위 밖이므로 둘 다 이 분기에 오지 않는다 (REQ-CTL-01-4, 01-5) */
        valid = true;
    } else {
        valid = false;
    }

    return valid;
}

/**
 * @implements SWD-CTL-006
 * @req     REQ-CTL-01-6@v1, REQ-CTL-01-7@v1, REQ-CTL-01-8@v1
 * @ears    EVENT: 입력 무효이면 고장 플래그 True, 유효이면 False
 * @pre     valid 는 ctl_is_input_valid 의 결과
 * @post    반환값 = 센서 고장 플래그의 새 값
 * @range   valid: bool
 */
static bool ctl_next_fault(bool valid)
{
    bool fault = false;

    if (valid) {
        fault = false;
    } else {
        fault = true;
    }

    return fault;
}

/**
 * @implements SWD-CTL-007, SWD-CTL-008, SWD-CTL-009
 * @req     REQ-CTL-02-1@v2, REQ-CTL-02-2@v1, REQ-CTL-02-3@v2, REQ-CTL-02-4@v2,
 *          REQ-CTL-03-1@v2, REQ-CTL-03-2@v2, REQ-CTL-03-3@v1, REQ-CTL-03-4@v1
 * @domain  자동차, ISO 26262-6:2018, ASIL D, AUTO-CD
 * @ears    UNWANTED: 무효이면 리셋 요청과 무관하게 활성화하거나 활성 유지,
 *          EVENT: 유효 75.0 이상이면 감지 센서 활성 여부와 무관하게 활성화,
 *          STATE: 활성 중 리셋·유효·70.0 미만일 때만 해제,
 *          비활성 중 유효·75.0 미만이면 리셋 요청 여부와 무관하게 비활성 유지
 * @pre     valid 는 ctl_is_input_valid 의 결과
 * @post    반환값 = 정지 래치의 새 값 (true = 활성)
 *          latch가 true이고 valid가 false이면 reset_request와 무관하게 true
 *          latch가 false이고 valid가 true이며 temp_c가 75.0 미만이면 false
 *          valid가 true이고 temp_c가 75.0 이상이면 latch, reset_request와 무관하게 true
 * @range   latch, valid, reset_request: bool, 단위 없음
 *          temp_c: double [°C]. valid 가 true 일 때만 비교에 쓴다
 */
static bool ctl_next_latch(bool latch, bool valid, double temp_c, bool reset_request)
{
    bool next = latch;

    if (!valid) {
        /* 입력 무효: 리셋 요청과 무관하게 활성 (REQ-CTL-02-2@v1, REQ-CTL-03-3@v1, REQ-CTL-03-4@v1) */
        next = true;
    } else if (temp_c >= CTL_TEMP_LATCH_SET_C) {
        /* 유효 입력 75.0 이상: 리셋 요청·감지 센서 활성 여부와 무관하게 활성 (REQ-CTL-02-1@v2, REQ-CTL-03-4@v1) */
        next = true;
    } else if (latch && reset_request && (temp_c < CTL_TEMP_LATCH_RELEASE_C)) {
        /* 활성, 리셋 요청, 유효, 70.0 미만: 해제 (REQ-CTL-03-1@v2) */
        next = false;
    } else {
        /* 비활성·유효·75.0 미만이면 리셋 요청 여부와 무관하게 비활성 유지 (REQ-CTL-02-4@v2) */
        next = latch;
    }

    return next;
}

/**
 * @implements SWD-CTL-001
 * @req     REQ-CTL-01-1@v1
 * @ears    EVENT: 초기화되면 정지 명령, 센서 고장 플래그, 정지 래치를 False 로 설정
 * @pre     state 는 NULL 이 아니어야 동작한다
 * @post    세 멤버가 모두 false
 * @range   해당 없음
 */
void ctl_init(ctl_state_t *state)
{
    if (state != NULL) {
        state->stop_cmd = false;
        state->sensor_fault = false;
        state->stop_latch = false;
    }
}

/**
 * @implements SWD-CTL-002, SWD-CTL-010
 * @req     REQ-CTL-01-2@v1, REQ-CTL-04@v1
 * @domain  자동차, ISO 26262-6:2018, ASIL D, AUTO-CD
 * @ears    EVENT: 호출 안에서 입력 평가 후 출력·상태 갱신, 종료 시 정지 명령 = 정지 래치
 * @pre     state 는 유효한 ctl_state_t 객체를 가리킨다. 기존 NULL 무동작 처리는 유지한다
 * @post    유효한 state에 대해 sensor_fault, stop_latch가 갱신되고 stop_cmd는 최종 stop_latch와 같다
 *          호출 전 stop_cmd 값과 무관하게 최종 래치가 true이면 true, false이면 false
 * @range   temp_c: double [°C], NaN·±∞ 포함; 불리언 신호는 단위 없음
 */
void ctl_step(ctl_state_t *state, double temp_c, bool sensor_valid, bool reset_request)
{
    if (state != NULL) {
        const bool valid = ctl_is_input_valid(temp_c, sensor_valid);

        state->sensor_fault = ctl_next_fault(valid);
        state->stop_latch = ctl_next_latch(state->stop_latch, valid, temp_c, reset_request);
        state->stop_cmd = state->stop_latch;
    }

    return;
}

/**
 * @implements SWD-CTL-011
 * @req     REQ-CTL-02-1@v2
 * @domain  자동차, ISO 26262-6:2018, ASIL D, AUTO-CD
 * @ears    EVENT: WHEN 입력 유효 AND temp_c >= 75.0 °C, THEN 감지 센서 활성 여부와 무관하게
 *          동일 호출에서 정지 래치 = 활성
 * @pre     state 는 유효한 ctl_state_t 객체를 가리킨다. NULL 이면 아무것도 하지 않는다
 * @post    유효한 state에 대해 ctl_step 과 같은 결과. 유효 입력이고 temp_c가 75.0 이상이면
 *          detect_active 값과 무관하게 stop_latch 가 true, stop_cmd 는 stop_latch 와 같다
 * @range   temp_c: double [°C], NaN·±∞ 포함; detect_active 와 불리언 신호는 단위 없음
 */
void ctl_step_detect(ctl_state_t *state, double temp_c, bool sensor_valid, bool reset_request, bool detect_active)
{
    /* 감지 센서 활성 여부는 정지 래치 판정에 쓰지 않는다 (REQ-CTL-02-1@v2). 의도적 미사용. */
    (void)detect_active;

    if (state != NULL) {
        const bool valid = ctl_is_input_valid(temp_c, sensor_valid);

        state->sensor_fault = ctl_next_fault(valid);
        state->stop_latch = ctl_next_latch(state->stop_latch, valid, temp_c, reset_request);
        state->stop_cmd = state->stop_latch;
    }

    return;
}
