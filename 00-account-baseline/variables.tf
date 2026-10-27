variable "region" {
  description = "AWS region used by the project."
  type        = string
  default     = "eu-west-3"
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "fisa-shop"
}

variable "alert_email" {
  description = "Email that receives budget alerts."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget. Alerts fire at 80% (actual) and 100% (forecast)."
  type        = number
  default     = 1
}

variable "enable_cloudtrail" {
  description = "Create a CloudTrail trail for management events (the first trail is free; only S3 storage is billed)."
  type        = bool
  default     = true
}
