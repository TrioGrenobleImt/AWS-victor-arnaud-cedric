# Event-driven core: the web tier publishes ORDER_PLACED / ORDER_SHIPPED
# events on an SNS topic, which fans out to:
#   - an SQS queue consumed by the worker (packing + shipping simulation)
#   - an optional email subscription (customer / ops confirmation)
resource "aws_sns_topic" "orders" {
  name              = "${var.project}-order-events"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sqs_queue" "orders_dlq" {
  name                      = "${var.project}-order-processing-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "orders" {
  name                       = "${var.project}-order-processing"
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20 # long polling: fewer (billed) empty receives
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.orders_dlq.arn
    maxReceiveCount     = 3
  })
}

data "aws_iam_policy_document" "orders_queue" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.orders.arn]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.orders.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "orders" {
  queue_url = aws_sqs_queue.orders.id
  policy    = data.aws_iam_policy_document.orders_queue.json
}

# Only new orders go to the processing queue (SNS filter policy).
resource "aws_sns_topic_subscription" "orders_queue" {
  topic_arn            = aws_sns_topic.orders.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.orders.arn
  raw_message_delivery = true
  filter_policy        = jsonencode({ event_type = ["ORDER_PLACED"] })
}

resource "aws_sns_topic_subscription" "orders_email" {
  count     = var.notification_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.orders.arn
  protocol  = "email"
  endpoint  = var.notification_email
}
