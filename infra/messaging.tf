# Event model: the APIs publish on SNS (ORDER_PLACED from the shop; ORDER_PACKED,
# ORDER_SHIPPED, ORDER_CANCELLED from the back office), which fans out to email
# subscribers and, for ORDER_PLACED only, to SQS -> order-processor Lambda.
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
  visibility_timeout_seconds = 90 # >= 6x the processor Lambda timeout
  receive_wait_time_seconds  = 20
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

# SNS topics use the AWS managed key: publishers need to use it through SNS.
data "aws_iam_policy_document" "sns_kms" {
  statement {
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["sns.${var.region}.amazonaws.com"]
    }
  }
}
