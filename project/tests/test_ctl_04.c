/*
 * REQ-CTL-04@v1 시험
 * WHEN 제어 함수 호출이 종료되면, 정지 명령 출력은 정지 래치 상태와 같다.
 *
 * 기대값은 요구사항 문장, 수용 기준, 그리고 같은 Baseline 의 REQ-CTL-02-1,
 * 02-2, 02-3, 02-4, 03-1 의 문장에서만 정했다. 구현 코드는 보지 않았다.
 *
 * @no-method boundary REQ-CTL-04: 이 요구사항에는 수치 임계값이 없다. 온도 임계의 경계는
 *   REQ-CTL-02-1, 02-4, 03-1 등 다른 요구사항에서 시험한다.
 */
#include <stdio.h>
#include "ears_tc.h"
#include "controller.h"

int ears_suite_ctl_04(void);

int ears_suite_ctl_04(void)
{
    int rc = 0;

    /*
     * @testcase TC-CTL-04-001
     * @verifies REQ-CTL-04@v1
     * @method requirement, equivalence
     * 정지 래치가 활성인 구간: 호출 전 래치 활성, 정지 명령 비활성.
     * 리셋이 없고 온도 25 °C 의 유효 입력이므로 래치는 유지된다(REQ-CTL-02-3).
     * 호출 종료 시 정지 명령은 활성이어야 한다.
     */
    if (ears_tc_selected("TC-CTL-04-001")) {
        ctl_state_t s;
        int ok = 1;

        s.stop_cmd = false;
        s.sensor_fault = false;
        s.stop_latch = true;
        ctl_step(&s, 25.0, true, false);

        ears_actual_i("TC-CTL-04-001", 1, "stop_latch", (long long)s.stop_latch);
        ears_actual_i("TC-CTL-04-001", 1, "stop_cmd", (long long)s.stop_cmd);

        if (s.stop_latch != true) {
            ok = 0;
            printf("  TC-CTL-04-001: expected stop_latch=true, got stop_latch=%d\n", (int)s.stop_latch);
        }
        if (s.stop_cmd != true) {
            ok = 0;
            printf("  TC-CTL-04-001: expected stop_cmd=true, got stop_cmd=%d\n", (int)s.stop_cmd);
        }
        printf("TC-CTL-04-001 %s\n", ok ? "pass" : "fail");
        if (!ok) {
            rc = 1;
        }
    }

    /*
     * @testcase TC-CTL-04-002
     * @verifies REQ-CTL-04@v1
     * @method requirement, equivalence, error-guessing
     * 정지 래치가 비활성인 구간이며, 호출 전 정지 명령이 활성이다(상태가 어긋난 순서).
     * 리셋이 없고 온도 25 °C 의 유효 입력이므로 래치는 비활성으로 남는다(REQ-CTL-02-4).
     * 호출 종료 시 정지 명령은 비활성이어야 한다.
     */
    if (ears_tc_selected("TC-CTL-04-002")) {
        ctl_state_t s;
        int ok = 1;

        s.stop_cmd = true;
        s.sensor_fault = false;
        s.stop_latch = false;
        ctl_step(&s, 25.0, true, false);

        ears_actual_i("TC-CTL-04-002", 1, "stop_latch", (long long)s.stop_latch);
        ears_actual_i("TC-CTL-04-002", 1, "stop_cmd", (long long)s.stop_cmd);

        if (s.stop_latch != false) {
            ok = 0;
            printf("  TC-CTL-04-002: expected stop_latch=false, got stop_latch=%d\n", (int)s.stop_latch);
        }
        if (s.stop_cmd != false) {
            ok = 0;
            printf("  TC-CTL-04-002: expected stop_cmd=false, got stop_cmd=%d\n", (int)s.stop_cmd);
        }
        printf("TC-CTL-04-002 %s\n", ok ? "pass" : "fail");
        if (!ok) {
            rc = 1;
        }
    }

    /*
     * @testcase TC-CTL-04-003
     * @verifies REQ-CTL-04@v1
     * @method requirement, interface
     * ctl_init 으로 초기화한 뒤 과열 입력(80 °C, 유효)을 한 번 호출한다.
     * 호출 안에서 래치가 활성화되므로(REQ-CTL-02-1) 호출 종료 시 정지 명령도 활성이어야 한다.
     */
    if (ears_tc_selected("TC-CTL-04-003")) {
        ctl_state_t s;
        int ok = 1;

        ctl_init(&s);
        ears_actual_i("TC-CTL-04-003", 1, "stop_cmd", (long long)s.stop_cmd);
        ears_actual_i("TC-CTL-04-003", 1, "stop_latch", (long long)s.stop_latch);

        ctl_step(&s, 80.0, true, false);
        ears_actual_i("TC-CTL-04-003", 2, "stop_latch", (long long)s.stop_latch);
        ears_actual_i("TC-CTL-04-003", 2, "stop_cmd", (long long)s.stop_cmd);

        if (s.stop_latch != true) {
            ok = 0;
            printf("  TC-CTL-04-003: expected stop_latch=true, got stop_latch=%d\n", (int)s.stop_latch);
        }
        if (s.stop_cmd != true) {
            ok = 0;
            printf("  TC-CTL-04-003: expected stop_cmd=true, got stop_cmd=%d\n", (int)s.stop_cmd);
        }
        printf("TC-CTL-04-003 %s\n", ok ? "pass" : "fail");
        if (!ok) {
            rc = 1;
        }
    }

    /*
     * @testcase TC-CTL-04-004
     * @verifies REQ-CTL-04@v1
     * @method requirement
     * 정지 래치가 활성인 상태에서 리셋 요청, 유효 입력, 온도 60 °C 를 준다.
     * 해제 조건이 충족되므로(REQ-CTL-03-1) 래치는 비활성이 되고,
     * 호출 종료 시 정지 명령도 비활성이어야 한다.
     */
    if (ears_tc_selected("TC-CTL-04-004")) {
        ctl_state_t s;
        int ok = 1;

        s.stop_cmd = true;
        s.sensor_fault = false;
        s.stop_latch = true;
        ctl_step(&s, 60.0, true, true);

        ears_actual_i("TC-CTL-04-004", 1, "stop_latch", (long long)s.stop_latch);
        ears_actual_i("TC-CTL-04-004", 1, "stop_cmd", (long long)s.stop_cmd);

        if (s.stop_latch != false) {
            ok = 0;
            printf("  TC-CTL-04-004: expected stop_latch=false, got stop_latch=%d\n", (int)s.stop_latch);
        }
        if (s.stop_cmd != false) {
            ok = 0;
            printf("  TC-CTL-04-004: expected stop_cmd=false, got stop_cmd=%d\n", (int)s.stop_cmd);
        }
        printf("TC-CTL-04-004 %s\n", ok ? "pass" : "fail");
        if (!ok) {
            rc = 1;
        }
    }

    /*
     * @testcase TC-CTL-04-005
     * @verifies REQ-CTL-04@v1
     * @method fault-injection, error-guessing
     * 센서 유효성 플래그가 False 인 고장 입력(온도 25 °C 라도 무효, REQ-CTL-01-3)을 준다.
     * 무효 입력은 래치를 활성화하므로(REQ-CTL-02-2) 호출 종료 시 정지 명령은 활성이어야 한다.
     */
    if (ears_tc_selected("TC-CTL-04-005")) {
        ctl_state_t s;
        int ok = 1;

        ctl_init(&s);
        ears_actual_i("TC-CTL-04-005", 1, "stop_cmd", (long long)s.stop_cmd);
        ears_actual_i("TC-CTL-04-005", 1, "stop_latch", (long long)s.stop_latch);

        ctl_step(&s, 25.0, false, false);
        ears_actual_i("TC-CTL-04-005", 2, "stop_latch", (long long)s.stop_latch);
        ears_actual_i("TC-CTL-04-005", 2, "stop_cmd", (long long)s.stop_cmd);

        if (s.stop_latch != true) {
            ok = 0;
            printf("  TC-CTL-04-005: expected stop_latch=true, got stop_latch=%d\n", (int)s.stop_latch);
        }
        if (s.stop_cmd != true) {
            ok = 0;
            printf("  TC-CTL-04-005: expected stop_cmd=true, got stop_cmd=%d\n", (int)s.stop_cmd);
        }
        printf("TC-CTL-04-005 %s\n", ok ? "pass" : "fail");
        if (!ok) {
            rc = 1;
        }
    }

    return rc;
}
