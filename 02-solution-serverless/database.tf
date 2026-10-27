locals {
  catalog = { for p in jsondecode(file("${path.module}/../shared/catalog.json")) : p.id => p }
}

# Provisioned capacity within the always-free 25 RCU / 25 WCU.
resource "aws_dynamodb_table" "products" {
  name           = "${var.project}-products"
  billing_mode   = "PROVISIONED"
  read_capacity  = var.dynamodb_capacity
  write_capacity = var.dynamodb_capacity
  hash_key       = "id"

  attribute {
    name = "id"
    type = "S"
  }

  server_side_encryption {
    enabled = false # false = AWS owned key (free); true would use the billed aws/dynamodb KMS key
  }
}

resource "aws_dynamodb_table_item" "products" {
  for_each   = local.catalog
  table_name = aws_dynamodb_table.products.name
  hash_key   = aws_dynamodb_table.products.hash_key

  item = jsonencode({
    id          = { S = each.value.id }
    name        = { S = each.value.name }
    description = { S = each.value.description }
    price       = { N = tostring(each.value.price) }
    stock       = { N = tostring(each.value.stock) }
  })
}

# Orders table with a DynamoDB Stream: every change is streamed to the audit
# Lambda (streaming pattern, free alternative to Kinesis / MSK).
resource "aws_dynamodb_table" "orders" {
  name             = "${var.project}-orders"
  billing_mode     = "PROVISIONED"
  read_capacity    = var.dynamodb_capacity
  write_capacity   = var.dynamodb_capacity
  hash_key         = "order_id"
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  attribute {
    name = "order_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false # billed per GB, enable for production
  }
}
