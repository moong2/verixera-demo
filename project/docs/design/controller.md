# 과열 정지 제어기 상세 설계

현재 Baseline: BL-004.
Baseline 해시: sha256:498ff281ae3be9f9adcb34cedf1cd02e76c829b974aa1d1ae3d7dc57e0f22bce.

이번 검토 대상:
- REQ-CTL-02-1@v2

이번 변경 요약:
- REQ-CTL-02-1 이 v2 로 바뀌어, 유효 입력이고 온도가 75.0 °C 이상이면 감지 센서(`detect_active`)의 활성 여부와 무관하게 같은 호출에서 정지 래치를 활성화해야 한다.
- 기존 `ctl_next_latch` 의 분기는 감지 센서 활성 여부를 전혀 쓰지 않으므로 판정 로직은 그대로 이 요구를 충족한다. 이 문서에서는 `SWD-CTL-007` 의 요구사항 태그를 v2 로 갱신한다.
- 감지 센서 신호 `detect_active` 는 신호 표에서 이 대상이 쓰는 입력이다. 기존 `ctl_step` 에는 이 입력이 없어서 시험이 감지 센서의 활성·비활성을 줄 수 없다. 그래서 `ctl_step` 은 그대로 두고, `detect_active` 를 받는 공개 함수 `ctl_step_detect` 와 설계 항목 `SWD-CTL-011` 을 추가한다.
- 신호 선언(@signal)은 신호 표의 현재 버전(v2 등)에 맞게 갱신하고, 빠져 있던 `input_valid`, `detect_active` 선언을 더한다. 신호의 자료형·단위는 바뀌지 않았다(모두 bool, 단위 없음).
- 이번 대상이 아닌 요구사항 전용 설계 항목(SWD-CTL-001, 002, 003, 004, 005, 006, 008, 009, 010)과 그 함수는 바꾸지 않는다.

상위 요구사항은 하위 요구사항으로 검증하므로 직접 연결하지 않는다.

## 1. 인터페이스

헤더: `src/controller.h`

### 1.1 자료형

| 이름 | 내용 |
|---|---|
| `ctl_state_t` | 제어기 상태. 멤버는 `stop_cmd`, `sensor_fault`, `stop_latch` (모두 `bool`) |

### 1.2 함수

| 함수 | 입력 | 출력 | 설명 |
|---|---|---|---|
| `void ctl_init(ctl_state_t *state)` | `state`: 초기화할 상태(NULL 이면 아무것도 하지 않음) | `state->stop_cmd`, `state->sensor_fault`, `state->stop_latch` 를 모두 false 로 설정 | 초기화 |
| `void ctl_step(ctl_state_t *state, double temp_c, bool sensor_valid, bool reset_request)` | `state`: 상태, `temp_c`: 온도 [°C], `sensor_valid`: 센서 유효성 플래그, `reset_request`: 리셋 요청 | `state` 의 세 멤버를 한 번의 호출 안에서 갱신 | 제어 함수. NULL 이면 아무것도 하지 않음 |
| `void ctl_step_detect(ctl_state_t *state, double temp_c, bool sensor_valid, bool reset_request, bool detect_active)` | `ctl_step` 의 입력 + `detect_active`: 감지 센서 활성 상태(true = 활성, 단위 없음) | `state` 의 세 멤버를 한 번의 호출 안에서 갱신 | 감지 센서 입력을 받는 제어 함수. 결과는 `detect_active` 값과 무관하며 같은 입력의 `ctl_step` 결과와 같다. NULL 이면 아무것도 하지 않음 |
| `bool ctl_is_input_valid(double temp_c, bool sensor_valid)` | `temp_c` [°C], `sensor_valid` | true = 입력 유효, false = 입력 무효 | 입력 유효성 판정(순수 함수) |

이번 대상 요구사항의 상태 계약은 유효한 `ctl_state_t` 객체를 가리키는 `state`에 적용한다. NULL 무동작 처리는 기존 인터페이스를 보존한 것이며, 이번 변경에서 새로운 고장 대응으로 정한 것이 아니다.

