data "aws_caller_identity" "current" {}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-*-x86_64"]
  }
}

# --- Application artifacts (code + frontend + catalog) on S3 ----------------
locals {
  app_files = {
    "app.py"           = "${path.module}/app/app.py"
    "worker.py"        = "${path.module}/app/worker.py"
    "requirements.txt" = "${path.module}/app/requirements.txt"
    "catalog.json"     = "${path.module}/../shared/catalog.json"
    "index.html"       = "${path.module}/../shared/frontend/index.html"
  }

  # Any change to the code produces a new launch template version, which
  # triggers a rolling instance refresh of the Auto Scaling group.
  app_version = substr(sha1(join("", [for f in values(local.app_files) : filesha1(f)])), 0, 12)
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "${var.project}-artifacts-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "app" {
  for_each = local.app_files
  bucket   = aws_s3_bucket.artifacts.id
  key      = "releases/${local.app_version}/${each.key}"
  source   = each.value
  etag     = filemd5(each.value)
}

# --- Launch template + Auto Scaling group across 2 AZs ----------------------
resource "aws_launch_template" "app" {
  name_prefix   = "${var.project}-"
  image_id      = data.aws_ami.al2023.id
  instance_type = var.instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.app.arn
  }

  vpc_security_group_ids = [aws_security_group.app.id]

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 8
      volume_type = "gp3"
      encrypted   = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/templates/user_data.sh.tftpl", {
    region          = var.region
    artifact_bucket = aws_s3_bucket.artifacts.id
    app_version     = local.app_version
    db_host         = aws_db_instance.main.address
    db_name         = aws_db_instance.main.db_name
    db_user         = aws_db_instance.main.username
    db_password_ssm = aws_ssm_parameter.db_password.name
    topic_arn       = aws_sns_topic.orders.arn
    queue_url       = aws_sqs_queue.orders.id
  }))

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.project}-app" }
  }

  depends_on = [aws_s3_object.app]
}

resource "aws_autoscaling_group" "app" {
  name                      = "${var.project}-asg"
  vpc_zone_identifier       = aws_subnet.public[*].id
  min_size                  = var.asg_min_size
  max_size                  = var.asg_max_size
  target_group_arns         = [aws_lb_target_group.app.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 300

  launch_template {
    id      = aws_launch_template.app.id
    version = aws_launch_template.app.latest_version
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.project}-app"
    propagate_at_launch = true
  }
}

resource "aws_autoscaling_policy" "cpu" {
  name                   = "${var.project}-cpu-target"
  autoscaling_group_name = aws_autoscaling_group.app.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = 60
  }
}

# --- Application Load Balancer ---------------------------------------------
resource "aws_lb" "app" {
  name               = "${var.project}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "app" {
  name                 = "${var.project}-tg"
  port                 = 8080
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
