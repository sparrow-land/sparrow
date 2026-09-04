#!/usr/bin/env bash
# run-all.sh — build the scenario image once, run every scenario in order, and
# print a summary table. Exits non-zero if any scenario fails.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
IMAGE="${SPARROW_SCENARIO_IMAGE:-sparrow:scenarios}"

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; RESET=''
fi

command -v docker >/dev/null 2>&1 || { echo "docker not found on PATH" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "jq not found on PATH" >&2; exit 2; }

# Build the image ONCE and share it with every scenario via SPARROW_SCENARIO_IMAGE.
echo "${BOLD}Building image $IMAGE ...${RESET}"
docker build -t "$IMAGE" "$REPO_ROOT" || { echo "docker build failed" >&2; exit 2; }
export SPARROW_SCENARIO_IMAGE="$IMAGE"

names=(); results=(); durations=()
overall=0
skipped=0
LOG="$(mktemp "${TMPDIR:-/tmp}/sparrow-run-all.XXXXXX")"
trap 'rm -f "$LOG"' EXIT

for run in "$HERE"/[0-9]*-*/run.sh; do
  name="$(basename "$(dirname "$run")")"
  echo
  echo "${BOLD}=== $name ===${RESET}"
  start=$(date +%s)
  # A scenario whose host requirements are missing prints `SKIP <name>` and
  # exits 0 (scenarios/lib.sh `skip`): green suite, gap still reported.
  if bash "$run" 2>&1 | tee "$LOG"; then
    if grep -q "SKIP ${name}" "$LOG"; then
      result="SKIP"
      skipped=$((skipped + 1))
    else
      result="PASS"
    fi
  else
    result="FAIL"
    overall=1
  fi
  end=$(date +%s)
  names+=("$name")
  results+=("$result")
  durations+=("$((end - start))s")
done

echo
echo "${BOLD}================ SUMMARY ================${RESET}"
printf '%-26s %-6s %8s\n' "SCENARIO" "RESULT" "TIME"
printf '%-26s %-6s %8s\n' "--------" "------" "----"
for i in "${!names[@]}"; do
  case "${results[$i]}" in
    PASS) color="$GREEN" ;;
    SKIP) color="$YELLOW" ;;
    *)    color="$RED" ;;
  esac
  printf '%-26s %s%-6s%s %8s\n' "${names[$i]}" "$color" "${results[$i]}" "$RESET" "${durations[$i]}"
done
echo "${BOLD}========================================${RESET}"

if [ "$overall" -eq 0 ]; then
  if [ "$skipped" -gt 0 ]; then
    echo "${GREEN}All ${#names[@]} scenarios green${RESET} — ${YELLOW}${skipped} skipped (missing host tools).${RESET}"
  else
    echo "${GREEN}All ${#names[@]} scenarios passed.${RESET}"
  fi
else
  echo "${RED}Some scenarios failed.${RESET}"
fi
exit "$overall"
