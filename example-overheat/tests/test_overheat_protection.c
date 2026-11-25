#include <stdio.h>

#include "../src/overheat_protection.h"

static int failures = 0;

static void expect(const char *tc_id, bool actual, bool expected)
{
    printf("%s %s\n", tc_id, actual == expected ? "pass" : "fail");
    if (actual != expected) {
        failures++;
    }
}

/*
 * 기대 결과는 승인된 요구사항(BL-001)의 문장과 수용 기준에서 정했다. 구현을 보고 정하지 않았다.
 *   REQ-OTP-01-1: 유효한 센서 온도가 75 °C 이상이면 정지 명령을 활성화한다.
 *   REQ-OTP-01-2: 센서 값이 무효이면 (온도 값과 관계없이) 정지 명령을 활성화한다.
 * 온도는 0.1 °C 단위 정수다(749 = 74.9 °C).
 */
int main(void)
{
    /* ── REQ-OTP-01-1: 유효한 온도가 75 °C 이상이면 정지 ── */

    /* @testcase TC-OTP-01-1-001
     * @verifies REQ-OTP-01-1@v1
     * @method boundary
     * 하한 경계: 유효 74.9 °C → 정지 명령 = false */
    expect("TC-OTP-01-1-001", otp_should_stop(&(otp_input_t){ true, 749 }), false);

    /* @testcase TC-OTP-01-1-002
     * @verifies REQ-OTP-01-1@v1
     * @method boundary, requirement
     * 전이 경계: 유효 75.0 °C → 정지 명령 = true */
    expect("TC-OTP-01-1-002", otp_should_stop(&(otp_input_t){ true, 750 }), true);

    /* @testcase TC-OTP-01-1-003
     * @verifies REQ-OTP-01-1@v1
     * @method boundary
     * 상한 경계: 유효 75.1 °C → 정지 명령 = true */
    expect("TC-OTP-01-1-003", otp_should_stop(&(otp_input_t){ true, 751 }), true);

    /* @testcase TC-OTP-01-1-004
     * @verifies REQ-OTP-01-1@v1
     * @method equivalence
     * 동등 분할 '유효, 75 °C 미만'의 대표값: 유효 20.0 °C → 정지 명령 = false */
    expect("TC-OTP-01-1-004", otp_should_stop(&(otp_input_t){ true, 200 }), false);

    /* @testcase TC-OTP-01-1-005
     * @verifies REQ-OTP-01-1@v1
     * @method equivalence
     * 동등 분할 '유효, 75 °C 이상'의 대표값: 유효 120.0 °C → 정지 명령 = true */
    expect("TC-OTP-01-1-005", otp_should_stop(&(otp_input_t){ true, 1200 }), true);

    /* @testcase TC-OTP-01-1-006
     * @verifies REQ-OTP-01-1@v1
     * @method interface
     * 인터페이스: 온도 형식(int32_t)의 최솟값도 75 °C 미만이다 → 정지 명령 = false */
    expect("TC-OTP-01-1-006", otp_should_stop(&(otp_input_t){ true, INT32_MIN }), false);

    /* @testcase TC-OTP-01-1-007
     * @verifies REQ-OTP-01-1@v1
     * @method interface
     * 인터페이스: 온도 형식(int32_t)의 최댓값은 75 °C 이상이다 → 정지 명령 = true */
    expect("TC-OTP-01-1-007", otp_should_stop(&(otp_input_t){ true, INT32_MAX }), true);

    /* ── REQ-OTP-01-2: 센서 값이 무효이면 온도와 관계없이 정지 ── */
    /* @no-method boundary REQ-OTP-01-2: 센서 유효 여부는 참·거짓 두 값뿐이고 온도 값은 판정에 쓰이지 않아 경계값이 없음 */

    /* @testcase TC-OTP-01-2-001
     * @verifies REQ-OTP-01-2@v1
     * @method requirement, equivalence
     * 센서 무효, 온도가 임계 미만: 20.0 °C 라도 정지 명령 = true */
    expect("TC-OTP-01-2-001", otp_should_stop(&(otp_input_t){ false, 200 }), true);

    /* @testcase TC-OTP-01-2-002
     * @verifies REQ-OTP-01-2@v1
     * @method equivalence
     * 센서 무효, 온도가 임계 이상: 80.0 °C 일 때도 정지 명령 = true */
    expect("TC-OTP-01-2-002", otp_should_stop(&(otp_input_t){ false, 800 }), true);

    /* @testcase TC-OTP-01-2-003
     * @verifies REQ-OTP-01-2@v1
     * @method interface
     * 인터페이스: 센서 무효이면 온도 형식의 최솟값에서도 정지 명령 = true */
    expect("TC-OTP-01-2-003", otp_should_stop(&(otp_input_t){ false, INT32_MIN }), true);

    /* @testcase TC-OTP-01-2-004
     * @verifies REQ-OTP-01-2@v1
     * @method interface
     * 인터페이스: 센서 무효이면 온도 형식의 최댓값에서도 정지 명령 = true */
    expect("TC-OTP-01-2-004", otp_should_stop(&(otp_input_t){ false, INT32_MAX }), true);

    return failures == 0 ? 0 : 1;
}
