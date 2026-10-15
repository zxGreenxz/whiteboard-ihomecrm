#!/bin/sh
# Do bat tay TLS lap lai tu host va tu netns cua worker/Hermes. Dung: tls-probe.sh <nhan> [so_lan]
set -u
LABEL=${1:-run}; N=${2:-75}; WHERES=${3:-host netns}
OUT=/root/ihome-perf/probe-$LABEL-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"
PID=$(docker inspect -f '{{.State.Pid}}' ihome-zalo-worker)
TARGETS="https://ai.chillhome.io.vn/v1/models https://crm-hermes.chillhome.io.vn/mcp https://chatgpt.com/ https://tryymsxyyckgbrmmvozx.supabase.co/rest/v1/"
CNT="TcpActiveOpens TcpExtTCPSynRetrans TcpRetransSegs TcpOutSegs TcpExtTCPTimeouts TcpExtTCPMTUPSuccess TcpExtTCPMTUPFail"
nstat -az $CNT > "$OUT/nstat-before.txt" 2>&1
for where in $WHERES; do
  for t in $TARGETS; do
    h=$(echo "$t" | cut -d/ -f3); ip=$(getent ahostsv4 "$h" | awk "NR==1{print \$1}"); RES="--resolve $h:443:$ip"
    i=0
    while [ $i -lt $N ]; do
      if [ $where = host ]; then
        r=$(curl $RES -s -o /dev/null -m 40 -w '%{http_code} %{time_connect} %{time_appconnect} %{time_total}' "$t")
      else
        r=$(nsenter -t "$PID" -n curl $RES -s -o /dev/null -m 40 -w '%{http_code} %{time_connect} %{time_appconnect} %{time_total}' "$t")
      fi
      echo "$where $t $r" >> "$OUT/raw.txt"
      i=$((i+1))
    done
  done
done
nstat -az $CNT > "$OUT/nstat-after.txt" 2>&1
awk '{k=$1" "$2; n[k]++; if($3=="000") f[k]++; if($5+0>3) s[k]++; t[k]=t[k]" "$6}
  END{for(k in n){split(t[k],a," "); m=asort(a); printf "%-60s n=%d fail=%d tls>3s=%d p50=%.2f p95=%.2f max=%.2f\n",k,n[k],f[k]+0,s[k]+0,a[int(m*0.5)+1],a[int(m*0.95)],a[m]}}' "$OUT/raw.txt" | sort > "$OUT/summary.txt"
echo "$OUT"; cat "$OUT/summary.txt"; paste "$OUT/nstat-before.txt" "$OUT/nstat-after.txt" | awk 'NR>1{printf "%-26s %s\n",$1,$5-$2}'
