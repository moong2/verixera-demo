#ifndef CONTROLLER_H
#define CONTROLLER_H

#include <stdbool.h>

/*
 * 과열 정지 제어기 인터페이스 (설계: docs/design/controller.md)
 */

/* 제어기 상태. 정지 명령은 출력, 나머지는 내부 상태이다. */
typedef struct {
    bool stop_cmd;     /* 정지 명령 출력 */
    bool sensor_fault; /* 센서 고장 플래그 */
    bool stop_latch;   /* 정지 래치 (true = 활성) */
} ctl_state_t;

/* 제어기를 초기화한다. 세 멤버를 모두 false 로 설정한다. state 가 NULL 이면 아무것도 하지 않는다. */
void ctl_init(ctl_state_t *state);

/*
 * 제어 함수. 한 번의 호출 안에서 입력을 평가하고 출력과 내부 상태를 갱신한다.
 * temp_c: 온도 [°C], sensor_valid: 센서 유효성 플래그, reset_request: 리셋 요청
 * state 가 NULL 이면 아무것도 하지 않는다.
 */
void ctl_step(ctl_state_t *state, double temp_c, bool sensor_valid, bool reset_request);

/*
 * 감지 센서 입력을 받는 제어 함수 (REQ-CTL-02-1@v2).
 * detect_active: 감지 센서 활성 상태 (true = 활성, 단위 없음). 정지 래치 판정과 무관하다.
 * 나머지 인자와 동작은 ctl_step 과 같다. state 가 NULL 이면 아무것도 하지 않는다.
 */
void ctl_step_detect(ctl_state_t *state, double temp_c, bool sensor_valid, bool reset_request, bool detect_active);

/* 입력 유효성 판정. true = 유효, false = 무효. temp_c 단위는 °C. */
bool ctl_is_input_valid(double temp_c, bool sensor_valid);

#endif /* CONTROLLER_H */
