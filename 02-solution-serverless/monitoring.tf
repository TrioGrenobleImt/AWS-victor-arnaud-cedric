resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.notification_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.notification_email
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.project}-orders-dlq-not-empty"
  alarm_description   = "Orders failed processing 3 times and landed in the DLQ"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.orders_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = local.functions
  alarm_name          = "${var.project}-${each.key}-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.fn[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.project}-api-5xx"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.http.id, Stage = "$default" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = var.project
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title   = "Lambda invocations"
          region  = var.region
          stat    = "Sum"
          metrics = [for k, f in aws_lambda_function.fn : ["AWS/Lambda", "Invocations", "FunctionName", f.function_name]]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title   = "Lambda errors"
          region  = var.region
          stat    = "Sum"
          metrics = [for k, f in aws_lambda_function.fn : ["AWS/Lambda", "Errors", "FunctionName", f.function_name]]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title  = "Order queue"
          region = var.region
          stat   = "Sum"
          metrics = [
            ["AWS/SQS", "NumberOfMessagesSent", "QueueName", aws_sqs_queue.orders.name],
            [".", "ApproximateNumberOfMessagesVisible", "QueueName", aws_sqs_queue.orders_dlq.name],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "DynamoDB consumed capacity (orders)"
          region = var.region
          stat   = "Sum"
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", aws_dynamodb_table.orders.name],
            [".", "ConsumedWriteCapacityUnits", ".", "."],
          ]
        }
      },
    ]
  })
}
