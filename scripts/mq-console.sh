#!/usr/bin/env bash
# mq-console.sh -- Open the Amazon MQ (ActiveMQ) web console from your laptop.
#
# The console (port 8162) is not exposed publicly. This script reuses the
# on-demand tinyproxy ECS task (see src/ProxyStack.ts) as an in-VPC HTTP forward
# proxy and tunnels it to localhost over AWS SSM. Because the browser issues
# CONNECT <broker-host>:8162 through the proxy, TLS terminates at the real broker
# hostname and its certificate validates normally -- no localhost/self-signed
# workaround needed.
#
# Usage:
#   ./scripts/mq-console.sh [--profile <aws-profile>] [--region <aws-region>] [--port <local-port>]
#
# Defaults:
#   --profile  AWS_PROFILE env var (or default profile)
#   --region   eu-central-1
#   --port     8888  (same as the container port)
#
# Once running, set your browser's HTTP/HTTPS proxy to http://localhost:<local-port>
# and open the console URL printed below. Press Ctrl+C to stop the tunnel; the
# script also stops the ECS task automatically.

set -euo pipefail

# -- Argument parsing ---------------------------------------------------------
AWS_PROFILE="${AWS_PROFILE:-}"
REGION="eu-central-1"
LOCAL_PORT="8888"
PROJECT="mule-infra"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) AWS_PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";      shift 2 ;;
    --port)    LOCAL_PORT="$2";  shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

PROFILE_ARGS=()
[[ -n "$AWS_PROFILE" ]] && PROFILE_ARGS=(--profile "$AWS_PROFILE")

AWS="aws ${PROFILE_ARGS[*]+${PROFILE_ARGS[*]}} --region $REGION"
PROXY="http://localhost:${LOCAL_PORT}"

# -- Read discovery parameters from SSM -------------------------------------- -
echo "Reading discovery parameters from SSM Parameter Store..."

get_param() {
  $AWS ssm get-parameter --name "$1" --query "Parameter.Value" --output text
}

CLUSTER_NAME=$(get_param     "/${PROJECT}/proxy/cluster-name")
TASK_DEF_ARN=$(get_param     "/${PROJECT}/proxy/task-definition-arn")
SUBNET_ID=$(get_param        "/${PROJECT}/proxy/subnet-id")
SG_ID=$(get_param            "/${PROJECT}/proxy/security-group-id")
CONSOLE_URLS=$(get_param     "/${PROJECT}/activemq/console-urls")
ADMIN_SECRET_ARN=$(get_param "/${PROJECT}/activemq/admin-secret-arn")

ADMIN_PASSWORD=$($AWS secretsmanager get-secret-value \
  --secret-id "$ADMIN_SECRET_ARN" --query "SecretString" --output text)

echo "  Cluster:      $CLUSTER_NAME"
echo "  Console URLs: $CONSOLE_URLS"

# -- Start the tinyproxy ECS task ------------------------------------------- --
echo ""
echo "Starting tinyproxy ECS task..."

TASK_ARN=$($AWS ecs run-task \
  --cluster "$CLUSTER_NAME" \
  --task-definition "$TASK_DEF_ARN" \
  --launch-type FARGATE \
  --enable-execute-command \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=DISABLED}" \
  --query "tasks[0].taskArn" \
  --output text)

echo "  Task ARN: $TASK_ARN"
TASK_ID="${TASK_ARN##*/}"

# -- Ensure the tunnel and task are cleaned up on exit ---------------------- --
SSM_PID=""
CLEANED=0
cleanup() {
  [[ "$CLEANED" == "1" ]] && return 0
  CLEANED=1
  echo ""
  [[ -n "$SSM_PID" ]] && kill "$SSM_PID" >/dev/null 2>&1 || true
  echo "Stopping ECS task $TASK_ID..."
  $AWS ecs stop-task --cluster "$CLUSTER_NAME" --task "$TASK_ARN" >/dev/null 2>&1 || true
  echo "   Done."
}
trap cleanup EXIT INT TERM

# -- Wait for RUNNING state ------------------------------------------------- --
echo ""
echo "Waiting for task to reach RUNNING state (this can take ~30 seconds)..."
$AWS ecs wait tasks-running --cluster "$CLUSTER_NAME" --tasks "$TASK_ARN"
echo "   Task is running!"

# -- Resolve container runtime ID for the SSM target --------------------- ----
RUNTIME_ID=$($AWS ecs describe-tasks \
  --cluster "$CLUSTER_NAME" \
  --tasks "$TASK_ARN" \
  --query "tasks[0].containers[0].runtimeId" \
  --output text)

SSM_TARGET="ecs:${CLUSTER_NAME}_${TASK_ID}_${RUNTIME_ID}"

# -- Open the SSM port-forward in the background -------------------------- ----
echo ""
echo "Opening SSM port-forward on ${PROXY}..."
$AWS ssm start-session \
  --target "$SSM_TARGET" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"8888\"],\"localPortNumber\":[\"${LOCAL_PORT}\"]}" \
  >/dev/null 2>&1 &
SSM_PID=$!

# -- Probe the console URLs through the proxy ---------------------------- -----
# This waits for the tunnel to come up and identifies the active broker
# instance (only the active node of an ACTIVE_STANDBY_MULTI_AZ pair answers).
ACTIVE_URL=""
IFS=',' read -ra URL_LIST <<< "$CONSOLE_URLS"
for _ in $(seq 1 30); do
  for url in "${URL_LIST[@]}"; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' \
      --proxy "$PROXY" --max-time 8 "${url}/admin/" || true)
    if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
      ACTIVE_URL="$url"
      break 2
    fi
  done
  sleep 1
done

echo ""
echo "================================================================"
if [[ -n "$ACTIVE_URL" ]]; then
  echo "ActiveMQ web console is reachable."
  echo ""
  echo "  Active instance:  ${ACTIVE_URL}"
else
  echo "Tunnel is up, but neither console instance answered yet."
  echo "The broker may still be starting - retry the URLs below shortly."
fi
echo ""
echo "  All console URLs: ${CONSOLE_URLS//,/    }"
echo ""
echo "  1. Set your browser HTTP/HTTPS proxy to:  ${PROXY}"
echo "  2. Open the console URL above (the broker cert is valid - no warning)."
echo ""
echo "  Login:"
echo "    username: admin"
echo "    password: ${ADMIN_PASSWORD}"
echo ""
echo "  CLI check (proxy cert not verified by curl, hence -k):"
echo "    curl -sk --proxy ${PROXY} -I ${ACTIVE_URL:-<console-url>}/admin/"
echo ""
echo "  Press Ctrl+C to stop the proxy and terminate the ECS task."
echo "================================================================"
echo ""

wait "$SSM_PID"