입력 유효성은 기존 `ctl_is_input_valid`의 결과를 사용한다. 센서 유효성 플래그가 true이고 온도가 유한하며 −40.0 °C 이상 150.0 °C 이하일 때 유효하다. 센서 유효성 플래그가 false이거나 온도가 NaN, ±∞, 범위 밖이면 무효이다. 이번 변경에서 별도의 판정을 추가하지 않는다.

`ctl_step` 과 `ctl_step_detect` 의 이번 대상 요구사항에 대한 호출 전·후 래치 계약은 다음 표와 같다. 표의 각 행은 서로 겹치지 않는다. 표의 모든 행은 `detect_active` 가 true 이든 false 이든 같다.

| 호출 전 `state->stop_latch` | 입력 판정 | `temp_c` [°C] | `reset_request` | 호출 후 `state->stop_latch` |
|---|---|---|---|---|
| 어느 값이든 | 무효 | 비교하지 않음 | 어느 값이든 | true |
| 어느 값이든 | 유효 | 75.0 이상 | 어느 값이든 | true |
| false | 유효 | 75.0 미만 | 어느 값이든 | false |
| true | 유효 | 75.0 미만 | false | true |
| true | 유효 | 70.0 미만 | true | false |
| true | 유효 | 70.0 이상 75.0 미만 | true | true |

경계와 수용 기준에 대한 관찰 계약:

- 유효한 75.0 °C와 150.0 °C에서는 호출 전 래치, 리셋 요청, 감지 센서 활성 여부와 무관하게 같은 호출에서 래치가 true가 된다.
- 감지 센서가 비활성(`detect_active` = false)이고 유효한 75.0 °C이면 같은 호출에서 래치가 true이다.
- 감지 센서가 활성(`detect_active` = true)이고 유효한 75.0 °C이면 같은 호출에서 래치가 true이다.
- 유효한 74.9 °C에서는 새로 래치를 활성화하지 않는다. 호출 전 false이면 리셋 요청과 무관하게 false이고, 호출 전 true이면 해제 온도 조건을 만족하지 않아 true이다.
- 호출 전 true이고 리셋 요청이 있으면, 유효한 69.9 °C와 −40.0 °C에서는 false가 된다. 유효한 70.0 °C, 70.1 °C, 74.9 °C, 150.0 °C에서는 true이다.
- 호출 전 true이고 리셋 요청이 없으면, 유효한 낮은 온도에서도 true를 유지한다.
- 호출 전 false이고 유효한 −40.0 °C이면 리셋 요청 여부와 무관하게 false이다.
- 센서 유효성 플래그가 false이거나 온도가 NaN 또는 150.0 °C 초과이면 리셋 요청 여부와 무관하게 true이다.
- 리셋 요청은 해당 호출의 `reset_request` 값으로 평가한다. 별도의 상승 에지 검출 상태나 추가 신호를 만들지 않는다.
- 온도 이외의 불리언 신호와 반환값은 단위가 없다.

기존 출력 계약도 보존한다. 호출 종료 시 `state->stop_cmd`는 갱신된 `state->stop_latch`와 같다.

### 1.3 신호 (승인된 신호 표 기준)

신호 이름·자료형·단위는 Baseline BL-004의 신호 표를 따른다. 코드 식별자와의 대응은 다음 한 줄씩의 선언과 같다.

@signal temp_c@v1 → temp_c
@signal sensor_valid@v2 → sensor_valid
@signal reset_request@v2 → reset_request
@signal detect_active@v1 → detect_active
@signal input_valid@v1 → valid (ctl_step·ctl_step_detect 의 지역 상수와 ctl_next_latch 의 인자, ctl_is_input_valid 의 반환값)
@signal stop_cmd@v2 → ctl_state_t.stop_cmd
@signal sensor_fault@v2 → ctl_state_t.sensor_fault
@signal stop_latch@v2 → ctl_state_t.stop_latch

