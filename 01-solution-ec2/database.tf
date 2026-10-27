resource "random_password" "db" {
  length           = 24
  special          = true
  override_special = "!#%^*()-_=+"
}

# SecureString with the AWS managed key (aws/ssm): free, unlike Secrets Manager.
resource "aws_ssm_parameter" "db_password" {
  name  = "/${var.project}/db/password"
  type  = "SecureString"
  value = random_password.db.result
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier     = "${var.project}-db"
  engine         = "mysql"
  engine_version = "8.0"
  instance_class = var.db_instance_class

  allocated_storage = 20 # Free Tier: 20 GB
  storage_type      = "gp2"
  storage_encrypted = true # AWS managed aws/rds key (free)

  db_name  = "shop"
  username = "shop_admin"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period = 1
  skip_final_snapshot     = true
  deletion_protection     = false
  apply_immediately       = true
}
