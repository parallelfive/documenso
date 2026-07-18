#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
START_SCRIPT="$SCRIPT_DIR/start.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/documenso-start-test.XXXXXX")
FAKE_BIN="$TEST_ROOT/bin"

cleanup() {
    rm -rf "$TEST_ROOT"
}

trap cleanup 0 HUP INT TERM

fail() {
    printf "FAIL: %s\n" "$1" >&2
    exit 1
}

assert_status() {
    expected_status=$1
    actual_status=$2
    case_name=$3

    if [ "$actual_status" -ne "$expected_status" ]; then
        fail "$case_name exited $actual_status; expected $expected_status"
    fi
}

assert_calls() {
    expected_calls=$1
    call_log=$2
    case_name=$3
    actual_calls=$(cat "$call_log")

    if [ "$actual_calls" != "$expected_calls" ]; then
        printf "Expected calls:\n%s\nActual calls:\n%s\n" "$expected_calls" "$actual_calls" >&2
        fail "$case_name command sequence differed"
    fi
}

run_start() {
    case_root=$1
    migration_exit_code=$2
    node_exit_code=$3

    mkdir -p "$case_root/work"
    : > "$case_root/calls.log"

    (
        cd "$case_root/work"
        PATH="$FAKE_BIN:$PATH" \
            CALL_LOG="$case_root/calls.log" \
            MIGRATION_EXIT_CODE="$migration_exit_code" \
            NODE_EXIT_CODE="$node_exit_code" \
            NODE_PID_LOG="$case_root/node.pid" \
            NODE_HOSTNAME_LOG="$case_root/node.hostname" \
            NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH="$case_root/missing-cert.p12" \
            exec sh "$START_SCRIPT"
    ) > "$case_root/stdout.log" 2> "$case_root/stderr.log" &

    START_PID=$!

    if wait "$START_PID"; then
        START_STATUS=0
    else
        START_STATUS=$?
    fi
}

mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/npx" <<'EOF'
#!/bin/sh

set -eu

printf "npx:%s\n" "$*" >> "$CALL_LOG"

if [ "$#" -ne 5 ] ||
    [ "$1" != "prisma" ] ||
    [ "$2" != "migrate" ] ||
    [ "$3" != "deploy" ] ||
    [ "$4" != "--schema" ] ||
    [ "$5" != "../../packages/prisma/schema.prisma" ]; then
    printf "Unexpected migration command\n" >&2
    exit 97
fi

exit "$MIGRATION_EXIT_CODE"
EOF

cat > "$FAKE_BIN/node" <<'EOF'
#!/bin/sh

set -eu

printf "node:%s\n" "$*" >> "$CALL_LOG"
printf "%s\n" "$$" > "$NODE_PID_LOG"
printf "%s\n" "${HOSTNAME-}" > "$NODE_HOSTNAME_LOG"

exit "$NODE_EXIT_CODE"
EOF

chmod +x "$FAKE_BIN/npx" "$FAKE_BIN/node"

sh -n "$START_SCRIPT"

failure_root="$TEST_ROOT/migration-failure"
run_start "$failure_root" 42 0
failure_status=$START_STATUS

assert_status 42 "$failure_status" "migration failure"
assert_calls \
    "npx:prisma migrate deploy --schema ../../packages/prisma/schema.prisma" \
    "$failure_root/calls.log" \
    "migration failure"

if [ -e "$failure_root/node.pid" ]; then
    fail "migration failure started the Node server"
fi

if grep -Fq "Starting Documenso server" "$failure_root/stdout.log"; then
    fail "migration failure announced a server start"
fi

if ! grep -Fq "Database migrations failed (exit 42); refusing to start Documenso." "$failure_root/stderr.log"; then
    fail "migration failure did not emit the fail-closed diagnostic"
fi

success_root="$TEST_ROOT/migration-success"
run_start "$success_root" 0 17
success_pid=$START_PID
success_status=$START_STATUS

assert_status 17 "$success_status" "migration success"
assert_calls \
    "npx:prisma migrate deploy --schema ../../packages/prisma/schema.prisma
node:build/server/main.js" \
    "$success_root/calls.log" \
    "migration success"

node_pid=$(cat "$success_root/node.pid")
if [ "$node_pid" -ne "$success_pid" ]; then
    fail "Node ran as PID $node_pid instead of replacing startup PID $success_pid"
fi

node_hostname=$(cat "$success_root/node.hostname")
if [ "$node_hostname" != "0.0.0.0" ]; then
    fail "Node received HOSTNAME=$node_hostname instead of 0.0.0.0"
fi

if ! grep -Fq "Database migrations completed successfully." "$success_root/stdout.log"; then
    fail "migration success was not acknowledged"
fi

if ! grep -Fq "Starting Documenso server" "$success_root/stdout.log"; then
    fail "migration success did not announce the server start"
fi

printf "PASS: Documenso startup is fail-closed and execs Node only after migrations succeed.\n"
