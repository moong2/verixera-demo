#ifndef OVERHEAT_PROTECTION_H
#define OVERHEAT_PROTECTION_H

#include <stdbool.h>
#include <stdint.h>

/* 정지 임계 온도: 75.0 °C (0.1 °C 단위) */
#define OTP_STOP_THRESHOLD_DECIC 750

typedef struct {
    bool sensor_valid;   /* 센서 값 유효 여부 */
    int32_t temp_decic;  /* 온도, 0.1 °C 단위 */
} otp_input_t;

bool otp_should_stop(const otp_input_t *input);

#endif