- `temp_c`는 `ctl_step`, `ctl_step_detect`, `ctl_is_input_valid`의 `double` 인자이며 단위는 °C이다. 신호 표의 최소·최대 범위는 지정되지 않았고 NaN·±∞ 입력이 가능하다. 입력 유효성 판정 범위와 신호 자체의 허용 표현 범위를 혼동하지 않는다.
- `sensor_valid`는 기존 입력 유효성 판정에 사용하는 `bool` 인자이다.
- `reset_request`는 `ctl_step`, `ctl_step_detect`의 `bool` 인자이다.
- `detect_active`는 `ctl_step_detect`의 `bool` 인자이며 true 가 활성이다. REQ-CTL-02-1@v2 가 "감지 센서의 활성 여부와 무관하게"라고 하므로 정지 래치 판정에 쓰지 않는다. 표의 최소·최대·초기값은 지정되지 않았다.
- `input_valid`는 내부 `bool` 신호이며 true 가 유효이다. 코드에서는 `ctl_is_input_valid` 의 반환값을 지역 상수 `valid` 에 담아 쓴다.
- `stop_latch`는 내부 `bool` 상태이며 true가 활성이다.
- 센서 고장 플래그는 신호 표에서 내부 신호이나 상태 구조체의 멤버로 노출한다(시험이 관찰할 수 있도록).
- 온도의 자료형은 NaN·±∞ 를 표현해야 하므로 신호 표대로 `double` 이다.

## 2. 설계 항목

### 판정 기준 값 (코드의 이름 있는 상수, 모두 요구사항 문장에서 온 값)

| 상수 | 값 | 출처 |
|---|---|---|
| `CTL_TEMP_VALID_MIN_C` | -40.0 °C | REQ-CTL-01-4@v1, REQ-CTL-01-5@v1 |
| `CTL_TEMP_VALID_MAX_C` | 150.0 °C | REQ-CTL-01-4@v1, REQ-CTL-01-5@v1 |
| `CTL_TEMP_LATCH_SET_C` | 75.0 °C | REQ-CTL-02-1@v2, REQ-CTL-02-4@v2, REQ-CTL-03-4@v1 |
| `CTL_TEMP_LATCH_RELEASE_C` | 70.0 °C (미만이면 해제 가능, 이상이면 유지) | REQ-CTL-02-3@v2, REQ-CTL-03-1@v2, REQ-CTL-03-2@v2 |

### 설계 항목

@design SWD-CTL-001
@satisfies REQ-CTL-01-1@v1
`ctl_init`: 정지 명령, 센서 고장 플래그, 정지 래치를 모두 false 로 설정한다.

@design SWD-CTL-002
@satisfies REQ-CTL-01-2@v1
`ctl_step`: 한 번의 호출 안에서 (1) 입력 유효성을 평가하고 (2) 센서 고장 플래그를 갱신하고 (3) 정지 래치를 갱신한 뒤 (4) 정지 명령을 설정한다. 호출이 끝나면 출력과 내부 상태가 모두 갱신되어 있다.

@design SWD-CTL-003
@satisfies REQ-CTL-01-3@v1
`ctl_is_input_valid`: 센서 유효성 플래그가 false 이면 온도값과 무관하게 무효를 반환한다.

@design SWD-CTL-004
@satisfies REQ-CTL-01-4@v1
`ctl_is_input_valid`: 온도가 NaN, ±∞, -40.0 °C 미만, 150.0 °C 초과이면 플래그와 무관하게 무효를 반환한다. 구현은 "온도 >= -40.0 이고 온도 <= 150.0" 만 유효로 보며, NaN 은 모든 비교가 거짓이고 ±∞ 는 범위 밖이라 둘 다 무효가 된다.

@design SWD-CTL-005
@satisfies REQ-CTL-01-5@v1
`ctl_is_input_valid`: 플래그가 true 이고 온도가 유한하며 -40.0 °C 이상 150.0 °C 이하이면(경계 포함) 유효를 반환한다. 세 조건 중 하나라도 불충족이면 유효가 아니다.

