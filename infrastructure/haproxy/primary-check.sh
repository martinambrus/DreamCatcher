#!/bin/sh
VIP=$1
VPT=$2
RIP=$3

PG_MONITOR_USER=`/bin/cat /tmp/haproxy_user`
PG_MONITOR_PASS=`/bin/cat /tmp/haproxy_pw`
PG_MONITOR_DB=postgres

if [ "$4" == "" ]; then
  RPT=$VPT
else
  RPT=$4
fi

STATUS=$(PGPASSWORD="$PG_MONITOR_PASS" /usr/bin/psql -qtAX -c "select pg_is_in_recovery()" -h "$RIP" -p "$RPT" --dbname="$PG_MONITOR_DB" --username="$PG_MONITOR_USER")

if [[ "$STATUS" == "f" ]]
then
  exit 0
else
  exit 1
fi