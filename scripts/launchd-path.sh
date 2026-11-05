# Sourced by the launchd installer. launchd_path "$PATH" prints the PATH a launchd job keeps: absolute entries, once
# each, without a checkout's node_modules/.bin, a package manager's node-gyp-bin, or anything under ~/Documents. An
# install run from a checkout would otherwise put that checkout's node_modules/.bin first in the job's PATH, where it
# outlives the checkout, and a path under ~/Documents stalls a launchd job while a macOS privacy prompt is pending.
launchd_path() {
  local out="" dir
  while IFS= read -r dir; do
    case "$dir" in
      /*) ;;
      *) continue ;;
    esac
    case "$dir" in
      */node_modules/.bin | */node-gyp-bin | "$HOME"/Documents | "$HOME"/Documents/*) continue ;;
    esac
    [[ ":$out:" == *":$dir:"* ]] || out="${out:+$out:}$dir"
  done < <(printf '%s\n' "$1" | tr ':' '\n')
  printf '%s' "$out"
}
