#!/usr/bin/env bash
# start-proxy.sh -- Start an on-demand tinyproxy ECS task and open an SSM port-forward tunnel.
#
# Usage:
#   ./scripts/start-proxy.sh [--profile <aws-profile>] [--region <aws-region>] [--port <local-port>]
#
# Defaults:
#   --profile  AWS_PROFILE env var (or default profile)
#   --region   eu-central-1
#   --port     8888  (same as the container port)
#
# Once running, configure your HTTP proxy to http://localhost:<local-port> and browse VPC resources.
# Press Ctrl+C to stop the tunnel; the script will also stop the ECS task automatically.

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

# -- Read discovery parameters from SSM ---------------------------------------
echo "Searching SSM Parameter Store for proxy configuration..."

get_param() {
  $AWS ssm get-parameter --name "$1" --query "Parameter.Value" --output text
}

CLUSTER_NAME=$(get_param "/${PROJECT}/proxy/cluster-name")
TASK_DEF_ARN=$(get_param  "/${PROJECT}/proxy/task-definition-arn")
SUBNET_ID=$(get_param     "/${PROJECT}/proxy/subnet-id")
SG_ID=$(get_param         "/${PROJECT}/proxy/security-group-id")

echo "  Cluster:         $CLUSTER_NAME"
echo "  Task definition: $TASK_DEF_ARN"
echo "  Subnet:          $SUBNET_ID"
echo "  Security group:  $SG_ID"

# -- Start the ECS task -------------------------------------------------------
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

# -- Ensure the task is stopped on script exit --------------------------------
cleanup() {
  echo ""
  echo "Stopping ECS task $TASK_ID..."
  $AWS ecs stop-task --cluster "$CLUSTER_NAME" --task "$TASK_ARN" > /dev/null 2>&1 || true
  echo "   Done."
}
trap cleanup EXIT INT TERM

# -- Wait for RUNNING state ---------------------------------------------------
echo ""
echo "Waiting for task to reach RUNNING state (this can take ~30 seconds)..."
$AWS ecs wait tasks-running --cluster "$CLUSTER_NAME" --tasks "$TASK_ARN"
echo "   Task is running!"

# -- Resolve container runtime ID for SSM target ------------------------------
# ECS target format:  ecs:<cluster-name>_<task-id>_<container-runtime-id>
echo ""
echo "Resolving container runtime ID..."
RUNTIME_ID=$($AWS ecs describe-tasks \
  --cluster "$CLUSTER_NAME" \
  --tasks "$TASK_ARN" \
  --query "tasks[0].containers[0].runtimeId" \
  --output text)

SSM_TARGET="ecs:${CLUSTER_NAME}_${TASK_ID}_${RUNTIME_ID}"

echo "   SSM target: $SSM_TARGET"
echo ""
echo "================================================================"
echo "Proxy is ready!"
echo ""
echo "  Configure your HTTP proxy to:  http://localhost:${LOCAL_PORT}"
echo ""
echo "  Example:"
echo "  curl https://nijm-cko-t-001.gn.karelstad.nl --proxy http://localhost:${LOCAL_PORT}"
echo ""
echo "  Press Ctrl+C to stop the proxy and terminate the ECS task."
echo "================================================================"
echo ""

$AWS ssm start-session \
  --target "$SSM_TARGET" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"8888\"],\"localPortNumber\":[\"${LOCAL_PORT}\"]}"
