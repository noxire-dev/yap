#!/bin/sh
# One Claude Code hook: the event's JSON to the daemon, its answer to Claude Code. Once the answer is printed, the
# seq of the messages in it goes to a cursor file and the next hook acks it, so a message whose answer was lost
# (a timeout, a restart) comes again. Never fails: a hook must not break the session.
[ -n "$YAP_AGENT" ] && exit 0
h="${YAP_HOME:-$HOME/.yap}"
in=$(cat)
id=${YAP_SESSION:-$(printf '%s' "$in" | grep -o '"session_id" *: *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')}
id=$(printf '%s' "$id" | tr -cd 'A-Za-z0-9_-')
c="$h/sessions/$id.cursor"
ack=0
[ -n "$id" ] && [ -f "$c" ] && ack=$(cat "$c")
out=$(printf '%s' "$in" | curl -sf -m 2 -w '\n%header{x-yap-seq}' -H content-type:application/json \
  -H "x-yap-token: $(cat "$h/token" 2>/dev/null)" --data-binary @- \
  "http://127.0.0.1:${YAP_PORT:-4170}/api/hook/$1?ack=$ack${YAP_SESSION:+&session=$YAP_SESSION}${HC_TERMINAL_ID:+&terminal=$HC_TERMINAL_ID}" 2>/dev/null) || exit 0
seq=${out##*
}
printf '%s' "${out%
*}"
[ -n "$id" ] || exit 0
if [ "$1" = end ]; then rm -f "$c"; exit 0; fi
case $seq in '' | *[!0-9]*) ;; *) mkdir -p "$h/sessions" && printf '%s' "$seq" >"$c" ;; esac
exit 0