@design SWD-CTL-006
@satisfies REQ-CTL-01-6@v1, REQ-CTL-01-7@v1, REQ-CTL-01-8@v1
`ctl_next_fault`: 입력이 무효이면 센서 고장 플래그를 true, 유효이면 false 로 한다. 직전 호출의 플래그와 정지 래치 상태를 쓰지 않으므로, 직전 무효 후 현재 유효이면 래치와 무관하게 false 로 복귀한다.

@design SWD-CTL-007
@satisfies REQ-CTL-02-1@v2, REQ-CTL-02-2@v1, REQ-CTL-03-4@v1
`ctl_next_latch`: 입력이 무효이면 온도 비교나 해제 조건보다 먼저 반환 예정 값을 true로 설정한다. 입력이 유효하고 온도가 75.0 °C 이상이어도 true로 설정한다. 두 활성화 경로는 호출 전 래치와 리셋 요청 여부에 의존하지 않으며, 감지 센서 활성 여부는 인자로 받지도 않으므로 그 값에도 의존하지 않는다(REQ-CTL-02-1@v2).

따라서 유효한 75.0 °C와 150.0 °C는 감지 센서의 활성·비활성과 무관하게 같은 호출에서 활성화되고, 유효한 74.9 °C는 이 활성화 조건에 해당하지 않는다. 무효 입력 또는 유효한 75.0 °C 이상 입력과 리셋 요청이 같은 호출에 들어와도 활성화가 우선한다.

@design SWD-CTL-008
@satisfies REQ-CTL-02-3@v2, REQ-CTL-02-4@v2, REQ-CTL-03-2@v2, REQ-CTL-03-3@v1
`ctl_next_latch`: 활성화 조건이 아니고 해제 조건도 아니면 직전 래치 값을 유지한다.

- 호출 전 래치가 true이면 리셋 요청이 없거나, 입력이 무효이거나, 유효 온도가 70.0 °C 이상일 때 true를 유지한다.
- 유효한 70.0 °C는 해제 경계에 포함되지 않는다. 유효한 70.1 °C, 74.9 °C, 150.0 °C에서도 리셋 요청과 무관하게 활성 상태를 유지한다.
- 호출 전 래치가 false이고 입력이 유효하며 75.0 °C 미만이면 리셋 요청 여부와 무관하게 false를 유지한다. 활성화 분기는 성립하지 않고, 해제 분기는 직전 래치가 true일 것을 요구하므로 성립하지 않는다.
- 호출 전 래치가 true이고 입력이 무효이면 첫 번째 무효 입력 분기에서 true를 정한다. 이 경로에서는 온도 비교와 해제 조건을 평가하지 않는다. 센서 유효성 플래그가 false이거나 온도가 NaN인 경우에도 리셋 요청으로 해제되지 않는다.

활성 유지 동작은 마지막 유지 분기에만 의존하지 않는다. 무효 입력과 유효한 75.0 °C 이상 입력은 우선 활성화 분기에서 true를 정하여 활성 유지도 충족한다.

@design SWD-CTL-009
@satisfies REQ-CTL-03-1@v2
`ctl_next_latch`: 호출 전 래치가 true이고, 리셋 요청이 있고, 입력이 유효하고, 온도가 70.0 °C 미만일 때 래치를 false로 설정한다.

유효한 69.9 °C와 −40.0 °C는 해제 조건에 포함되고, 유효한 70.0 °C는 포함되지 않는다. 호출 전 래치가 이미 false인 경우에도 리셋 요청·유효 입력·70.0 °C 미만 조건에서 결과는 false이므로 요구한 해제 상태를 만족한다. 입력 무효나 활성화 온도 조건에서는 이 해제 경로에 진입하지 않는다.

@design SWD-CTL-010
@satisfies REQ-CTL-04@v1
`ctl_step`: 호출 종료 직전에 정지 명령을 갱신된 정지 래치 값과 같게 설정한다. 래치 갱신 이후 `state->stop_cmd = state->stop_latch`를 수행하므로 활성과 비활성 모두 동일 호출의 최종 래치 상태가 출력된다. 이전 정지 명령 값은 이 대입 결과에 영향을 주지 않는다.

