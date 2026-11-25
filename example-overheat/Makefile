# 예시 프로젝트의 시험 실행. 시험 프로그램은 시험마다 "TC-ID pass|fail" 한 줄을 출력한다.
CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror

.PHONY: test clean

test: build/test_overheat_protection
	./build/test_overheat_protection

build/test_overheat_protection: tests/test_overheat_protection.c src/overheat_protection.c src/overheat_protection.h
	mkdir -p build
	$(CC) $(CFLAGS) -o $@ tests/test_overheat_protection.c src/overheat_protection.c

clean:
	rm -rf build
