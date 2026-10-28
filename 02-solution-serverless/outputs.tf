output "base_url" {
  description = "Shop URL (CloudFront)."
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "api_endpoint" {
  description = "Direct API Gateway endpoint (bypasses CloudFront)."
  value       = aws_apigatewayv2_api.http.api_endpoint
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

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}
