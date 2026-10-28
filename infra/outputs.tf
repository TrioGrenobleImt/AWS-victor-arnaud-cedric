output "base_url" {
  description = "Shop URL (CloudFront: storefront, /images/* and /api/*)."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "backoffice_url" {
  description = "Back office (Cognito sign-in, admins group)."
  value       = local.backoffice_url
}

output "ecs_service" {
  value = aws_ecs_service.service["shop-api"].name
}

output "admin_service" {
  value = aws_ecs_service.service["admin-api"].name
}

output "user_pool_id" {
  value = aws_cognito_user_pool.admin.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.backoffice.id
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.id
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
