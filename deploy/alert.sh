#!/bin/sh
# Post one alert about a failed unit.
#
#   deploy/alert.sh raiseroom-backup.service
#
# Called by raiseroom-alert@.service, which both timers declare in OnFailure.
# Reads ALERT_WEBHOOK from the environment (systemd supplies it from
# /etc/raiseroom/alert.env).
#
# WHY THIS IS A FILE AND NOT A LINE IN THE UNIT
#
# The payload is JSON containing log output, and log output contains quotes,
# newlines and backslashes. Building that inside an ExecStart= line means two
# layers of escaping — systemd's and the shell's — over text an attacker can
# partly influence, in the one script that has to work on the worst night of
# the year. So the JSON is built by node, which is already on this host because
# the check runs from it, and which cannot be talked out of escaping correctly.
#
# Exits 0 when the webhook accepted the alert, 1 otherwise. systemd records the
# failure, which is all that is left to do about an alerting system that is
# itself down.

set -eu

unit="${1:-unknown.service}"

if [ -z "${ALERT_WEBHOOK:-}" ]; then
  echo "ALERT_WEBHOOK is not set. See the header of deploy/raiseroom-alert@.service." >&2
  exit 1
fi

# The last ten lines of the failed unit. For both of ours that is the human
# summary naming the alert, not a stack trace. Capped so a runaway log cannot
# turn one alert into a megabyte.
summary="$(journalctl -u "$unit" -n 10 --no-pager -o cat 2>/dev/null | tail -c 1500 || true)"

payload="$(UNIT="$unit" SUMMARY="$summary" HOSTNAME="$(hostname)" node -e '
  const { UNIT, SUMMARY, HOSTNAME } = process.env;
  process.stdout.write(JSON.stringify({
    text: `RaiseRoom: ${UNIT} failed on ${HOSTNAME}\n\n${SUMMARY || "(no output in the journal)"}`,
  }));
')"

printf '%s' "$payload" | curl -sS --fail --max-time 20 \
  -X POST -H 'Content-Type: application/json' --data-binary @- "$ALERT_WEBHOOK"
