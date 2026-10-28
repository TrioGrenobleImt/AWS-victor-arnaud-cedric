#!/usr/bin/env bash
# Resilience scenario: stop one shop API task and watch ECS replace it while
# the other task keeps serving through the ALB.
# For instance-level failover, deploy with -var asg_min_size=2 and terminate an
# instance instead: the capacity provider + ASG replace it.
set -euo pipefail
cd "$(dirname "$0")/.."

tf() { terraform -chdir=infra output -raw "$1"; }
BASE_URL=$(tf base_url)
CLUSTER=$(tf ecs_cluster)
SERVICE=$(tf ecs_service)
VICTIM=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --query 'taskArns[0]' --output text)

echo "Stopping task ${VICTIM##*/}"
aws ecs stop-task --cluster "$CLUSTER" --task "$VICTIM" --reason "failover test" >/dev/null

for _ in $(seq 20); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/health")
  TASKS=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --query 'taskArns' --output text | tr '\t' '\n' | sed 's|.*/||' | cut -c1-12 | tr '\n' ' ')
  echo "$(date +%T) http=$CODE  running tasks: $TASKS"
  sleep 10
done
