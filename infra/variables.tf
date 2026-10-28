variable "region" {
  description = "AWS region. eu-west-3 (Paris) offers t3.micro in the Free Tier."
  type        = string
  default     = "eu-west-3"
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "fisa-shop"
}

variable "notification_email" {
  description = "Email for budget alerts, alarms and order notifications (leave empty to skip). SNS subscriptions must be confirmed from the inbox."
  type        = string
  default     = ""
}

variable "sender_email" {
  description = "From address of the customer emails (order placed, packed, shipped, cancelled), sent through SES. Leave empty to disable. SES emails a verification link to it; in the SES sandbox, customers must be verified addresses too (request production access for real customers)."
  type        = string
  default     = ""
}

variable "admin_email" {
  description = "Email of the first back-office admin (Cognito sends a temporary password). Leave empty to create admins later."
  type        = string
  default     = ""
}

# --- Account guardrails -------------------------------------------------------
variable "monthly_budget_usd" {
  description = "Monthly cost budget. Alerts fire at 80% (actual) and 100% (forecast). Needs notification_email."
  type        = number
  default     = 1
}

variable "enable_cloudtrail" {
  description = "Create a CloudTrail trail for management events (the first trail is free; only S3 storage is billed)."
  type        = bool
  default     = true
}

# --- Network + ECS capacity ---------------------------------------------------
variable "vpc_cidr" {
  type    = string
  default = "10.10.0.0/16"
}

variable "instance_type" {
  description = "ECS container instance type (Free Tier: t3.micro in most regions, t2.micro in older ones)."
  type        = string
  default     = "t3.micro"
}

variable "asg_min_size" {
  description = "Minimum container instances. 1 stays within the 750 h/month Free Tier; 2 spreads tasks over 2 AZs (high availability)."
  type        = number
  default     = 1
}

variable "asg_max_size" {
  description = "Maximum container instances, added by the ECS capacity provider when tasks no longer fit."
  type        = number
  default     = 2
}

variable "api_desired_count" {
  description = "Shop API tasks. 2 tasks keep the API up while one is replaced (both fit on one t3.micro)."
  type        = number
  default     = 2
}

variable "admin_desired_count" {
  description = "Admin API tasks (internal traffic only)."
  type        = number
  default     = 1
}

variable "api_max_count" {
  description = "Upper bound for API task auto scaling (CPU target tracking)."
  type        = number
  default     = 4
}

# --- Data + logs --------------------------------------------------------------
variable "dynamodb_capacity" {
  description = "Provisioned RCU/WCU per table. The always-free tier covers 25 RCU + 25 WCU in total (2 tables + 2 indexes x 5 = 20)."
  type        = number
  default     = 5
}

variable "log_retention_days" {
  type    = number
  default = 7
}
