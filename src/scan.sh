# Run on the SSH host. Return only listeners whose processes belong to this project.
set -eu
export LC_ALL=C
root=$(realpath -e -- "$1")
test -d "$root"
test "$root" != /
shift

for family in 4 6; do
  listeners=$(ss -H -O -ltnp "-$family")
  printf '%s\n' "$listeners" |
    awk '$1 == "LISTEN" {
      detail = $0
      while (match(detail, /,pid=[0-9]+,fd=[0-9]+\)/)) {
        pid = substr(detail, RSTART + 5, RLENGTH - 5)
        sub(/,.*/, "", pid)
        print $4, pid
        detail = substr(detail, RSTART + RLENGTH)
      }
    }' |
    while read -r address pid; do
      cwd=$(readlink -- "/proc/$pid/cwd") || continue
      case "$cwd" in "$root"|"$root"/*) ;; *) continue ;; esac

      for workspace in "$@"; do
        child=$(realpath -e -- "$workspace" 2>/dev/null) || continue
        case "$child" in "$root"/*) ;; *) continue ;; esac
        case "$cwd" in "$child"|"$child"/*) continue 2 ;; esac
      done
      process=$(tr '\t\n' '  ' 2>/dev/null < "/proc/$pid/comm") || process=
      printf '%s\t%s\t%s\n' "$family" "$address" "$process"
    done
done
