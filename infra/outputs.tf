output "base_url" {
  description = "Shop URL (CloudFront: storefront, /images/* and /api/*)."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service" {
  value = aws_ecs_service.api.name
}

output "asg_name" {
  value = aws_autoscaling_group.ecs.name
}

output "api_image" {
  value = local.api_image
}

output "images_bucket" {
  value = aws_s3_bucket.images.id
}

output "audit_bucket" {
  value = aws_s3_bucket.audit.id
}

output "orders_table" {
  value = aws_dynamodb_table.orders.name
}

output "order_topic_arn" {
  value = aws_sns_topic.orders.arn
}

output "cloudtrail_bucket" {
  value = var.enable_cloudtrail ? aws_s3_bucket.trail[0].id : null
}

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}
