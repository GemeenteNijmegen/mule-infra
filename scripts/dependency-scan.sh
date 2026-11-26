#!/usr/bin/env bash
# dependency-scan.sh -- Run the Trivy scan of the Mule apps on EFS from your laptop.
#
# Starts the on-demand dependency scan task (see src/DependencyScanStack.ts),
# runs Trivy in it over ECS Exec so the report prints in this terminal, and
# stops the task again.
#
# Usage:
#   ./scripts/dependency-scan.sh [--profile <aws-profile>] [--region <aws-region>]

set -euo pipefail

# -- Argument parsing ---------------------------------------------------------
AWS_PROFILE="${AWS_PROFILE:-}"
REGION="eu-central-1"
PROJECT="mule-infra"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) AWS_PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";      shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

PROFILE_ARGS=()
[[ -n "$AWS_PROFILE" ]] && PROFILE_ARGS=(--profile "$AWS_PROFILE")

AWS="aws ${PROFILE_ARGS[*]+${PROFILE_ARGS[*]}} --region $REGION"

# -- Preflight: 'aws ecs execute-command' needs the Session Manager plugin -----
if ! command -v session-manager-plugin >/dev/null 2>&1; then
  echo "ERROR: 'session-manager-plugin' is not installed or not on PATH." >&2
  echo "       Install:  brew install --cask session-manager-plugin" >&2
  exit 1
fi

# -- Read discovery parameters from SSM ---------------------------------------
get_param() {
  $AWS ssm get-parameter --name "$1" --query "Parameter.Value" --output text
}

CLUSTER_NAME=$(get_param "/${PROJECT}/dependency-scan/cluster-name")
TASK_DEF_ARN=$(get_param "/${PROJECT}/dependency-scan/task-definition-arn")
SUBNET_ID=$(get_param    "/${PROJECT}/dependency-scan/subnet-id")
SG_ID=$(get_param        "/${PROJECT}/dependency-scan/security-group-id")

# -- Start the scan task ------------------------------------------------------
echo "Starting dependency scan task..."
TASK_ARN=$($AWS ecs run-task \
  --cluster "$CLUSTER_NAME" \
  --task-definition "$TASK_DEF_ARN" \
  --launch-type FARGATE \
  --enable-execute-command \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=DISABLED}" \
  --query "tasks[0].taskArn" \
  --output text)
echo "  Task ARN: $TASK_ARN"

cleanup() {
  echo ""
  echo "Stopping ECS task ${TASK_ARN##*/}..."
  $AWS ecs stop-task --cluster "$CLUSTER_NAME" --task "$TASK_ARN" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Waiting for the task to reach RUNNING state..."
$AWS ecs wait tasks-running --cluster "$CLUSTER_NAME" --tasks "$TASK_ARN"

# The exec agent starts a little after the container does.
echo "Waiting for ECS Exec to become available..."
for _ in $(seq 1 30); do
  AGENT_STATUS=$($AWS ecs describe-tasks --cluster "$CLUSTER_NAME" --tasks "$TASK_ARN" \
    --query "tasks[0].containers[0].managedAgents[?name=='ExecuteCommandAgent'].lastStatus | [0]" \
    --output text)
  [[ "$AGENT_STATUS" == "RUNNING" ]] && break
  sleep 2
done

# -- Run the scan -------------------------------------------------------------
# Runs in the container. Every app ships its own copy of the shared dependencies,
# so the raw report repeats each CVE per app. This prints each vulnerable package
# once, with its CVEs and the apps it is deployed in.
#
# rootfs, not fs: only rootfs reads installed jars, fs only reads lock files like pom.xml.
# Walking EFS took ~8 minutes, past Trivy's default 5 minute timeout. Each jar
# read is a round trip to EFS, so more than the default 5 parallel reads pays off.
# .mule is the runtime's working data (object stores, queues), not dependencies.
# The Mule agent plugin is also in the image, so the ECR scan already covers it.
SCAN_SCRIPT=$(cat <<'SCRIPT'
set -eu
cat > /tmp/findings.tpl <<'TPL'
{{- range . }}{{- range .Vulnerabilities }}{{ .Severity }}|{{ .PkgName }}|{{ .InstalledVersion }}|{{ .FixedVersion }}|{{ .VulnerabilityID }}|{{ .PkgPath }}
{{ end }}{{ end -}}
TPL
echo "Scanning, this takes about 10 minutes..."
trivy rootfs --quiet --scanners vuln --severity HIGH,CRITICAL --timeout 30m --parallel 20 \
  --skip-dirs '**/.mule' --skip-dirs '**/server-plugins/mule-agent-plugin' --format template --template @/tmp/findings.tpl --output /tmp/findings.txt /scan
APPS=$(($(find /scan/apps -mindepth 1 -maxdepth 1 -type d | wc -l)))

# One record per package and version; \036 stands in for a newline until after sorting.
awk -F'|' -v apps="$APPS" '
  function add(list, item) { return list == "" ? item : list ", " item }
  {
    key = $2 " " $3
    n = split($6, p, "/"); src = ""; isApp = 0
    for (i = 1; i < n; i++) {
      if (p[i] == "apps") { src = p[i + 1]; isApp = 1; break }
      if (p[i] == "domains" || p[i] == "server-plugins") { src = p[i + 1]; break }
    }
    if (src == "") src = $6
    if ($1 == "CRITICAL" || !(key in sev)) sev[key] = $1
    if (!((key, $5) in seen)) { seen[key, $5] = 1; cves[key] = add(cves[key], $5) }
    if ($4 != "" && !((key, "fix", $4) in seen)) { seen[key, "fix", $4] = 1; fix[key] = fix[key] == "" ? $4 : fix[key] " / " $4 }
    if (!((key, "src", src) in seen)) {
      seen[key, "src", src] = 1
      if (isApp) { appList[key] = add(appList[key], src); appCount[key]++ }
      else other[key] = add(other[key], src)
    }
  }
  END {
    for (key in sev) {
      where = appCount[key] == apps ? "ALL " apps " apps" : appList[key]
      if (other[key] != "") where = where == "" ? other[key] : where ", " other[key]
      printf "%d|%d|%s  %s  (fixed in: %s)\036  %s\036  in: %s\036\n", (sev[key] == "CRITICAL" ? 1 : 2), appCount[key],
        sev[key], key, (fix[key] == "" ? "no fix yet" : fix[key]), cves[key], where
    }
  }' /tmp/findings.txt | sort -t'|' -k1,1n -k2,2nr | cut -d'|' -f3- | tr '\036' '\n'

echo "$(($(cut -d'|' -f2,3 /tmp/findings.txt | sort -u | wc -l))) vulnerable packages," \
  "$(($(cut -d'|' -f5 /tmp/findings.txt | sort -u | wc -l))) unique CVEs (HIGH and CRITICAL), across $APPS apps."
SCRIPT
)

echo ""
$AWS ecs execute-command \
  --cluster "$CLUSTER_NAME" \
  --task "$TASK_ARN" \
  --container TrivyContainer \
  --interactive \
  --command "sh -c 'echo $(printf '%s' "$SCAN_SCRIPT" | base64 | tr -d '\n') | base64 -d | sh'"
