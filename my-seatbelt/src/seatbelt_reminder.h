#ifndef SEATBELT_REMINDER_H
#define SEATBELT_REMINDER_H

#include <stdbool.h>
#include <stdint.h>

/* 경고 기준 속도 (km/h). REQ-SBR-01-1@v2, REQ-SBR-01-2@v2 에서 15 km/h 로 정해졌다 */
#define SBR_WARN_SPEED_KMH 15u

/* 차량 속도 유효 범위의 최대값 (km/h). 201~255 는 범위 밖 */
#define SBR_SPEED_MAX_KMH 200u

typedef struct {
    uint8_t vehicle_speed;     /* 차량 속도, 1 km/h/LSB, 유효 0~200 */
    bool passenger_occupied;   /* 동승석 탑승 여부 */
    bool seatbelt_buckled;     /* 안전벨트 착용 여부 */
} sbr_input_t;

typedef struct {
    bool warning_cmd;          /* 경고 명령 */
} sbr_state_t;

/* U-01 입력 신호 취득 */
void sbr_acquire_inputs(sbr_input_t *input, uint8_t vehicle_speed,
                        bool passenger_occupied, bool seatbelt_buckled);

/* U-02 경고 조건 판정 */
bool sbr_speed_in_range(uint8_t vehicle_speed);
bool sbr_speed_reached(uint8_t vehicle_speed);
bool sbr_passenger_unbelted(bool passenger_occupied, bool seatbelt_buckled);
bool sbr_judge_warning(const sbr_input_t *input);

/* U-03 경고 명령 출력 및 초기화 */
void sbr_init_output(sbr_state_t *state);
void sbr_output_warning(sbr_state_t *state, bool warning_result);

#endif
