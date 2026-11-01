# Event model: the APIs publish on SNS (ORDER_PLACED from the shop; ORDER_PACKED,
# ORDER_SHIPPED, ORDER_CANCELLED from the back office), which fans out to the
# shop owner's email subscription, to SQS -> customer-notifier Lambda (all four
# events, emailed to the customer through SES) and, for ORDER_PLACED only, to
# SQS -> order-processor Lambda.
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

# --- Customer emails (SES) ---------------------------------------------------
resource "aws_sesv2_email_identity" "sender" {
  count          = local.notify_customers ? 1 : 0
  email_identity = var.sender_email # SES sends a verification link to this address
}

resource "aws_sqs_queue" "customer_emails_dlq" {
  count                     = local.notify_customers ? 1 : 0
  name                      = "${var.project}-customer-emails-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "customer_emails" {
  count                      = local.notify_customers ? 1 : 0
  name                       = "${var.project}-customer-emails"
  visibility_timeout_seconds = 90 # >= 6x the notifier Lambda timeout
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.customer_emails_dlq[0].arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue_policy" "customer_emails" {
  count     = local.notify_customers ? 1 : 0
  queue_url = aws_sqs_queue.customer_emails[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.customer_emails[0].arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.orders.arn } }
    }]
  })
}

resource "aws_sns_topic_subscription" "customer_emails" {
  count                = local.notify_customers ? 1 : 0
  topic_arn            = aws_sns_topic.orders.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.customer_emails[0].arn
  raw_message_delivery = true
  filter_policy        = jsonencode({ event_type = ["ORDER_PLACED", "ORDER_PACKED", "ORDER_SHIPPED", "ORDER_CANCELLED"] })
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
