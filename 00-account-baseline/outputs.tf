output "budget_name" {
  value = aws_budgets_budget.monthly.name
}

output "cloudtrail_bucket" {
  value = var.enable_cloudtrail ? aws_s3_bucket.trail[0].id : null
}
