variable "region" {
  type    = string
  default = "eu-west-3"
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "fisa-shop-sls"
}

variable "notification_email" {
  description = "Optional email subscribed to order notifications and alarms (leave empty to skip). The subscription must be confirmed from the inbox."
  type        = string
  default     = ""
}

variable "dynamodb_capacity" {
  description = "Provisioned RCU/WCU per table. The always-free tier covers 25 RCU + 25 WCU in total (2 tables x 5 = 10)."
  type        = number
  default     = 5
}

variable "log_retention_days" {
  type    = number
  default = 7
}
