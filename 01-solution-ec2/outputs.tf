output "base_url" {
  description = "Shop URL (ALB)."
  value       = "http://${aws_lb.app.dns_name}"
}

output "asg_name" {
  value = aws_autoscaling_group.app.name
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "order_topic_arn" {
  value = aws_sns_topic.orders.arn
}

output "order_queue_url" {
  value = aws_sqs_queue.orders.id
}

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}
