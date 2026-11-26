# 동승석 안전벨트 경고(SBR) 상세 설계 (교육용 예시)

교육용으로 단순화한 예제다. 실제 양산 명세나 법규 충족을 뜻하지 않는다.
범위에서 뺀 것: 물리 응답시간, 센서 고장 대응, 경고음 패턴. 범위 밖 속도(200 km/h 초과)는 경고를 끈다(REQ-SBR-01-5).
호출 주기는 요구사항에 없어 정하지 않았다. 한 번의 실행 안에서 U-01 → U-02 → U-03 순서로 모두 끝낸다.

## 인터페이스

@signal vehicle_speed@v1 → input->vehicle_speed
@signal passenger_occupied@v1 → input->passenger_occupied
@signal seatbelt_buckled@v1 → input->seatbelt_buckled
@signal warning_cmd@v1 → state->warning_cmd

함수 목록(헤더 `src/seatbelt_reminder.h`):

| 함수 | 입력 | 출력 |
|---|---|---|
| `void sbr_acquire_inputs(sbr_input_t *input, uint8_t vehicle_speed, bool passenger_occupied, bool seatbelt_buckled)` | 외부에서 읽은 세 값 | `*input` 에 세 값을 그대로 채운다 |
| `bool sbr_speed_reached(uint8_t vehicle_speed)` | 속도(km/h) | 15 km/h 이상이면 true |
| `bool sbr_speed_in_range(uint8_t vehicle_speed)` | 속도(km/h) | 200 km/h 이하이면 true |
| `bool sbr_passenger_unbelted(bool passenger_occupied, bool seatbelt_buckled)` | 탑승, 착용 | 탑승 AND 미착용이면 true |
| `bool sbr_judge_warning(const sbr_input_t *input)` | `sbr_input_t` | `warning_result` |
| `void sbr_init_output(sbr_state_t *state)` | 상태 | `state->warning_cmd` = false |
| `void sbr_output_warning(sbr_state_t *state, bool warning_result)` | 상태, `warning_result` | `state->warning_cmd` = `warning_result` |

- 입력 `sbr_input_t`(U-01 소유): `vehicle_speed`(`uint8_t`, 1 km/h/LSB, 유효 범위 0~200 km/h, 201~255 는 범위 밖), `passenger_occupied`(`bool`), `seatbelt_buckled`(`bool`). U-01 은 외부 값을 읽어 `sbr_input_t` 에 쓰고(READ_WRITE), U-02 는 이를 읽기만 한다.
- 유닛 사이 값 `warning_result`(`bool`): `sbr_judge_warning` 의 반환값이다. U-02 가 만들고 U-03 이 읽는다. 기억하지 않는다.
- 출력 `sbr_state_t.warning_cmd`(`bool`, U-03 소유, 초기값 FALSE): 경고 명령이며 경고등 자체가 아니다. 전역 변수를 만들지 않기 위해 상태 `sbr_state_t` 는 호출하는 쪽이 갖고, U-03 함수가 포인터로 받아 `warning_cmd` 를 쓴다.
- 상수 `SBR_WARN_SPEED_KMH` = 15 km/h, `SBR_SPEED_MAX_KMH` = 200 km/h (모두 U-02 가 읽는다)
- 내부 상태(모드·타이머·카운터·래치)는 없다. 상태성 값은 `warning_cmd` 하나이며 U-03 이 소유한다.

## Unit 구성

| Unit | 구성요소 | 이름 | 함수 | 설계 항목 |
|---|---|---|---|---|
| U-01 | CMP-INPUT | 입력 신호 취득 | `sbr_acquire_inputs` | SWD-SBR-006 |
| U-02 | CMP-JUDGE | 경고 조건 판정 | `sbr_speed_reached`, `sbr_speed_in_range`, `sbr_passenger_unbelted`, `sbr_judge_warning` | SWD-SBR-001, 002, 004, 005 |
| U-03 | CMP-OUTPUT | 경고 명령 출력 및 초기화 | `sbr_init_output`, `sbr_output_warning` | SWD-SBR-003, SWD-SBR-007 |

## SWD-SBR-006 입력 신호 취득 (U-01)

@design SWD-SBR-006
@satisfies REQ-SBR-01-4@v1

`sbr_acquire_inputs` 는 한 번의 실행에서 `vehicle_speed`, `passenger_occupied`, `seatbelt_buckled` 를 한 번에 받아 `sbr_input_t` 에 채운다. 세 값은 모두 같은 실행의 값이다. 값을 바꾸거나 제한하지 않는다. 201~255 km/h 도 그대로 전달해 U-02 가 범위 밖으로 판단하게 한다.

## SWD-SBR-001 속도 판단 (U-02)

@design SWD-SBR-001
@satisfies REQ-SBR-01-1@v2, REQ-SBR-01-2@v2

`sbr_speed_reached`: `vehicle_speed >= SBR_WARN_SPEED_KMH`(15 km/h) 이면 TRUE, 아니면 FALSE 를 돌려준다. 비교는 '이상'(>=)이다. '초과'(>)가 아니다. 경계 예시: 14 km/h → FALSE, 15 km/h → TRUE, 16 km/h → TRUE.

## SWD-SBR-002 탑승·벨트 판단 (U-02)

@design SWD-SBR-002
@satisfies REQ-SBR-01-1@v2, REQ-SBR-01-2@v2

`sbr_passenger_unbelted`: `passenger_occupied = TRUE` AND `seatbelt_buckled = FALSE` 이면 TRUE, 아니면 FALSE 를 돌려준다.

## SWD-SBR-005 속도 유효 범위 판단 (U-02)

@design SWD-SBR-005
@satisfies REQ-SBR-01-1@v2, REQ-SBR-01-2@v2, REQ-SBR-01-5@v1

`sbr_speed_in_range`: `vehicle_speed <= SBR_SPEED_MAX_KMH` 이면 TRUE(유효 범위 안), 초과이면 FALSE 를 돌려준다. `uint8_t` 라 0 미만은 들어올 수 없다.

## SWD-SBR-004 최종 경고 판단 (U-02)

@design SWD-SBR-004
@satisfies REQ-SBR-01-1@v2, REQ-SBR-01-2@v2, REQ-SBR-01-4@v1, REQ-SBR-01-5@v1

`sbr_judge_warning` 은 실행할 때마다 그 실행의 입력으로 `sbr_speed_in_range` AND `sbr_speed_reached` AND `sbr_passenger_unbelted` 를 계산해 `warning_result` 로 돌려준다. 이전 실행의 결과를 기억하지 않는다. `warning_cmd` 는 직접 쓰지 않는다.

| 조건 | warning_result |
|---|---|
| 속도 > 200 | FALSE |
| 속도 < 15 | FALSE |
| 15 ≤ 속도 ≤ 200, 탑승 TRUE, 착용 FALSE | TRUE |
| 15 ≤ 속도 ≤ 200, 그 밖의 탑승·착용 조합 | FALSE |

## SWD-SBR-003 초기화 (U-03)

@design SWD-SBR-003
@satisfies REQ-SBR-01-3@v1

`sbr_init_output` 은 `warning_cmd` 를 FALSE 로 설정한다.

## SWD-SBR-007 경고 명령 출력 (U-03)

@design SWD-SBR-007
@satisfies REQ-SBR-01-4@v1

`sbr_output_warning` 은 실행할 때마다 받은 `warning_result` 를 `warning_cmd` 에 넣어 출력한다. 이전 `warning_cmd` 값에 의존하지 않는다.
