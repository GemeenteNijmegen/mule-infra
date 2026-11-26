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
# rootfs, not fs: only rootfs reads installed jars, fs only reads lock files like pom.xml.
# The first scan in a task downloads the vulnerability and Java databases.
# Walking EFS took ~8 minutes, past Trivy's default 5 minute timeout. Each jar
# read is a round trip to EFS, so more than the default 5 parallel reads pays off.
# .mule is the runtime's working data (object stores, queues), not dependencies.
echo ""
$AWS ecs execute-command \
  --cluster "$CLUSTER_NAME" \
  --task "$TASK_ARN" \
  --container TrivyContainer \
  --interactive \
  --command "trivy rootfs --scanners vuln --severity HIGH,CRITICAL --no-progress --timeout 30m --parallel 20 --skip-dirs **/.mule /scan"
