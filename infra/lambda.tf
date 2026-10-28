# --- Lambda functions (Node.js, same lib/ as the ECS API) --------------------
# Event-driven work runs on Lambda: triggered by SQS / DynamoDB Streams, no
# idle cost. Each zip holds the function, backend/lib/ and a package.json
# marking the code as ES modules; the AWS SDK v3 comes with the runtime.
locals {
  functions = {
    order-processor = {
      description = "SQS consumer: packing + shipping simulation"
      timeout     = 30
      environment = {
        ORDERS_TABLE = aws_dynamodb_table.orders.name
        TOPIC_ARN    = aws_sns_topic.orders.arn
      }
    }
    audit-stream = {
      description = "DynamoDB Stream consumer: writes every order change to the S3 audit bucket"
      timeout     = 30
      environment = {
        AUDIT_BUCKET = aws_s3_bucket.audit.id
      }
    }
  }

  lib_files = fileset(local.backend_dir, "lib/*.js")
}

data "archive_file" "lambda" {
  for_each    = local.functions
  type        = "zip"
  output_path = "${path.module}/.build/${each.key}.zip"

  source {
    filename = "functions/${each.key}/index.js"
    content  = file("${local.backend_dir}/functions/${each.key}/index.js")
  }

  dynamic "source" {
    for_each = local.lib_files
    content {
      filename = source.value
      content  = file("${local.backend_dir}/${source.value}")
    }
  }

  source {
    filename = "package.json"
    content  = jsonencode({ type = "module" })
  }
}

# --- One least-privilege role per function ---------------------------------
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  for_each           = local.functions
  name               = "${var.project}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  for_each   = local.functions
  role       = aws_iam_role.lambda[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "lambda_xray" {
  for_each   = local.functions
  role       = aws_iam_role.lambda[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

data "aws_iam_policy_document" "order_processor" {
  source_policy_documents = [data.aws_iam_policy_document.sns_kms.json]

  statement {
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.orders.arn]
  }
  statement {
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.orders.arn]
  }
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.orders.arn]
  }
}

data "aws_iam_policy_document" "audit_stream" {
  statement {
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"]
    resources = [aws_dynamodb_table.orders.stream_arn]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/*"]
  }
}

locals {
  function_policies = {
    order-processor = data.aws_iam_policy_document.order_processor.json
    audit-stream    = data.aws_iam_policy_document.audit_stream.json
  }
}

resource "aws_iam_role_policy" "lambda" {
  for_each = local.functions
  name     = "permissions"
  role     = aws_iam_role.lambda[each.key].id
  policy   = local.function_policies[each.key]
}

# --- Functions ---------------------------------------------------------------
resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.project}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "fn" {
  for_each         = local.functions
  function_name    = "${var.project}-${each.key}"
  description      = each.value.description
  role             = aws_iam_role.lambda[each.key].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"] # Graviton: cheaper per GB-second
  handler          = "functions/${each.key}/index.handler"
  filename         = data.archive_file.lambda[each.key].output_path
  source_code_hash = data.archive_file.lambda[each.key].output_base64sha256
  memory_size      = 128
  timeout          = each.value.timeout

  environment {
    variables = each.value.environment
  }

  tracing_config {
    mode = "Active" # X-Ray: 100k traces/month free
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_iam_role_policy.lambda]
}

# SQS -> order-processor (partial batch failures go back to the queue / DLQ)
resource "aws_lambda_event_source_mapping" "orders_queue" {
  event_source_arn        = aws_sqs_queue.orders.arn
  function_name           = aws_lambda_function.fn["order-processor"].arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]
}

# DynamoDB Stream -> audit-stream
resource "aws_lambda_event_source_mapping" "orders_stream" {
  event_source_arn                   = aws_dynamodb_table.orders.stream_arn
  function_name                      = aws_lambda_function.fn["audit-stream"].arn
  starting_position                  = "LATEST"
  batch_size                         = 25
  maximum_batching_window_in_seconds = 5
  maximum_retry_attempts             = 3
  bisect_batch_on_function_error     = true
}
