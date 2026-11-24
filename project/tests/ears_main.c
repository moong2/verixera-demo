/* EARS Requirements Writer 가 만드는 시험 실행 파일 — 직접 고치지 않는다(시험 생성을 적용할 때마다 다시 만든다).
 * tests/ 의 시험 묶음(ears_suite_*)을 차례로 모두 실행하고, 하나라도 실패하면 1 로 끝난다.
 * 환경 변수 EARS_TC 로 TC 를 고르면 각 묶음이 그 TC 만 실행한다(tests/ears_tc.h).
 */
int ears_suite_controller_reset(void);
int ears_suite_ctl_01(void);
int ears_suite_ctl_02(void);
int ears_suite_ctl_04(void);

int main(void)
{
    int failed = 0;
    failed |= ears_suite_controller_reset();
    failed |= ears_suite_ctl_01();
    failed |= ears_suite_ctl_02();
    failed |= ears_suite_ctl_04();
    return (failed != 0) ? 1 : 0;
}
