# 과열 보호 모듈 상세 설계 (추적 점검기 시험용 예시)

가상의 산업제어 과열 보호 모듈이다. 추적 태그 규칙을 보여 주기 위한 예시이며 실제 제품 설계가 아니다.

## 인터페이스

- 입력 `otp_input_t`: `sensor_valid`(센서 값 유효 여부), `temp_decic`(온도, 0.1 °C 단위 정수)
- 출력 `bool`: 정지 명령 활성 여부
- 임계값 `OTP_STOP_THRESHOLD_DECIC` = 750 (75.0 °C)

## SWD-OTP-001 임계 온도 정지 판정

@design SWD-OTP-001
@satisfies REQ-OTP-01-1@v1

센서 값이 유효하고 `temp_decic >= OTP_STOP_THRESHOLD_DECIC` 이면 정지 명령을 활성화한다. 부동소수 비교 오차를 피하려고 온도를 0.1 °C 단위 정수로 다룬다.

## SWD-OTP-002 센서 무효 시 정지

@design SWD-OTP-002
@satisfies REQ-OTP-01-2@v1

센서 값이 무효이면 온도 값과 관계없이 정지 명령을 활성화한다.
