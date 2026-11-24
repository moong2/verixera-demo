CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Wpedantic -Wstrict-prototypes -Wmissing-prototypes -Wundef -Wuninitialized -Wshadow -Wconversion -Wsign-conversion -Werror -O0 --coverage
LDFLAGS ?=

BUILD := build
SRCS := $(wildcard src/*.c)
TESTS := $(wildcard tests/*.c)
BIN := $(BUILD)/run_tests

.PHONY: test clean

test: $(BIN)
	./$(BIN)

$(BIN): $(SRCS) $(TESTS) $(wildcard src/*.h) $(wildcard tests/*.h)
	mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -Isrc -Itests -o $@ $(SRCS) $(TESTS) $(LDFLAGS) $(CFLAGS)

clean:
	rm -rf $(BUILD)
