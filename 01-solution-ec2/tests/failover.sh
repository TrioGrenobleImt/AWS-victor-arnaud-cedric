#!/usr/bin/env bash
# Resilience scenario: terminate one instance and watch the ASG replace it
# while the site keeps answering through the remaining AZ.
# Needs 2 running instances: terraform apply -var asg_min_size=2 (with 1, expect
# 502/503 until the replacement passes its health checks).
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_URL=$(terraform output -raw base_url)
ASG=$(terraform output -raw asg_name)
VICTIM=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
  --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)

echo "Terminating $VICTIM"
aws ec2 terminate-instances --instance-ids "$VICTIM" >/dev/null

for _ in $(seq 40); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/health")
  INSTANCES=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
    --query 'AutoScalingGroups[0].Instances[].[InstanceId,LifecycleState,HealthStatus]' --output text | tr '\n' ' ')
  echo "$(date +%T) http=$CODE  $INSTANCES"
  sleep 15
done
