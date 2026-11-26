#include "seatbelt_reminder.h"

/*
 * 입력 신호 취득: 같은 실행의 세 값을 그대로 sbr_input_t 에 채운다
 * @implements SWD-SBR-006
 * @unit U-01
 * @pre  input 은 유효한 포인터
 * @post 값을 바꾸거나 제한하지 않고 전달한다(201~255 km/h 포함)
 * @range vehicle_speed: uint8_t, 1 km/h/LSB
 */
void sbr_acquire_inputs(sbr_input_t *input, uint8_t vehicle_speed,
                        bool passenger_occupied, bool seatbelt_buckled)
{
    input->vehicle_speed = vehicle_speed;
    input->passenger_occupied = passenger_occupied;
    input->seatbelt_buckled = seatbelt_buckled;
}

/*
 * 속도 유효 범위 판단: 200 km/h 이하이면 유효
 * @implements SWD-SBR-005
 * @unit U-02
 */
bool sbr_speed_in_range(uint8_t vehicle_speed)
{
    return vehicle_speed <= SBR_SPEED_MAX_KMH;
}

/*
 * 속도 판단: 경고 기준 속도(15 km/h) '이상'(>=)
 * @implements SWD-SBR-001
 * @unit U-02
 */
bool sbr_speed_reached(uint8_t vehicle_speed)
{
    return vehicle_speed >= SBR_WARN_SPEED_KMH;
}

/*
 * 탑승·벨트 판단: 탑승 AND 미착용
 * @implements SWD-SBR-002
 * @unit U-02
 */
bool sbr_passenger_unbelted(bool passenger_occupied, bool seatbelt_buckled)
{
    return passenger_occupied && !seatbelt_buckled;
}

/*
 * 최종 경고 판단: 실행할 때마다 그 입력으로 warning_result 를 다시 계산한다
 * 이전 실행의 결과를 기억하지 않는다.
 * @implements SWD-SBR-004
 * @unit U-02
 * @pre  input 은 유효한 포인터
 * @post 반환값 true = 경고 켬(15 <= 속도 <= 200, 탑승, 미착용)
 */
bool sbr_judge_warning(const sbr_input_t *input)
{
    bool warning_result = false;

    if (sbr_speed_in_range(input->vehicle_speed)
        && sbr_speed_reached(input->vehicle_speed)
        && sbr_passenger_unbelted(input->passenger_occupied, input->seatbelt_buckled)) {
        warning_result = true;
    } else {
        warning_result = false;
    }
    return warning_result;
}

/*
 * 초기화: 경고 명령을 끈다
 * @implements SWD-SBR-003
 * @unit U-03
 */
void sbr_init_output(sbr_state_t *state)
{
    state->warning_cmd = false;
}

/*
 * 경고 명령 출력: 받은 warning_result 를 그대로 warning_cmd 로 출력한다
 * 이전 warning_cmd 값에 의존하지 않는다.
 * @implements SWD-SBR-007
 * @unit U-03
 */
void sbr_output_warning(sbr_state_t *state, bool warning_result)
{
    state->warning_cmd = warning_result;
}
