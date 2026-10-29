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

output "user_pool_id" {
  value = aws_cognito_user_pool.admin.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.backoffice.id
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.id
}

output "audit_bucket" {
  value = aws_s3_bucket.audit.id
}

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}
