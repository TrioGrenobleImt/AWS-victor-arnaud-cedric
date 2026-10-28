# --- Application Load Balancer (reachable only from CloudFront) --------------
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.project}-alb"
  description = "HTTP from CloudFront edge locations only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

# ECS bridge networking maps each task to a random host port (ephemeral range).
resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.ecs_instances.id
  ip_protocol                  = "tcp"
  from_port                    = 32768
  to_port                      = 65535
}

resource "aws_lb" "api" {
  name               = "${var.project}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "service" {
  for_each             = local.services
  name                 = "${var.project}-${each.key}"
  port                 = 8080 # overridden per task by the dynamic host port
  protocol             = "HTTP"
  target_type          = "instance"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  health_check {
    path                = each.key == "admin-api" ? "/admin/api/health" : "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# /api/* and everything else -> shop API; /admin/api/* -> admin API.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["shop-api"].arn
  }
}

resource "aws_lb_listener_rule" "admin" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/admin/api/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service["admin-api"].arn
  }
}
