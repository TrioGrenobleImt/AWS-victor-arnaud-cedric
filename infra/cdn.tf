# CloudFront is the single entry point: storefront, back office (/admin/) and
# product images from S3, /api/* and /admin/api/* proxied to the ALB (ECS), so
# the browser talks to one origin (no CORS) over HTTPS. The ALB only accepts
# CloudFront traffic (managed prefix list).
locals {
  cache_policy_optimized         = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  cache_policy_disabled          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
  origin_request_all_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.project}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Admin API: never cached, but the Authorization header (Cognito token) must
# reach the origin, which CloudFront only forwards when it is in the cache key.
resource "aws_cloudfront_cache_policy" "admin_api" {
  name        = "${var.project}-admin-api"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 1 # > 0 is required to add a header; responses are Cache-Control: no-store

  parameters_in_cache_key_and_forwarded_to_origin {
    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["Authorization"]
      }
    }
    query_strings_config {
      query_string_behavior = "all"
    }
    cookies_config {
      cookie_behavior = "none"
    }
  }
}

# S3 has no directory index: /admin and /admin/ (and the SPA's routes) serve
# admin/index.html. CloudFront Functions: 2M invocations/month always free.
resource "aws_cloudfront_function" "admin_index" {
  name    = "${var.project}-admin-index"
  runtime = "cloudfront-js-2.0"
  comment = "Serve the back office index.html"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      if (request.uri === "/admin" || request.uri === "/admin/" || request.uri.indexOf(".") === -1) {
        request.uri = "/admin/index.html";
      }
      return request;
    }
  EOT
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  comment             = "${var.project} storefront"
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # Europe + North America edge locations only

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id                = "images"
    domain_name              = aws_s3_bucket.images.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id   = "api"
    domain_name = aws_lb.api.dns_name

    # Plain HTTP to the ALB: TLS on the ALB needs a custom domain + ACM
    # certificate (see README alternatives). Viewers still use HTTPS.
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_policy_optimized
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern           = "/images/*"
    target_origin_id       = "images"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_policy_optimized
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern             = "/admin/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.admin_api.id
    origin_request_policy_id = local.origin_request_all_except_host
  }

  ordered_cache_behavior {
    path_pattern           = "/admin*"
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_policy_optimized
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.admin_index.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.cache_policy_disabled
    origin_request_policy_id = local.origin_request_all_except_host
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
