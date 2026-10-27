data "aws_caller_identity" "current" {}

# --- Static website (private bucket, served only through CloudFront) --------
resource "aws_s3_bucket" "web" {
  bucket        = "${var.project}-web-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.web.id
  key          = "index.html"
  source       = "${path.module}/../shared/frontend/index.html"
  etag         = filemd5("${path.module}/../shared/frontend/index.html")
  content_type = "text/html; charset=utf-8"
}

data "aws_iam_policy_document" "web" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket     = aws_s3_bucket.web.id
  policy     = data.aws_iam_policy_document.web.json
  depends_on = [aws_s3_bucket_public_access_block.web]
}

# --- Audit / reporting data lake (written by the stream Lambda) -------------
resource "aws_s3_bucket" "audit" {
  bucket        = "${var.project}-audit-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "archive-then-expire"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}
