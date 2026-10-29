locals {
  catalog = { for p in jsondecode(file("${path.module}/../data/catalog.json")) : p.id => p }
}

# Provisioned capacity within the always-free 25 RCU / 25 WCU
# (products 5 + orders 5 + by_month 5 + by_customer 5 = 20).
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
    artist      = { S = each.value.artist }
    genre       = { S = each.value.genre }
    year        = { N = tostring(each.value.year) }
    description = { S = each.value.description }
    price       = { N = tostring(each.value.price) }
    stock       = { N = tostring(each.value.stock) }
    image       = { S = each.value.image } # key in the images bucket, served at /<image>
  })

  # catalog.json only seeds the table: the back office owns products afterwards
  # (stock, prices, new records), so later applies must not overwrite them.
  lifecycle {
    ignore_changes = [item]
  }
}

resource "aws_dynamodb_table" "orders" {
  name           = "${var.project}-orders"
  billing_mode   = "PROVISIONED"
  read_capacity  = var.dynamodb_capacity
  write_capacity = var.dynamodb_capacity
  hash_key       = "order_id"

  attribute {
    name = "order_id"
    type = "S"
  }

  attribute {
    name = "month"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  attribute {
    name = "customer_id"
    type = "S"
  }

  # Back office: orders of a month, newest first (order list + sales dashboard)
  # with a Query instead of a full-table Scan.
  global_secondary_index {
    name            = "by_month"
    hash_key        = "month"
    range_key       = "created_at"
    projection_type = "ALL"
    read_capacity   = var.dynamodb_capacity
    write_capacity  = var.dynamodb_capacity
  }

  # Storefront: "my orders" of a signed-in customer (Cognito sub), newest first.
  # Guest orders have no customer_id and are not indexed.
  global_secondary_index {
    name            = "by_customer"
    hash_key        = "customer_id"
    range_key       = "created_at"
    projection_type = "ALL"
    read_capacity   = var.dynamodb_capacity
    write_capacity  = var.dynamodb_capacity
  }

  point_in_time_recovery {
    enabled = false # billed per GB, enable for production
  }
}
