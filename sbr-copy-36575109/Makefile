# SBR 예시 프로젝트의 시험 실행. 시험 프로그램은 시험마다 "TC-ID pass|fail" 한 줄을 출력한다.
# tests/ 와 src/ 의 .c 파일을 모두 빌드한다: 시험 에이전트가 시험을 여러 파일(tests/ears_main.c + 묶음 파일)로 나눠도 그대로 빌드된다.
CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Werror

SRCS := $(wildcard src/*.c)
TESTS := $(wildcard tests/*.c)
HDRS := $(wildcard src/*.h tests/*.h)

.PHONY: test clean

test: build/test_seatbelt_reminder
	./build/test_seatbelt_reminder

build/test_seatbelt_reminder: $(SRCS) $(TESTS) $(HDRS)
	mkdir -p build
	$(CC) $(CFLAGS) -Isrc -Itests -o $@ $(TESTS) $(SRCS)

clean:
	rm -rf build
