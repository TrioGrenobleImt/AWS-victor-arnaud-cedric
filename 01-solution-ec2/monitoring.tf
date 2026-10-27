# Alarms (10 free per month) -> dedicated unencrypted topic: CloudWatch
# cannot publish to a topic encrypted with the AWS managed SNS key.
resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.notification_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.notification_email
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.project}-orders-dlq-not-empty"
  alarm_description   = "Orders failed processing 3 times and landed in the DLQ"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.orders_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${var.project}-unhealthy-hosts"
  alarm_description   = "At least one instance behind the ALB is unhealthy"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.app.arn_suffix, TargetGroup = aws_lb_target_group.app.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.project}-alb-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.app.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.project}-db-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = var.project
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "ALB requests / 5xx"
          region = var.region
          stat   = "Sum"
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.app.arn_suffix],
            [".", "HTTPCode_Target_5XX_Count", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title  = "Order queue"
          region = var.region
          stat   = "Sum"
          metrics = [
            ["AWS/SQS", "NumberOfMessagesSent", "QueueName", aws_sqs_queue.orders.name],
            [".", "NumberOfMessagesDeleted", ".", "."],
            [".", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.orders_dlq.name],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title   = "EC2 CPU (ASG)"
          region  = var.region
          stat    = "Average"
          metrics = [["AWS/EC2", "CPUUtilization", "AutoScalingGroupName", aws_autoscaling_group.app.name]]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "RDS"
          region = var.region
          stat   = "Average"
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier],
            [".", "DatabaseConnections", ".", "."],
          ]
        }
      },
    ]
  })
}
