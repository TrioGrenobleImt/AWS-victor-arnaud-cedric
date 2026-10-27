variable "region" {
  description = "AWS region. eu-west-3 (Paris) offers t3.micro / db.t4g.micro in the Free Tier."
  type        = string
  default     = "eu-west-3"
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "fisa-shop-ec2"
}

variable "vpc_cidr" {
  type    = string
  default = "10.10.0.0/16"
}

variable "instance_type" {
  description = "Free Tier eligible instance type (t3.micro in most regions, t2.micro in older ones)."
  type        = string
  default     = "t3.micro"
}

variable "asg_min_size" {
  description = "Minimum number of web/worker instances. 2 = one per AZ (high availability). Free Tier covers 750 h/month in total."
  type        = number
  default     = 2
}

variable "asg_max_size" {
  type    = number
  default = 3
}

variable "db_instance_class" {
  description = "Free Tier eligible RDS class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_multi_az" {
  description = "Multi-AZ standby for RDS. Not covered by the Free Tier, so disabled by default."
  type        = bool
  default     = false
}

variable "notification_email" {
  description = "Optional email subscribed to order notifications and alarms (leave empty to skip). The subscription must be confirmed from the inbox."
  type        = string
  default     = ""
}
