# --- ECS cluster on EC2 (Free Tier t3.micro container instances) -------------
# EC2 launch type rather than Fargate: Fargate has no free tier, while the ECS
# control plane is free and the instances fit the 750 h/month t3.micro offer.
resource "aws_ecs_cluster" "main" {
  name = var.project

  setting {
    name  = "containerInsights"
    value = "disabled" # billed custom metrics
  }
}

data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

resource "aws_security_group" "ecs_instances" {
  name        = "${var.project}-ecs-instances"
  description = "Container instances: task ports reachable only from the ALB"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.ecs_instances.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 32768
  to_port                      = 65535
}

# Outbound HTTPS to ECR, ECS, DynamoDB, SNS, CloudWatch Logs (no NAT Gateway).
resource "aws_vpc_security_group_egress_rule" "instances_all" {
  security_group_id = aws_security_group.ecs_instances.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# --- IAM: instance role (ECS agent + Session Manager, no SSH keys) -----------
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_instance" {
  name               = "${var.project}-ecs-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_instance" {
  for_each = toset([
    "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ])
  role       = aws_iam_role.ecs_instance.name
  policy_arn = each.value
}

resource "aws_iam_instance_profile" "ecs_instance" {
  name = "${var.project}-ecs-instance"
  role = aws_iam_role.ecs_instance.name
}

resource "aws_launch_template" "ecs" {
  name_prefix   = "${var.project}-ecs-"
  image_id      = data.aws_ssm_parameter.ecs_ami.value
  instance_type = var.instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.ecs_instance.arn
  }

  vpc_security_group_ids = [aws_security_group.ecs_instances.id]

  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1 # containers (bridge network) cannot reach the instance credentials
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 30 # ECS AMI minimum; 30 GB EBS is in the Free Tier
      volume_type = "gp3"
      encrypted   = true
    }
  }

  user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "ECS_CLUSTER=${aws_ecs_cluster.main.name}" >> /etc/ecs/ecs.config
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.project}-ecs" }
  }
}

resource "aws_autoscaling_group" "ecs" {
  name                  = "${var.project}-ecs"
  vpc_zone_identifier   = aws_subnet.public[*].id
  min_size              = var.asg_min_size
  max_size              = var.asg_max_size
  protect_from_scale_in = false

  launch_template {
    id      = aws_launch_template.ecs.id
    version = aws_launch_template.ecs.latest_version
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity] # driven by the ECS capacity provider
  }
}

# The capacity provider adds an instance when pending tasks no longer fit and
# removes empty ones (managed scaling), draining tasks first.
resource "aws_ecs_capacity_provider" "ec2" {
  name = "${var.project}-ec2"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs.arn
    managed_termination_protection = "DISABLED"
    managed_draining               = "ENABLED"

    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = [aws_ecs_capacity_provider.ec2.name]

  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.ec2.name
    weight            = 1
  }
}

# --- Services: shop API + admin API (same image, different entry point) -------
locals {
  common_env = {
    AWS_REGION     = var.region
    PRODUCTS_TABLE = aws_dynamodb_table.products.name
    ORDERS_TABLE   = aws_dynamodb_table.orders.name
    TOPIC_ARN      = aws_sns_topic.orders.arn
  }

  services = {
    shop-api = {
      command       = ["node", "api/server.js"]
      desired_count = var.api_desired_count
      environment   = local.common_env
      policy        = data.aws_iam_policy_document.shop_task.json
    }
    admin-api = {
      command       = ["node", "admin/server.js"]
      desired_count = var.admin_desired_count
      environment = merge(local.common_env, {
        USER_POOL_ID        = aws_cognito_user_pool.admin.id
        USER_POOL_CLIENT_ID = aws_cognito_user_pool_client.backoffice.id
        IMAGES_BUCKET       = aws_s3_bucket.images.id
        DOCUMENTS_BUCKET    = aws_s3_bucket.documents.id
      })
      policy = data.aws_iam_policy_document.admin_task.json
    }
  }
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by the ECS agent: pull the image from ECR, write logs.
resource "aws_iam_role" "task_execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Used by the application code: one least-privilege role per service.
data "aws_iam_policy_document" "shop_task" {
  source_policy_documents = [data.aws_iam_policy_document.sns_kms.json]

  statement {
    sid       = "ReadCatalogTakeStock"
    actions   = ["dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.products.arn]
  }
  statement {
    sid       = "PlaceAndTrackOrders"
    actions   = ["dynamodb:PutItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.orders.arn]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.orders.arn]
  }
}

data "aws_iam_policy_document" "admin_task" {
  source_policy_documents = [data.aws_iam_policy_document.sns_kms.json]

  statement {
    sid       = "ManageCatalog"
    actions   = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.products.arn]
  }
  statement {
    sid       = "ManageOrders"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.orders.arn, "${aws_dynamodb_table.orders.arn}/index/by_month"]
  }
  statement {
    sid       = "PresignCoverUploads" # presigned POSTs carry the task role's permission
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.images.arn}/images/uploads/*"]
  }
  statement {
    sid       = "PresignPackingSlips"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.documents.arn}/packing-slips/*"]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.orders.arn]
  }
  statement {
    sid = "ManageBackOfficeAccounts" # the Team page: invite, change role, disable, remove
    actions = [
      "cognito-idp:ListUsersInGroup",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminUserGlobalSignOut",
    ]
    resources = [aws_cognito_user_pool.admin.arn]
  }
}

resource "aws_iam_role" "task" {
  for_each           = local.services
  name               = "${var.project}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "task" {
  for_each = local.services
  name     = "permissions"
  role     = aws_iam_role.task[each.key].id
  policy   = each.value.policy
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.services
  name              = "/ecs/${var.project}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.services
  family                   = "${var.project}-${each.key}"
  requires_compatibilities = ["EC2"]
  network_mode             = "bridge"
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  container_definitions = jsonencode([{
    name              = "app"
    image             = local.api_image
    command           = each.value.command
    essential         = true
    cpu               = 256
    memoryReservation = 128 # soft limit: every task + a deployment surge fit on a t3.micro
    memory            = 256 # hard limit
    portMappings      = [{ containerPort = 8080, hostPort = 0, protocol = "tcp" }]
    environment       = [for k, v in each.value.environment : { name = k, value = v }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])

  depends_on = [terraform_data.api_image]
}

resource "aws_ecs_service" "service" {
  for_each                           = local.services
  name                               = each.key
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.service[each.key].arn
  desired_count                      = each.value.desired_count
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.ec2.name
    weight            = 1
  }

  # One task per AZ when 2 instances run, then pack instances to save cost.
  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }
  ordered_placement_strategy {
    type  = "binpack"
    field = "memory"
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.service[each.key].arn
    container_name   = "app"
    container_port   = 8080
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count] # shop-api: driven by Application Auto Scaling
  }

  depends_on = [aws_lb_listener.http, aws_lb_listener_rule.admin, aws_ecs_cluster_capacity_providers.main]
}

# --- Shop API auto scaling on CPU ------------------------------------------------
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.service["shop-api"].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.project}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
