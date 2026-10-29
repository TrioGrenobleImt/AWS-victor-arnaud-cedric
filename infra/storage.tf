locals {
  # Vite build output: run `npm ci && npm run build` in frontend/ before apply.
  frontend_dir   = "${path.module}/../frontend/dist"
  frontend_files = fileset(local.frontend_dir, "**")
  # Back office build, served by its own bucket + distribution.
  backoffice_dir   = "${path.module}/../backoffice/dist"
  backoffice_files = fileset(local.backoffice_dir, "**")
  image_dir        = "${path.module}/../images"
  image_files      = fileset(local.image_dir, "covers/**")

  content_types = {
    html  = "text/html; charset=utf-8"
    js    = "text/javascript"
    css   = "text/css"
    json  = "application/json"
    txt   = "text/plain"
    svg   = "image/svg+xml"
    png   = "image/png"
    jpg   = "image/jpeg"
    jpeg  = "image/jpeg"
    webp  = "image/webp"
    ico   = "image/x-icon"
    woff2 = "font/woff2"
  }
}

# --- Static website (private bucket, served only through CloudFront) --------
resource "aws_s3_bucket" "web" {
  bucket        = "${var.project}-web-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  lifecycle {
    precondition {
      condition     = contains(local.frontend_files, "index.html")
      error_message = "Frontend not built: run `npm ci && npm run build` in frontend/ first."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Hashed assets/* never change (cached for a year); index.html is revalidated
# on every request so a new deploy is visible immediately.
resource "aws_s3_object" "web" {
  for_each      = local.frontend_files
  bucket        = aws_s3_bucket.web.id
  key           = each.value
  source        = "${local.frontend_dir}/${each.value}"
  etag          = filemd5("${local.frontend_dir}/${each.value}")
  content_type  = lookup(local.content_types, lower(regex("[^.]+$", each.value)), "application/octet-stream")
  cache_control = startswith(each.value, "assets/") ? "public, max-age=31536000, immutable" : "no-cache"
}


# --- Back office site (private bucket, served only by its CloudFront) --------
resource "aws_s3_bucket" "backoffice" {
  bucket        = "${var.project}-backoffice-${data.aws_caller_identity.current.account_id}"
  force_destroy = true

  lifecycle {
    precondition {
      condition     = contains(local.backoffice_files, "index.html")
      error_message = "Back office not built: run `npm ci && npm run build` in backoffice/ first."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backoffice" {
  bucket                  = aws_s3_bucket.backoffice.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "backoffice" {
  for_each      = local.backoffice_files
  bucket        = aws_s3_bucket.backoffice.id
  key           = each.value
  source        = "${local.backoffice_dir}/${each.value}"
  etag          = filemd5("${local.backoffice_dir}/${each.value}")
  content_type  = lookup(local.content_types, lower(regex("[^.]+$", each.value)), "application/octet-stream")
  cache_control = startswith(each.value, "assets/") ? "public, max-age=31536000, immutable" : "no-cache"
}

# Runtime settings of the back office (Cognito hosted login).
resource "aws_s3_object" "backoffice_config" {
  bucket        = aws_s3_bucket.backoffice.id
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "no-cache"
  content = jsonencode({
    auth        = "cognito"
    domain      = "${aws_cognito_user_pool_domain.admin.domain}.auth.${var.region}.amazoncognito.com"
    clientId    = aws_cognito_user_pool_client.backoffice.id
    redirectUri = local.backoffice_url
  })
}

# Runtime settings of the storefront (customer sign-in page, Cognito API).
resource "aws_s3_object" "web_config" {
  bucket        = aws_s3_bucket.web.id
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "no-cache"
  content = jsonencode({
    auth     = "cognito"
    region   = var.region
    clientId = aws_cognito_user_pool_client.storefront.id
  })
}

# --- Product images (private bucket, served by CloudFront under /images/*) --
resource "aws_s3_bucket" "images" {
  bucket        = "${var.project}-images-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "images" {
  bucket                  = aws_s3_bucket.images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The back office uploads covers straight from the browser (presigned POST,
# images/uploads/*), so the bucket accepts cross-origin POSTs from its address.
resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id

  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = ["https://${aws_cloudfront_distribution.backoffice.domain_name}"]
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_object" "images" {
  for_each      = local.image_files
  bucket        = aws_s3_bucket.images.id
  key           = "images/${each.value}" # = the "image" field of catalog.json = the URL path
  source        = "${local.image_dir}/${each.value}"
  etag          = filemd5("${local.image_dir}/${each.value}")
  content_type  = lookup(local.content_types, lower(regex("[^.]+$", each.value)), "application/octet-stream")
  cache_control = "public, max-age=86400"
}

# Each site bucket is readable only by its own distribution, the images bucket
# by both (Origin Access Control).
locals {
  bucket_readers = {
    web        = { bucket = aws_s3_bucket.web, distributions = [aws_cloudfront_distribution.main.arn] }
    backoffice = { bucket = aws_s3_bucket.backoffice, distributions = [aws_cloudfront_distribution.backoffice.arn] }
    images     = { bucket = aws_s3_bucket.images, distributions = [aws_cloudfront_distribution.main.arn, aws_cloudfront_distribution.backoffice.arn] }
  }
}

data "aws_iam_policy_document" "cloudfront_read" {
  for_each = local.bucket_readers

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${each.value.bucket.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = each.value.distributions
    }
  }
}

resource "aws_s3_bucket_policy" "cloudfront_read" {
  for_each = local.bucket_readers
  bucket   = each.value.bucket.id
  policy   = data.aws_iam_policy_document.cloudfront_read[each.key].json

  depends_on = [aws_s3_bucket_public_access_block.web, aws_s3_bucket_public_access_block.backoffice, aws_s3_bucket_public_access_block.images]
}

# --- Internal documents: packing slips (written by the order-processor Lambda,
# opened by admins through short-lived presigned links) ----------------------
resource "aws_s3_bucket" "documents" {
  bucket        = "${var.project}-documents-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    id     = "expire-packing-slips"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}
