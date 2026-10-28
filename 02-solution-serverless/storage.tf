data "aws_caller_identity" "current" {}

locals {
  # Vite build output: run `npm ci && npm run build` in shared/frontend before apply.
  frontend_dir   = "${path.module}/../shared/frontend/dist"
  frontend_files = fileset(local.frontend_dir, "**")
  image_dir      = "${path.module}/../shared/images"
  image_files    = fileset(local.image_dir, "covers/**")

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
      error_message = "Frontend not built: run `npm ci && npm run build` in shared/frontend first."
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

# Earlier releases managed index.html as a single object: keep it instead of
# destroying + recreating the same key (which could delete the new upload).
moved {
  from = aws_s3_object.index
  to   = aws_s3_object.web["index.html"]
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

resource "aws_s3_object" "images" {
  for_each      = local.image_files
  bucket        = aws_s3_bucket.images.id
  key           = "images/${each.value}" # = the "image" field of catalog.json = the URL path
  source        = "${local.image_dir}/${each.value}"
  etag          = filemd5("${local.image_dir}/${each.value}")
  content_type  = lookup(local.content_types, lower(regex("[^.]+$", each.value)), "application/octet-stream")
  cache_control = "public, max-age=86400"
}

# Both buckets are readable only by this CloudFront distribution (OAC).
data "aws_iam_policy_document" "cloudfront_read" {
  for_each = { web = aws_s3_bucket.web.arn, images = aws_s3_bucket.images.arn }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${each.value}/*"]
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
  policy     = data.aws_iam_policy_document.cloudfront_read["web"].json
  depends_on = [aws_s3_bucket_public_access_block.web]
}

resource "aws_s3_bucket_policy" "images" {
  bucket     = aws_s3_bucket.images.id
  policy     = data.aws_iam_policy_document.cloudfront_read["images"].json
  depends_on = [aws_s3_bucket_public_access_block.images]
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
