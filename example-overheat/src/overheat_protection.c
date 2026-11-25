#include "overheat_protection.h"

/*
 * 정지 명령 판정.
 * 센서 값이 무효이면 온도와 관계없이 정지하고, 유효하면 임계 온도 이상일 때 정지한다.
 * 함수의 출구는 하나다(프로젝트 설정의 코딩 규칙).
 * @implements SWD-OTP-001, SWD-OTP-002
 */
bool otp_should_stop(const otp_input_t *input)
{
    bool stop = true; /* 센서 값이 무효일 때의 결과 */

    if (input->sensor_valid) {
        stop = (input->temp_decic >= OTP_STOP_THRESHOLD_DECIC);
    }
    return stop;
}