@design SWD-CTL-011
@satisfies REQ-CTL-02-1@v2
`ctl_step_detect`: 감지 센서 활성 상태(`detect_active`)를 입력으로 받는 제어 함수이다. 한 번의 호출 안에서 `ctl_is_input_valid` 로 입력 유효성을 평가하고, `ctl_next_fault` 와 `ctl_next_latch` 로 센서 고장 플래그와 정지 래치를 갱신한 뒤 정지 명령을 정지 래치와 같게 설정한다. `detect_active` 는 어떤 판정에도 쓰지 않으므로, 유효한 입력이고 온도가 75.0 °C 이상이면 `detect_active` 가 true 이든 false 이든 같은 호출에서 `state->stop_latch` 가 true 가 된다. 유효한 74.9 °C 에서는 이 요구로 래치가 활성화되지 않는다. 존재 이유는 감지 센서 입력을 관찰·시험할 수 있는 인터페이스를 주는 것이다.

## 3. 처리 순서와 설계 판단

기존 호출 순서를 보존한다. `ctl_step` 과 `ctl_step_detect` 가 같은 순서를 따른다.

1. `valid = ctl_is_input_valid(temp_c, sensor_valid)`
2. `sensor_fault = ctl_next_fault(valid)`
3. `stop_latch = ctl_next_latch(stop_latch, valid, temp_c, reset_request)`
4. `stop_cmd = stop_latch`

이번 대상 요구사항을 구현하는 내부 함수는 다음과 같다.

| 함수 | 입력 | 반환값 | 단위·전제 |
|---|---|---|---|
| `static bool ctl_next_latch(bool latch, bool valid, double temp_c, bool reset_request)` | `latch`: 호출 전 `stop_latch`, `valid`: 기존 입력 유효성 판정 결과, `temp_c`: 측정 온도, `reset_request`: 이번 호출의 리셋 요청 | 갱신된 `stop_latch` | 온도는 °C, 불리언은 단위 없음. `valid`는 동일 호출의 `ctl_is_input_valid` 결과여야 한다 |

설계 판단:

- 래치 판정 우선순위는 무효 입력 활성화, 유효한 75.0 °C 이상 활성화, 활성 래치의 리셋·70.0 °C 미만 해제, 나머지 유지 순서이다.
- 입력 유효성은 온도 기반 래치 판정보다 먼저 평가한다. 무효이면 요구사항이 정한 래치 활성화를 적용한다.
- 활성화와 해제 임계값은 각각 75.0 °C 이상과 70.0 °C 미만이다. 경계 비교를 바꾸거나 추가 지연·필터·타이머를 도입하지 않는다.
- 감지 센서 활성 여부는 래치 판정에 쓰지 않는다. `ctl_step_detect` 의 `detect_active` 는 `(void)` 캐스트로 의도적 미사용임을 밝힌다.
- 기존 `ctl_step` 의 시그니처와 본문은 다른 요구사항(REQ-CTL-01-2, REQ-CTL-04)의 설계가 쓰므로 바꾸지 않고, 감지 센서 입력은 새 함수로 더한다.
- 상태는 호출자의 `ctl_state_t`에만 보관한다. 전역 가변 상태를 추가하지 않는다.
- 포인터는 기존 상태 인터페이스에만 사용하며 포인터 연산을 추가하지 않는다.
- 정지 기능과 센서 판정은 같은 안전 수준(ASIL D)의 한 제어 기능이며 함수별 책임 분리를 보존한다.
- AUTO-CD 프로파일과 프로젝트의 더 엄격한 필수 규칙을 적용한다. 대상 함수는 선언 시 초기화, 단일 최종 반환, 명시적 분기, 불리언 조건을 사용한다.
- 동적 메모리, 재귀, goto, 비지역 분기, 흐름을 숨기는 매크로를 추가하지 않는다.
- 요구사항에 없는 런타임 assertion이나 새로운 오류 대응은 도입하지 않는다. 기존 NULL 무동작 처리를 보존한다.
- 이 문서의 검토는 실행 검증을 대신하지 않는다. 컴파일, 시험, 추적 점검, 정적 분석 통과나 MISRA 준수 인증을 실행 근거 없이 주장하지 않는다.
